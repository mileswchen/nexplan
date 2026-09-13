import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { bundleName, filterBundle, mergeBundle, parseBundle, selectArchivable, summarizeBundle } from '../src/core/archive.js';
import { ArchivePolicy, DEFAULT_ARCHIVE_POLICY, TestPolicy, TestRun } from '../src/core/types.js';

let dir: string;

/** Policy used by the store under test; `auto` stays off unless a test opts in. */
function policy(over: Partial<ArchivePolicy> = {}): TestPolicy {
  return {
    requirePassingOnComplete: false,
    allowForce: true,
    archive: {
      ...DEFAULT_ARCHIVE_POLICY,
      auto: false,
      hotDays: 30,
      hotMax: 3,
      hysteresisRatio: 0.5,
      minIntervalHours: 0,
      minRunsPerArchive: 1,
      budgetMs: 10_000,
      ...over,
    },
  };
}

function makeStore(testPolicy: TestPolicy): Store {
  return new Store({
    root: dir,
    agentName: 'agent',
    autoCommit: true,
    testPolicy: async () => testPolicy,
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

async function seed(store: Store, caseId: string, executions: Array<{ days: number; result?: 'pass' | 'fail'; batch?: string }>) {
  for (const e of executions) {
    await store.recordTestRun({
      caseId,
      result: e.result ?? 'pass',
      batch: e.batch,
      executedAt: daysAgo(e.days),
    });
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-archive-'));
  const store = makeStore(policy());
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('archive selection rules (pure)', () => {
  const run = (id: string, executedAt: string, batch = ''): TestRun => ({
    id,
    caseId: 'TC-1',
    caseTitle: 'case',
    workItem: null,
    result: 'pass',
    actual: '',
    evidence: '',
    environment: '',
    build: '',
    batch,
    durationMs: null,
    bugIds: [],
    executedBy: 'agent',
    executedAt,
    notes: [],
  });
  const p: ArchivePolicy = { ...DEFAULT_ARCHIVE_POLICY, hotDays: 30, hotMax: 3 };

  it('archives by age or by rank, keeping both caps', () => {
    const runs = [
      run('TR-1', daysAgo(60)),
      run('TR-2', daysAgo(40)),
      run('TR-3', daysAgo(10)),
      run('TR-4', daysAgo(9)),
      run('TR-5', daysAgo(8)),
    ];
    const selected = selectArchivable(runs, p).map((r) => r.id).sort();
    // TR-1/TR-2 are older than 30 days; the newest 3 (TR-3..TR-5) stay hot.
    expect(selected).toEqual(['TR-1', 'TR-2']);
  });

  it('keeps a batch together, anchored on its newest run', () => {
    const runs = [
      run('TR-1', daysAgo(60), 'old-batch'),
      run('TR-2', daysAgo(40), 'old-batch'),
      run('TR-3', daysAgo(20), 'active-batch'), // its own newest run is hot
      run('TR-4', daysAgo(5), 'active-batch'),
    ];
    expect(selectArchivable(runs, p).map((r) => r.id)).toEqual(['TR-1', 'TR-2']);

    // Once the whole batch is stale, it goes together.
    const stale = [
      run('TR-1', daysAgo(60), 'b'),
      run('TR-2', daysAgo(50), 'b'),
      run('TR-3', daysAgo(1)),
    ];
    expect(selectArchivable(stale, p).map((r) => r.id)).toEqual(['TR-1', 'TR-2']);
  });

  it('honours explicit before/keep overrides', () => {
    const runs = [run('TR-1', daysAgo(10)), run('TR-2', daysAgo(5)), run('TR-3', daysAgo(1))];
    expect(selectArchivable(runs, p, new Date(), { keep: 1 }).map((r) => r.id)).toEqual(['TR-1', 'TR-2']);
    expect(selectArchivable(runs, p, new Date(), { before: daysAgo(6) }).map((r) => r.id)).toEqual(['TR-1']);
  });

  it('names bundles by month or ISO week', () => {
    expect(bundleName('2025-09-13T10:00:00Z', 'month')).toBe('2025-09.jsonl');
    expect(bundleName('2025-09-13T10:00:00Z', 'week')).toBe('2025-W37.jsonl');
  });
});

describe('bundle shaping (pure)', () => {
  const mk = (id: string, executedAt: string): TestRun => ({
    id,
    caseId: 'TC-1',
    caseTitle: 'c',
    workItem: null,
    result: 'pass',
    actual: '',
    evidence: '',
    environment: '',
    build: '',
    batch: '',
    durationMs: null,
    bugIds: [],
    executedBy: 'agent',
    executedAt,
    notes: [],
  });

  it('merges idempotently and sorts deterministically', () => {
    const a = mk('TR-2', '2025-09-02T00:00:00Z');
    const b = mk('TR-1', '2025-09-01T00:00:00Z');
    const once = mergeBundle(null, [a, b]);
    expect(once.trim().split('\n')).toHaveLength(2);
    expect(once.indexOf('TR-1')).toBeLessThan(once.indexOf('TR-2')); // oldest first

    const twice = mergeBundle(once, [a, b]);
    expect(twice).toBe(once); // re-running is a no-op
    expect(parseBundle(twice).duplicates).toEqual([]);
  });

  it('summarises and filters bundles without losing unparsable lines', () => {
    const raw = mergeBundle(null, [mk('TR-1', '2025-09-01T00:00:00Z'), mk('TR-2', '2025-09-03T00:00:00Z')]);
    expect(summarizeBundle(raw)).toMatchObject({ runs: 2, cases: 1, from: '2025-09-01T00:00:00Z', to: '2025-09-03T00:00:00Z' });

    const withJunk = raw + 'not json\n';
    const filtered = filterBundle(withJunk, (r) => r.id === 'TR-1');
    expect(filtered.removed).toBe(1);
    expect(filtered.raw).toContain('TR-2');
    expect(filtered.raw).toContain('not json');
  });
});

describe('archiving through the store', () => {
  it('moves old runs into a monthly bundle, keeping the records intact', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 50 }, { days: 1 }]);

    expect((await store.listTestRuns({ includeArchived: false }))).toHaveLength(3);
    const result = await store.archiveRuns();
    expect(result.archived).toBe(2);
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0].file).toMatch(/^\d{4}-\d{2}\.jsonl$/);

    // Hot directory shrank; the bundle is plain JSON Lines (greppable).
    expect(await store.listTestRuns({ includeArchived: false })).toHaveLength(1);
    const bundlePath = path.join(dir, 'testruns', 'archive', result.bundles[0].file);
    const raw = await readFile(bundlePath, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
    expect(raw).toContain(`"caseId":"${tc.id}"`);

    // Merged queries still return everything, and the snapshot survives.
    expect(await store.listTestRuns()).toHaveLength(3);
    expect(await store.listTestRuns({ caseId: tc.id })).toHaveLength(3);
    const history = await store.testCaseHistory(tc.id, 10);
    expect(history.map((r) => r.id)).toEqual(['TR-3', 'TR-2', 'TR-1']);

    // Counters track the move.
    const counters = JSON.parse(await readFile(path.join(dir, '.counters.json'), 'utf8'));
    expect(counters.TR_ARCHIVED).toBe(2);
    expect(counters.oldestHotAt).toBeTruthy();

    // The bundle is written exactly once per archive operation (one commit).
    const status = await store.archiveStatus();
    expect(status.hotRuns).toBe(1);
    expect(status.archivedRuns).toBe(2);
    expect(status.bundles[0]).toMatchObject({ runs: 2, cases: 1 });
    expect(status.indexFresh).toBe(true);
  });

  it('is idempotent: a re-run (or a crash-and-retry) never duplicates records', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 55 }]);
    const first = await store.archiveRuns();
    expect(first.archived).toBe(2);

    // Simulate a crash that wrote the bundle but did not delete the hot files.
    const bundle = path.join(dir, 'testruns', 'archive', first.bundles[0].file);
    const raw = await readFile(bundle, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      const run = JSON.parse(line) as TestRun;
      await writeFile(path.join(dir, 'testruns', `${run.id}.json`), JSON.stringify(run, null, 2) + '\n');
    }
    const retry = await store.archiveRuns();
    expect(retry.archived).toBe(2);
    expect(parseBundle(await readFile(bundle, 'utf8')).duplicates).toEqual([]);
    expect(await store.listTestRuns()).toHaveLength(2); // no duplicates, no loss
  });

  it('dry-run reports the plan without touching a single file', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 1 }]);

    const plan = await store.archiveRuns({ dryRun: true });
    expect(plan.archived).toBe(1);
    expect(plan.dryRun).toBe(true);
    expect(await store.listTestRuns({ includeArchived: false })).toHaveLength(2);
    await expect(readFile(path.join(dir, 'testruns', 'archive', plan.bundles[0].file), 'utf8')).rejects.toThrow();
  });

  it('restores a bundle back into the hot directory', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 55 }, { days: 1 }]);
    const before = await store.testCaseHistory(tc.id, 10);
    const archived = await store.archiveRuns();
    const month = archived.bundles[0].file.replace(/\.jsonl$/, '');

    const restored = await store.restoreArchive(month);
    expect(restored.restored).toBe(2);
    expect(await store.listTestRuns({ includeArchived: false })).toHaveLength(3);
    expect(await store.testCaseHistory(tc.id, 10)).toEqual(before);
    expect((await store.archiveStatus()).bundles).toHaveLength(0);
    await expect(store.restoreArchive('1999-01')).rejects.toThrow(/not found/);
  });

  it('never reuses an id after the hot directory has been emptied by archiving', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 55 }]);
    await store.archiveRuns();
    expect(await store.listTestRuns({ includeArchived: false })).toHaveLength(0);

    const later = await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    expect(later.run.id).toBe('TR-3'); // scanning for max+1 would have produced TR-1
    expect(await store.listTestRuns()).toHaveLength(3);
  });

  it('removes a deleted case and its archived runs when forced', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Doomed', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 55 }]);
    await store.archiveRuns();

    await expect(store.deleteTestCase(tc.id)).rejects.toThrow(/execution record/);
    const deleted = await store.deleteTestCase(tc.id, { force: true });
    expect(deleted.deletedRuns).toBe(2);
    expect(await store.listTestRuns()).toHaveLength(0);
  });

  it('reports archived runs by default and can exclude them', async () => {
    const store = makeStore(policy());
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    // Unbatched runs on purpose: a shared, still-active batch would be anchored
    // to its newest run and stay hot (see the batch-anchoring test above).
    await store.recordTestRun({ caseId: tc.id, result: 'fail', executedAt: daysAgo(60), createBugOnFailure: false });
    await store.recordTestRun({ caseId: tc.id, result: 'pass', executedAt: daysAgo(1) });
    expect((await store.archiveRuns()).archived).toBe(1);

    const merged = await store.testReport({});
    expect(merged.totals).toMatchObject({ runs: 2, pass: 1, fail: 1 });
    expect(merged.passRate).toBe(50);
    expect(merged.flaky.map((f) => f.caseId)).toEqual([tc.id]);

    const hot = await store.testReport({ includeArchived: false });
    expect(hot.totals.runs).toBe(1);
    expect(hot.totals.fail).toBe(0);
  });
});

describe('the automatic trigger', () => {
  it('stays inert until a gate opens, then archives after a write', async () => {
    const store = makeStore(policy({ auto: true, hotMax: 2, hysteresisRatio: 0.5, hotDays: 1000 }));
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });

    // First runs: hot count is below hotMax * 1.5 = 3, and nothing is old.
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    expect((await store.archiveStatus()).archivedRuns).toBe(0);

    // Third run crosses the high-water mark: the write triggers an archive.
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    const status = await store.archiveStatus();
    expect(status.archivedRuns).toBeGreaterThan(0);
    expect(status.lastArchiveAt).toBeTruthy();
    expect(await store.listTestRuns()).toHaveLength(3); // nothing lost
  });

  it('returns without evaluating while no gate is open', async () => {
    const store = makeStore(policy({ auto: true, hotDays: 90, hotMax: 5000 }));
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });

    expect(await store.archiveIfNeeded()).toBeNull();
    // `lastEvalAt` is only written on entering the evaluation phase (which is the
    // only thing that scans the hot directory), so null proves the O(1) gate
    // short-circuited before any IO.
    const status = await store.archiveStatus();
    expect(status.lastEvalAt).toBeNull();
    expect(status.bundles).toHaveLength(0);
  });

  it('opens the time gate by itself once runs fall out of the hot window', async () => {
    const store = makeStore(policy({ auto: true, hotDays: 30, hotMax: 5000 }));
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    // Recording a 60-day-old run already satisfies the time gate, so the write
    // itself archives it (no manual command, no cron).
    await seed(store, tc.id, [{ days: 60 }]);

    const status = await store.archiveStatus();
    expect(status.archivedRuns).toBe(1);
    expect(status.lastEvalAt).toBeTruthy();
    expect(status.lastArchiveAt).toBeTruthy();
    expect(await store.listTestRuns()).toHaveLength(1);
  });

  it('skips when fewer runs qualify than minRunsPerArchive', async () => {
    const store = makeStore(policy({ auto: true, minRunsPerArchive: 10, hotDays: 30 }));
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }, { days: 50 }]);
    const result = await store.archiveIfNeeded();
    expect(result).toMatchObject({ archived: 0, skipped: 'below minRunsPerArchive' });
    expect((await store.archiveStatus()).bundles).toHaveLength(0);
  });

  it('does nothing at all when auto is disabled', async () => {
    const store = makeStore(policy({ auto: false }));
    const tc = await store.createTestCase({ title: 'Case', status: 'active' });
    await seed(store, tc.id, [{ days: 60 }]);
    expect(await store.archiveIfNeeded()).toBeNull();
    expect((await store.archiveStatus()).bundles).toHaveLength(0);
  });
});
