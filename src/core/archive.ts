import { ArchivePolicy, TestRun } from './types.js';

/**
 * Pure helpers for the archive (cold storage) feature. Keeping the decision and
 * bundle-shaping logic here makes it unit-testable without touching the file
 * system; the Store owns the IO and the git commit.
 */

/** Newest first: by `executedAt`, then by id (ids are monotonic per project). */
export function compareRunsDesc(a: TestRun, b: TestRun): number {
  const byTime = b.executedAt.localeCompare(a.executedAt);
  if (byTime !== 0) return byTime;
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

/** Bundle file name for a run: `2025-09.jsonl` (month) or `2025-W37.jsonl` (week). */
export function bundleName(executedAt: string, bundle: ArchivePolicy['bundle'] = 'month'): string {
  const date = new Date(executedAt);
  const iso = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = iso.getUTCFullYear();
  if (bundle === 'month') {
    return `${year}-${String(iso.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
  }
  return `${year}-W${String(isoWeek(iso)).padStart(2, '0')}.jsonl`;
}

/** ISO-8601 week number (UTC). */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export interface ArchiveSelectionOptions {
  /** Archive runs executed strictly before this ISO timestamp. */
  before?: string;
  /** Keep the newest N runs hot regardless of age. */
  keep?: number;
}

/**
 * Pick the runs that may leave the hot directory.
 *
 * Two rules, both from the design doc (§13.4):
 *  1. single-record: `executedAt < cutoff` OR `rank >= keep`;
 *  2. batch anchoring: a batch is archived atomically, anchored on its NEWEST
 *     run — if that run must stay hot, the whole batch stays hot.
 *
 * `runs` may be in any order; the returned array is sorted oldest-first so the
 * caller writes deterministic bundles.
 */
export function selectArchivable(
  runs: TestRun[],
  policy: ArchivePolicy,
  now: Date = new Date(),
  opts: ArchiveSelectionOptions = {},
): TestRun[] {
  if (!runs.length) return [];
  const cutoff = opts.before ?? new Date(now.getTime() - policy.hotDays * 86400000).toISOString();
  const keep = Math.max(0, opts.keep ?? policy.hotMax);
  const ordered = runs.slice().sort(compareRunsDesc);

  const eligibleById = new Map<string, boolean>();
  ordered.forEach((run, index) => {
    eligibleById.set(run.id, run.executedAt < cutoff || index >= keep);
  });

  // A batch is anchored on its newest run (which sorts first for that batch).
  const newestOfBatch = new Map<string, TestRun>();
  for (const run of ordered) {
    if (run.batch && !newestOfBatch.has(run.batch)) newestOfBatch.set(run.batch, run);
  }
  const batchArchivable = new Map<string, boolean>();
  for (const [batch, newest] of newestOfBatch) {
    batchArchivable.set(batch, eligibleById.get(newest.id) === true);
  }

  return ordered
    .filter((run) => {
      if (!eligibleById.get(run.id)) return false;
      if (run.batch) return batchArchivable.get(run.batch) === true;
      return true;
    })
    .reverse(); // oldest first
}

/** Serialize runs as JSON Lines, sorted oldest-first, one compact object per line. */
export function serializeRuns(runs: TestRun[]): string {
  return runs
    .slice()
    .sort((a, b) => -compareRunsDesc(a, b))
    .map((run) => JSON.stringify(run))
    .join('\n');
}

export interface ParsedBundle {
  runs: TestRun[];
  /** Ids that appeared more than once (should not happen; reported for tests). */
  duplicates: string[];
}

/** Parse a bundle, skipping unparsable lines rather than failing the query. */
export function parseBundle(raw: string): ParsedBundle {
  const runs: TestRun[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as TestRun;
      if (seen.has(run.id)) duplicates.push(run.id);
      seen.add(run.id);
      runs.push(run);
    } catch {
      // A corrupt line must never break queries.
    }
  }
  return { runs, duplicates };
}

/**
 * Merge new runs into an existing bundle: dedupe by run id, sort deterministically
 * (`executedAt`, then id) and emit JSON Lines. Idempotent, so a crashed archive can
 * simply be re-run.
 */
export function mergeBundle(existingRaw: string | null, incoming: TestRun[]): string {
  const byId = new Map<string, TestRun>();
  if (existingRaw) {
    for (const run of parseBundle(existingRaw).runs) byId.set(run.id, run);
  }
  for (const run of incoming) byId.set(run.id, run);
  const merged = [...byId.values()].sort((a, b) => {
    const byTime = a.executedAt.localeCompare(b.executedAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  return merged.map((run) => JSON.stringify(run)).join('\n') + '\n';
}

/** Bundle statistics for status displays and the optional archive index. */
export function summarizeBundle(raw: string): { runs: number; cases: number; from: string | null; to: string | null } {
  const parsed = parseBundle(raw);
  const cases = new Set(parsed.runs.map((r) => r.caseId));
  const times = parsed.runs.map((r) => r.executedAt).sort();
  return { runs: parsed.runs.length, cases: cases.size, from: times[0] ?? null, to: times[times.length - 1] ?? null };
}

/** Remove runs matching a predicate from a bundle; returns the new raw text. */
export function filterBundle(raw: string, predicate: (run: TestRun) => boolean): { raw: string; removed: number } {
  let removed = 0;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let run: TestRun;
    try {
      run = JSON.parse(line) as TestRun;
    } catch {
      kept.push(line); // never lose unparsable content
      continue;
    }
    if (predicate(run)) removed++;
    else kept.push(line);
  }
  return { raw: kept.length ? kept.join('\n') + '\n' : '', removed };
}

/** Human-readable skip reason for the auto trigger (used in results and logs). */
export function describeSkip(reason: string): string {
  return reason;
}
