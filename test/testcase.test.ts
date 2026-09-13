import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-test-'));
  store = new Store({ root: dir, agentName: 'test-agent', autoCommit: true });
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('test cases', () => {
  it('creates a case with steps and lists it with no last result', async () => {
    const tc = await store.createTestCase({
      title: 'Login: lock after 3 bad passwords',
      type: 'functional',
      priority: 'P1',
      status: 'active',
      preconditions: 'A registered account',
      steps: [{ action: 'Enter a wrong password 3 times', expected: 'Account locks for 15 minutes' }],
      workItem: 'WI-1',
      tags: ['auth'],
    });
    expect(tc.id).toBe('TC-1');
    expect(tc.steps).toHaveLength(1);

    const list = await store.listTestCases();
    expect(list).toHaveLength(1);
    expect(list[0].lastResult).toBeNull();
    expect(list[0].lastRunAt).toBeNull();
    expect(list[0].runCount).toBeNull(); // counts only computed on request
  });

  it('updates a case and applies filters', async () => {
    const a = await store.createTestCase({ title: 'A', workItem: 'WI-1', status: 'active', tags: ['api'] });
    await store.createTestCase({ title: 'B', status: 'draft' });
    const updated = await store.updateTestCase(a.id, { status: 'deprecated', priority: 'P0' });
    expect(updated.status).toBe('deprecated');
    expect(updated.priority).toBe('P0');

    expect(await store.listTestCases({ status: 'active' })).toHaveLength(0);
    expect(await store.listTestCases({ priority: 'P0' })).toHaveLength(1);
    expect(await store.listTestCases({ workItem: 'WI-1' })).toHaveLength(1);
    expect(await store.listTestCases({ query: 'B' })).toHaveLength(1);
    expect(await store.listTestCases({ lastResult: 'notRun' })).toHaveLength(2);
    await expect(store.updateTestCase('TC-999', { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('refuses to delete a case with runs unless forced', async () => {
    const tc = await store.createTestCase({ title: 'Guarded', status: 'active' });
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    await expect(store.deleteTestCase(tc.id)).rejects.toThrow(/execution record/);

    const res = await store.deleteTestCase(tc.id, { force: true });
    expect(res.deletedRuns).toBe(1);
    expect(await store.getTestCase(tc.id)).toBeNull();
    expect(await store.listTestRuns({ includeArchived: false })).toHaveLength(0);
    await expect(store.deleteTestCase(tc.id)).rejects.toThrow(/not found/);
  });
});

describe('id counters', () => {
  it('never reuses an id after the highest record is deleted', async () => {
    const a = await store.createWorkItem({ title: 'first' });
    const b = await store.createWorkItem({ title: 'second' });
    expect([a.id, b.id]).toEqual(['WI-1', 'WI-2']);
    await store.deleteWorkItem(b.id);
    const c = await store.createWorkItem({ title: 'third' });
    expect(c.id).toBe('WI-3'); // scanning for max+1 would have reused WI-2

    const tc = await store.createTestCase({ title: 'case' });
    expect(tc.id).toBe('TC-1');
    await store.deleteTestCase(tc.id);
    expect((await store.createTestCase({ title: 'case 2' })).id).toBe('TC-2');
  });

  it('persists counters and falls back to a directory scan when they are missing', async () => {
    await store.createTestCase({ title: 'persisted' });
    const raw = JSON.parse(await readFile(path.join(dir, '.counters.json'), 'utf8'));
    expect(raw.TC).toBe(1);

    // Simulate a workspace created before counters existed.
    await rm(path.join(dir, '.counters.json'), { force: true });
    const next = await store.createTestCase({ title: 'legacy' });
    expect(next.id).toBe('TC-2');
  });

  it('keeps TC, TR, WI and BUG sequences independent', async () => {
    await store.createTestCase({ title: 'c1' });
    await store.createTestCase({ title: 'c2' });
    await store.createWorkItem({ title: 'w1' });
    await store.createBug({ title: 'b1' });
    const tc = (await store.listTestCases())[0];
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    expect((await store.listTestRuns({ includeArchived: false }))[0].id).toBe('TR-1');
  });
});

describe('test runs', () => {
  it('records a run and freezes the case snapshot', async () => {
    const tc = await store.createTestCase({ title: 'Original title', status: 'active', workItem: 'WI-7' });
    const { run, createdBugs } = await store.recordTestRun({
      caseId: tc.id,
      result: 'pass',
      build: 'v0.4.0',
      environment: 'ci',
      durationMs: 812,
      author: 'claude-code',
    });
    expect(run.id).toBe('TR-1');
    expect(run.caseTitle).toBe('Original title');
    expect(run.workItem).toBe('WI-7');
    expect(run.executedBy).toBe('claude-code');
    expect(createdBugs).toHaveLength(0);

    await store.updateTestCase(tc.id, { title: 'Renamed later' });
    const history = await store.testCaseHistory(tc.id);
    expect(history[0].caseTitle).toBe('Original title'); // history is immutable
    const [decorated] = await store.listTestCases();
    expect(decorated.lastResult).toBe('pass');
    expect(decorated.lastBuild).toBe('v0.4.0');
  });

  it('files one bug per failing case, then advances it on pass and reopens on regression', async () => {
    const tc = await store.createTestCase({
      title: 'Order: out-of-stock message',
      status: 'active',
      priority: 'P1',
      tags: ['orders'],
      workItem: 'WI-1',
    });

    // 1st failure → new bug, severity mapped from case priority.
    const first = await store.recordTestRun({
      caseId: tc.id,
      result: 'fail',
      actual: 'returned 500',
      evidence: 'logs/order.log:42',
      build: 'v0.4.0',
      createBugOnFailure: true,
    });
    expect(first.createdBugs).toHaveLength(1);
    const bug = first.createdBugs[0];
    expect(bug.id).toBe('BUG-1');
    expect(bug.severity).toBe('major');
    expect(bug.testCase).toBe(tc.id);
    expect(bug.testRun).toBe(first.run.id);
    expect(bug.workItem).toBe('WI-1');
    expect(bug.tags).toContain('from-test');
    expect(first.run.bugIds).toEqual([bug.id]);

    // 2nd failure → no duplicate bug, evidence appended instead.
    const second = await store.recordTestRun({ caseId: tc.id, result: 'fail', build: 'v0.4.1', createBugOnFailure: true });
    expect(second.createdBugs).toHaveLength(0);
    expect(second.updatedBugs.map((b) => b.id)).toEqual([bug.id]);
    expect(await store.listBugs()).toHaveLength(1);
    expect(second.updatedBugs[0].notes.at(-1)?.body).toContain('failed again');

    // Passing run → open bug becomes fixed.
    const pass = await store.recordTestRun({ caseId: tc.id, result: 'pass', build: 'v0.4.2' });
    expect(pass.updatedBugs.map((b) => b.status)).toEqual(['fixed']);

    // Regression → fixed bug reopens.
    const regression = await store.recordTestRun({ caseId: tc.id, result: 'fail', build: 'v0.4.3' });
    expect(regression.updatedBugs.map((b) => b.status)).toEqual(['reopened']);
    expect((await store.getBug(bug.id))?.closedAt).toBeNull();

    // Pass again → fixed, and with verifyBugs → verified.
    await store.recordTestRun({ caseId: tc.id, result: 'pass', build: 'v0.4.4' });
    const verified = await store.recordTestRun({ caseId: tc.id, result: 'pass', build: 'v0.4.5', verifyBugs: true });
    expect(verified.updatedBugs.map((b) => b.status)).toEqual(['verified']);
    expect((await store.getBug(bug.id))?.status).toBe('verified');
  });

  it('honours explicit bug links declared on the case', async () => {
    const bug = await store.createBug({ title: 'Manually reported', severity: 'critical' });
    const tc = await store.createTestCase({ title: 'Regression guard', status: 'active', bugs: [bug.id] });
    const { createdBugs, updatedBugs } = await store.recordTestRun({ caseId: tc.id, result: 'pass' });
    expect(createdBugs).toHaveLength(0);
    expect(updatedBugs.map((b) => b.id)).toEqual([bug.id]);
    expect((await store.getBug(bug.id))?.status).toBe('fixed');
  });

  it('never touches wontfix bugs', async () => {
    const bug = await store.createBug({ title: 'Known limitation', status: 'wontfix' });
    const tc = await store.createTestCase({ title: 'Case', status: 'active', bugs: [bug.id] });
    await store.recordTestRun({ caseId: tc.id, result: 'pass', verifyBugs: true });
    await store.recordTestRun({ caseId: tc.id, result: 'fail', createBugOnFailure: false });
    expect((await store.getBug(bug.id))?.status).toBe('wontfix');
  });

  it('auto-creates a case when only a title is given, and reuses it next time', async () => {
    const first = await store.recordTestRun({ caseTitle: 'Ad-hoc smoke check', result: 'pass' });
    expect(first.testCase.id).toBe('TC-1');
    expect(first.testCase.status).toBe('active');
    const second = await store.recordTestRun({ caseTitle: 'Ad-hoc smoke check', result: 'fail' });
    expect(second.testCase.id).toBe('TC-1');
    expect(await store.listTestCases()).toHaveLength(1);

    await expect(
      store.recordTestRun({ caseTitle: 'unknown', result: 'pass', autoCreateCase: false }),
    ).rejects.toThrow(/not found by title/);
    await expect(store.recordTestRun({ result: 'pass' })).rejects.toThrow(/requires caseId or caseTitle/);
  });

  it('filters runs and returns history newest first', async () => {
    const tc = await store.createTestCase({ title: 'Filtered', status: 'active' });
    await store.recordTestRun({ caseId: tc.id, result: 'pass', build: 'v1', batch: 'b1', environment: 'ci' });
    await store.recordTestRun({ caseId: tc.id, result: 'fail', build: 'v2', batch: 'b2', environment: 'local' });
    await store.recordTestRun({ caseId: tc.id, result: 'blocked', build: 'v2', batch: 'b1' });

    expect(await store.listTestRuns({ result: 'fail' })).toHaveLength(1);
    expect(await store.listTestRuns({ build: 'v2' })).toHaveLength(2);
    expect(await store.listTestRuns({ batch: 'b1' })).toHaveLength(2);
    expect(await store.listTestRuns({ environment: 'ci' })).toHaveLength(1);
    expect(await store.listTestRuns({ limit: 2 })).toHaveLength(2);

    const history = await store.testCaseHistory(tc.id);
    expect(history.map((r) => r.id)).toEqual(['TR-3', 'TR-2', 'TR-1']);
    expect(history[0].executedAt >= history[1].executedAt).toBe(true);
  });

  it('reports a batch with pass rate, not-run cases and flaky detection', async () => {
    const item = await store.createWorkItem({ title: 'Covered item' });
    await store.createWorkItem({ title: 'Uncovered item' });
    const tc1 = await store.createTestCase({ title: 'Flaky one', status: 'active', workItem: item.id });
    await store.createTestCase({ title: 'Never run', status: 'active' });
    await store.createTestCase({ title: 'Draft ignored', status: 'draft' });
    await store.recordTestRun({ caseId: tc1.id, result: 'pass', batch: 'regression', build: 'v1' });
    await store.recordTestRun({ caseId: tc1.id, result: 'fail', batch: 'regression', build: 'v2' });

    const report = await store.testReport({ batch: 'regression' });
    expect(report.totals.cases).toBe(2); // draft excluded
    expect(report.totals.runs).toBe(2);
    expect(report.totals).toMatchObject({ pass: 1, fail: 1, notRun: 1 });
    expect(report.passRate).toBe(50);
    expect(report.flaky.map((f) => f.caseId)).toEqual([tc1.id]);
    expect(report.failures.map((f) => f.caseId)).toEqual([tc1.id]);
    expect(report.notRunCases.map((c) => c.title)).toEqual(['Never run']);
    expect(report.coverage).toMatchObject({
      itemsTotal: 2,
      itemsWithCases: 1,
      itemsWithoutCasesTotal: 1,
    });
  });

  it('summarises work item verification and notes failing tests on completion', async () => {
    const item = await store.createWorkItem({ title: 'Ship orders' });
    const passing = await store.createTestCase({ title: 'passes', status: 'active', workItem: item.id });
    const failing = await store.createTestCase({ title: 'fails', status: 'active', workItem: item.id });
    await store.createTestCase({ title: 'never run', status: 'active', workItem: item.id });
    await store.recordTestRun({ caseId: passing.id, result: 'pass' });
    await store.recordTestRun({ caseId: failing.id, result: 'fail', createBugOnFailure: false });

    const verification = await store.verificationForWorkItem(item.id);
    expect(verification).toMatchObject({ cases: 3, pass: 1, fail: 1, notRun: 1 });
    expect(verification.failing).toEqual([failing.id]);

    const { verification: reported, item: done } = await store.completeWorkItem(item.id, { note: 'shipped' });
    expect(reported.fail).toBe(1);
    expect(done.status).toBe('done');
    expect(done.notes.some((n) => n.body.includes('failing'))).toBe(true);
  });

  it('counts tests in the board summary', async () => {
    const tc = await store.createTestCase({ title: 'counted', status: 'active' });
    await store.recordTestRun({ caseId: tc.id, result: 'fail', createBugOnFailure: false });
    const summary = await store.boardSummary();
    expect(summary.totalTestCases).toBe(1);
    expect(summary.totalTestRuns).toBe(1);
    expect(summary.tests.fail).toBe(1);
    expect(summary.tests.notRun).toBe(0);
  });
});
