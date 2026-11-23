import {
  Plan,
  PlanSummary,
  PlanTask,
  PlanView,
  WI_STATUS_PROGRESS,
  WorkItemStatus,
} from './types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar date in `YYYY-MM-DD` (2026-02-30 is not a date). */
export function isValidPlanDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Inclusive day count between two ISO dates (a milestone spans 1 day). */
export function daySpan(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY_MS) + 1;
}

const clamp = (p: number) => Math.max(0, Math.min(100, Math.round(p)));

/**
 * The task's effective progress.
 *
 * - `manual`: the stored `progress`, except `status: 'done'` always reads 100.
 * - `workitems`: the mean of the linked work items' mapped statuses
 *   (`WI_STATUS_PROGRESS`); a missing WI (or no links at all) counts as 0.
 */
export function effectiveProgress(
  task: PlanTask,
  workItemStatus: (id: string) => WorkItemStatus | undefined,
): number {
  if (task.status === 'done') return 100;
  if (task.progressSource === 'workitems') {
    if (!task.workItems.length) return 0;
    let sum = 0;
    for (const id of task.workItems) {
      const status = workItemStatus(id);
      sum += status ? WI_STATUS_PROGRESS[status] : 0; // missing WI counts as 0
    }
    return clamp(sum / task.workItems.length);
  }
  return clamp(task.progress);
}

/**
 * The first dependency cycle found, rendered as `T1 → T2 → T1`, or null when
 * the FS dependency graph is acyclic.
 */
export function findDependencyCycle(tasks: PlanTask[]): string | null {
  const known = new Set(tasks.map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = settled
  const stack: string[] = [];
  const visit = (id: string): string | null => {
    const mark = state.get(id);
    if (mark === 1) return [...stack.slice(stack.indexOf(id)), id].join(' → ');
    if (mark === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (known.has(dep.id)) {
        const found = visit(dep.id);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}

/** True when the FS dependency graph contains a cycle. */
export function hasDependencyCycle(tasks: PlanTask[]): boolean {
  return findDependencyCycle(tasks) !== null;
}

/**
 * Full-plan validation shared by MCP, REST and CLI writes. Hard errors (bad
 * dates, end < start, milestone constraints, unknown/self deps, cycles,
 * out-of-range progress) throw so nothing is written; soft findings — FS
 * scheduling conflicts — never block a write and come back as warnings.
 */
export function validatePlan(plan: Plan): string[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const task of plan.tasks) {
    if (!isValidPlanDate(task.start)) {
      throw new Error(`task ${task.id}: start must be a YYYY-MM-DD date (got "${task.start}")`);
    }
    if (!isValidPlanDate(task.end)) {
      throw new Error(`task ${task.id}: end must be a YYYY-MM-DD date (got "${task.end}")`);
    }
    if (task.end < task.start) {
      throw new Error(`task ${task.id}: end (${task.end}) is before start (${task.start})`);
    }
    if (task.milestone && task.start !== task.end) {
      throw new Error(`task ${task.id}: a milestone must have start === end`);
    }
    if (typeof task.progress !== 'number' || !Number.isFinite(task.progress) || task.progress < 0 || task.progress > 100) {
      throw new Error(`task ${task.id}: progress must be a number in [0, 100] (got ${task.progress})`);
    }
    if (task.progressSource !== 'manual' && task.progressSource !== 'workitems') {
      throw new Error(`task ${task.id}: progressSource must be "manual" or "workitems" (got "${task.progressSource}")`);
    }
    for (const dep of task.deps) {
      if (dep.id === task.id) throw new Error(`task ${task.id}: cannot depend on itself`);
      if (!byId.has(dep.id)) throw new Error(`task ${task.id}: unknown dependency "${dep.id}"`);
    }
  }
  const cycle = findDependencyCycle(plan.tasks);
  if (cycle) throw new Error(`dependency cycle detected: ${cycle}`);

  // FS conflicts are advisory only: a predecessor finishing after its successor
  // starts is a scheduling smell, not a hard error.
  const warnings: string[] = [];
  for (const task of plan.tasks) {
    for (const dep of task.deps) {
      const pred = byId.get(dep.id)!;
      if (pred.end > task.start) {
        warnings.push(`FS conflict: ${dep.id} ends ${pred.end} after ${task.id} starts ${task.start}`);
      }
    }
  }
  return warnings;
}

/** Derived plan rollups: span (min start / max end) and duration-weighted progress. */
export function summarizePlan(
  plan: Plan,
  workItemStatus: (id: string) => WorkItemStatus | undefined,
): PlanSummary {
  if (!plan.tasks.length) return { start: null, end: null, progress: 0 };
  let start = plan.tasks[0].start;
  let end = plan.tasks[0].end;
  let weighted = 0;
  let days = 0;
  for (const task of plan.tasks) {
    if (task.start < start) start = task.start;
    if (task.end > end) end = task.end;
    const span = daySpan(task.start, task.end);
    weighted += effectiveProgress(task, workItemStatus) * span;
    days += span;
  }
  return { start, end, progress: days > 0 ? Math.round(weighted / days) : 0 };
}

/**
 * The read-model shared by MCP (`plan_get`/`plan_list`), REST and the Gantt
 * view: per-task effective progress, derived span and validation warnings.
 * A plan on disk can only come from validated writes, but hand-edited files
 * are surfaced as warnings instead of blowing up every read.
 */
export function decoratePlan(
  plan: Plan,
  workItemStatus: (id: string) => WorkItemStatus | undefined,
): PlanView {
  let warnings: string[];
  try {
    warnings = validatePlan(plan);
  } catch (err) {
    warnings = [`invalid plan: ${(err as Error).message}`];
  }
  return {
    ...plan,
    tasks: plan.tasks.map((t) => ({ ...t, effectiveProgress: effectiveProgress(t, workItemStatus) })),
    summary: summarizePlan(plan, workItemStatus),
    warnings,
  };
}
