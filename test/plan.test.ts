import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import {
  daySpan,
  effectiveProgress,
  findDependencyCycle,
  hasDependencyCycle,
  isValidPlanDate,
  summarizePlan,
  validatePlan,
} from '../src/core/plan.js';
import { Plan, PlanTask, WorkItemStatus } from '../src/core/types.js';

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-plan-'));
  store = new Store({ root: dir, agentName: 'plan-agent', autoCommit: true });
  await store.init();
});

afterEach(async () => {
  // Retries cover the ENOTEMPTY race when a git child process is still
  // finishing a write inside .git/ while the temp dir is being removed.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function task(over: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 'T1',
    title: 'Task',
    start: '2026-11-24',
    end: '2026-11-26',
    progressSource: 'manual',
    progress: 0,
    status: 'todo',
    deps: [],
    assignee: null,
    milestone: false,
    workItems: [],
    note: '',
    ...over,
  };
}

function plan(tasks: PlanTask[]): Plan {
  return {
    id: 'PLAN-1',
    title: 'P1 执行计划',
    status: 'active',
    createdBy: 'test',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    tasks,
  };
}

describe('plan date helpers', () => {
  it('accepts real YYYY-MM-DD dates and rejects the rest', () => {
    expect(isValidPlanDate('2026-11-24')).toBe(true);
    expect(isValidPlanDate('2024-02-29')).toBe(true); // leap day
    expect(isValidPlanDate('2026-2-4')).toBe(false); // not zero-padded
    expect(isValidPlanDate('2026-02-30')).toBe(false); // not a real date
    expect(isValidPlanDate('2026/11/24')).toBe(false);
    expect(isValidPlanDate('')).toBe(false);
    expect(isValidPlanDate(42)).toBe(false);
  });

  it('counts days inclusively (a milestone spans 1 day)', () => {
    expect(daySpan('2026-11-24', '2026-11-26')).toBe(3);
    expect(daySpan('2026-11-24', '2026-11-24')).toBe(1);
  });
});

describe('validatePlan (hard errors throw, FS conflicts stay soft)', () => {
  it('accepts a valid plan and returns no warnings', () => {
    const p = plan([
      task({ id: 'T1', start: '2026-11-24', end: '2026-11-26' }),
      task({ id: 'T2', start: '2026-11-27', end: '2026-11-28', deps: [{ id: 'T1' }] }),
    ]);
    expect(validatePlan(p)).toEqual([]);
  });

  it('rejects malformed dates', () => {
    expect(() => validatePlan(plan([task({ start: '2026-11-4' })]))).toThrow(/YYYY-MM-DD/);
    expect(() => validatePlan(plan([task({ end: 'not-a-date' })]))).toThrow(/YYYY-MM-DD/);
    expect(() => validatePlan(plan([task({ start: '2026-02-30' })]))).toThrow(/YYYY-MM-DD/); // not a real date
  });

  it('rejects end before start', () => {
    expect(() => validatePlan(plan([task({ start: '2026-11-26', end: '2026-11-24' })]))).toThrow(
      /end \(2026-11-24\) is before start/,
    );
  });

  it('rejects a milestone spanning more than one day', () => {
    expect(() => validatePlan(plan([task({ milestone: true, start: '2026-11-24', end: '2026-11-26' })]))).toThrow(
      /milestone must have start === end/,
    );
  });

  it('rejects unknown and self dependencies', () => {
    expect(() => validatePlan(plan([task({ deps: [{ id: 'T9' }] })]))).toThrow(/unknown dependency "T9"/);
    expect(() => validatePlan(plan([task({ deps: [{ id: 'T1' }] })]))).toThrow(/cannot depend on itself/);
  });

  it('rejects dependency cycles and names them', () => {
    const p = plan([
      task({ id: 'T1', deps: [{ id: 'T2' }] }),
      task({ id: 'T2', deps: [{ id: 'T1' }] }),
    ]);
    expect(() => validatePlan(p)).toThrow(/dependency cycle detected: T1 → T2 → T1/);
  });

  it('rejects out-of-range progress and unknown progress sources', () => {
    expect(() => validatePlan(plan([task({ progress: 101 })]))).toThrow(/progress must be/);
    expect(() => validatePlan(plan([task({ progress: -1 })]))).toThrow(/progress must be/);
    expect(() => validatePlan(plan([task({ progressSource: 'auto' as never })]))).toThrow(/progressSource must be/);
  });

  it('reports FS conflicts as warnings without blocking', () => {
    const p = plan([
      task({ id: 'T1', start: '2026-11-24', end: '2026-11-28' }),
      task({ id: 'T2', start: '2026-11-26', end: '2026-11-27', deps: [{ id: 'T1' }] }),
    ]);
    expect(validatePlan(p)).toEqual(['FS conflict: T1 ends 2026-11-28 after T2 starts 2026-11-26']);
  });
});

describe('dependency graph', () => {
  it('accepts chains and diamonds, rejects cycles', () => {
    const chain = [task({ id: 'T1' }), task({ id: 'T2', deps: [{ id: 'T1' }] }), task({ id: 'T3', deps: [{ id: 'T2' }] })];
    expect(hasDependencyCycle(chain)).toBe(false);
    const diamond = [
      task({ id: 'T1' }),
      task({ id: 'T2', deps: [{ id: 'T1' }] }),
      task({ id: 'T3', deps: [{ id: 'T1' }] }),
      task({ id: 'T4', deps: [{ id: 'T2' }, { id: 'T3' }] }),
    ];
    expect(hasDependencyCycle(diamond)).toBe(false);
    const cycle = [
      task({ id: 'T1', deps: [{ id: 'T3' }] }),
      task({ id: 'T2', deps: [{ id: 'T1' }] }),
      task({ id: 'T3', deps: [{ id: 'T2' }] }),
    ];
    expect(findDependencyCycle(cycle)).toMatch(/T\d → T\d → T\d → T\d/);
  });
});

describe('effectiveProgress (dual progress source)', () => {
  const statuses: Record<string, WorkItemStatus> = {
    'WI-1': 'todo',
    'WI-2': 'in_progress',
    'WI-3': 'review',
    'WI-4': 'done',
  };
  const statusOf = (id: string): WorkItemStatus | undefined => statuses[id];

  it('manual mode uses the stored progress; done always reads 100', () => {
    expect(effectiveProgress(task({ progress: 40 }), statusOf)).toBe(40);
    expect(effectiveProgress(task({ progress: 40, status: 'done' }), statusOf)).toBe(100);
    expect(effectiveProgress(task({ progress: 40, status: 'doing' }), statusOf)).toBe(40);
  });

  it('workitems mode maps a single WI status (todo=0/in_progress=50/review=80/done=100)', () => {
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-1'] }), statusOf)).toBe(0);
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-2'] }), statusOf)).toBe(50);
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-3'] }), statusOf)).toBe(80);
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-4'] }), statusOf)).toBe(100);
  });

  it('workitems mode averages multiple WIs and treats missing/absent links as 0', () => {
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-2', 'WI-4'] }), statusOf)).toBe(75);
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: ['WI-404'] }), statusOf)).toBe(0);
    expect(effectiveProgress(task({ progressSource: 'workitems', workItems: [] }), statusOf)).toBe(0);
    // stored manual progress is irrelevant in workitems mode
    expect(effectiveProgress(task({ progressSource: 'workitems', progress: 90, workItems: ['WI-1'] }), statusOf)).toBe(0);
  });
});

describe('summarizePlan (derived, never persisted)', () => {
  it('derives span and duration-weighted progress', () => {
    const p = plan([
      task({ id: 'T1', start: '2026-11-24', end: '2026-11-25', progress: 50 }), // 2 days
      task({ id: 'T2', start: '2026-11-26', end: '2026-11-28', progress: 100 }), // 3 days
    ]);
    expect(summarizePlan(p, () => 'todo')).toEqual({ start: '2026-11-24', end: '2026-11-28', progress: 80 });
  });

  it('returns nulls and 0 for an empty plan', () => {
    expect(summarizePlan(plan([]), () => 'todo')).toEqual({ start: null, end: null, progress: 0 });
  });

  it('treats a milestone as a one-day task and done tasks as 100', () => {
    const p = plan([
      task({ id: 'T1', start: '2026-11-24', end: '2026-11-26', progress: 0 }), // 3 days
      task({ id: 'T2', start: '2026-11-27', end: '2026-11-27', milestone: true, status: 'done' }), // 1 day @100
    ]);
    expect(summarizePlan(p, () => 'todo').progress).toBe(25);
  });
});

describe('store plan CRUD', () => {
  it('creates PLAN-N ids with attribution and lists them in numeric order', async () => {
    const a = await store.createPlan({ title: 'P1 执行计划', author: 'codex' });
    expect(a.id).toBe('PLAN-1');
    expect(a.status).toBe('draft');
    expect(a.createdBy).toBe('codex');
    expect(a.tasks).toEqual([]);
    const b = await store.createPlan({ title: 'Another' });
    expect(b.id).toBe('PLAN-2');
    expect((await store.listPlans()).map((p) => p.id)).toEqual(['PLAN-1', 'PLAN-2']);
    expect(await store.getPlan('PLAN-1')).not.toBeNull();
    expect(await store.getPlan('PLAN-99')).toBeNull();
  });

  it('updates plan meta and archives instead of deleting', async () => {
    const p = await store.createPlan({ title: 'Draft plan' });
    const updated = await store.updatePlan(p.id, { title: 'P1 执行计划', status: 'active' });
    expect(updated.title).toBe('P1 执行计划');
    expect(updated.status).toBe('active');
    const archived = await store.updatePlan(p.id, { status: 'archived' });
    expect(archived.status).toBe('archived');
    await expect(store.updatePlan('PLAN-404', { status: 'active' })).rejects.toThrow(/plan not found/);
  });

  it('adds tasks with local T-N ids and validates the whole plan', async () => {
    const p = await store.createPlan({ title: 'P' });
    const t1 = await store.addPlanTask(p.id, { title: '地基', start: '2026-11-24', end: '2026-11-26' });
    expect(t1.tasks.map((t) => t.id)).toEqual(['T1']);
    const t2 = await store.addPlanTask(p.id, {
      title: '主体',
      start: '2026-11-27',
      end: '2026-11-30',
      deps: [{ id: 'T1' }],
      progress: 20,
    });
    expect(t2.tasks.at(-1)?.id).toBe('T2');
    expect(t2.tasks.at(-1)?.progressSource).toBe('manual');

    // Invalid task → hard error, plan unchanged on disk.
    await expect(
      store.addPlanTask(p.id, { title: '倒挂', start: '2026-12-05', end: '2026-12-01' }),
    ).rejects.toThrow(/is before start/);
    await expect(
      store.addPlanTask(p.id, { title: '坏依赖', start: '2026-12-01', end: '2026-12-02', deps: [{ id: 'T99' }] }),
    ).rejects.toThrow(/unknown dependency/);
    const onDisk = await store.getPlan(p.id);
    expect(onDisk?.tasks.map((t) => t.title)).toEqual(['地基', '主体']);
  });

  it('refuses updates that would close a dependency cycle', async () => {
    const p = await store.createPlan({ title: 'P' });
    await store.addPlanTask(p.id, { title: 'A', start: '2026-11-24', end: '2026-11-25' });
    await store.addPlanTask(p.id, { title: 'B', start: '2026-11-26', end: '2026-11-27', deps: [{ id: 'T1' }] });
    await store.addPlanTask(p.id, { title: 'C', start: '2026-11-28', end: '2026-11-29', deps: [{ id: 'T2' }] });
    await expect(store.updatePlanTask(p.id, 'T1', { deps: [{ id: 'T3' }] })).rejects.toThrow(/cycle/);
    // A legitimate edit still works after a refused one.
    const ok = await store.updatePlanTask(p.id, 'T1', { progress: 60, status: 'doing' });
    expect(ok.tasks[0]).toMatchObject({ progress: 60, status: 'doing' });
  });

  it('refuses removing a depended-on task and lists the referrers', async () => {
    const p = await store.createPlan({ title: 'P' });
    await store.addPlanTask(p.id, { title: 'A', start: '2026-11-24', end: '2026-11-25' });
    await store.addPlanTask(p.id, { title: 'B', start: '2026-11-26', end: '2026-11-27', deps: [{ id: 'T1' }] });
    await store.addPlanTask(p.id, { title: 'C', start: '2026-11-26', end: '2026-11-27', deps: [{ id: 'T1' }] });
    await expect(store.removePlanTask(p.id, 'T1')).rejects.toThrow(/still a dependency of T2, T3/);
    const after = await store.removePlanTask(p.id, 'T2');
    expect(after.tasks.map((t) => t.id)).toEqual(['T1', 'T3']);
  });

  it('accepts milestone tasks only with start === end', async () => {
    const p = await store.createPlan({ title: 'P' });
    await expect(
      store.addPlanTask(p.id, { title: 'M', start: '2026-11-24', end: '2026-11-26', milestone: true }),
    ).rejects.toThrow(/milestone/);
    const ok = await store.addPlanTask(p.id, { title: 'M', start: '2026-11-24', end: '2026-11-24', milestone: true });
    expect(ok.tasks[0].milestone).toBe(true);
  });

  it('decorates views with effective progress, summary and warnings', async () => {
    // Work items drive one task's progress (workitems mode).
    const wi = await store.createWorkItem({ title: '桥接', status: 'in_progress', author: 'codex' });
    const p = await store.createPlan({ title: 'P', author: 'codex' });
    await store.addPlanTask(p.id, {
      title: '手工任务',
      start: '2026-11-24',
      end: '2026-11-25',
      progress: 30,
    });
    await store.addPlanTask(p.id, {
      title: '自动任务',
      start: '2026-11-24',
      end: '2026-11-27',
      progressSource: 'workitems',
      workItems: [wi.id],
    });
    const view = await store.getPlanView(p.id);
    expect(view?.tasks[0].effectiveProgress).toBe(30);
    expect(view?.tasks[1].effectiveProgress).toBe(50); // in_progress → 50
    expect(view?.summary).toEqual({ start: '2026-11-24', end: '2026-11-27', progress: 43 }); // (30*2+50*4)/6
    expect(view?.warnings).toEqual([]);
    // Advancing the linked WI moves the derived progress without touching the plan.
    await store.updateWorkItem(wi.id, { status: 'done' }, 'codex');
    const after = await store.getPlanView(p.id);
    expect(after?.tasks[1].effectiveProgress).toBe(100);
    expect(after?.summary.progress).toBe(77); // (30*2+100*4)/6

    // A conflicting FS edge is surfaced as a warning on read, never thrown.
    await store.addPlanTask(p.id, {
      title: '冲突任务',
      start: '2026-11-25',
      end: '2026-11-26',
      deps: [{ id: 'T2' }], // T2 ends 11-27, after this task starts
    });
    const warned = await store.getPlanView(p.id);
    expect(warned?.warnings).toEqual(['FS conflict: T2 ends 2026-11-27 after T3 starts 2026-11-25']);
    expect((await store.listPlanViews()).map((v) => v.id)).toContain(p.id);
  });
});
