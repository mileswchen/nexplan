import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { startWebServer } from '../src/web/server.js';

let dir: string;
let server: http.Server;
let base: string;
let cookie = '';

interface Json {
  [k: string]: unknown;
}

async function req(method: string, url: string, body?: unknown, withCookie = true): Promise<{ status: number; body: Json }> {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-web-'));
  server = await startWebServer({ port: 0, root: dir });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'admin', password: 'admin' }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
  expect(cookie).toContain('nexplan_session');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('web dashboard: test cases and runs', () => {
  it('rejects writes without a session but allows anonymous reads of an open project', async () => {
    const denied = await req('POST', '/api/testcases', { title: 'nope' }, false);
    expect(denied.status).toBe(401);
    const reads = await req('GET', '/api/testcases', undefined, false);
    expect(reads.status).toBe(200);
  });

  it('creates a case, records a failing run, and surfaces it everywhere', async () => {
    const created = await req('POST', '/api/testcases', {
      title: 'Checkout: empty cart',
      type: 'functional',
      priority: 'P1',
      status: 'active',
      steps: [{ action: 'Open checkout with an empty cart', expected: 'A friendly empty state' }],
      tags: ['checkout'],
    });
    expect(created.status).toBe(201);
    const testCase = (created.body as unknown as Json[])[0] as Json;
    expect(testCase.id).toBe('TC-1');

    const run = await req('POST', '/api/testruns', {
      caseId: 'TC-1',
      result: 'fail',
      actual: 'rendered a blank page',
      build: 'v0.4.0',
      batch: 'web smoke',
    });
    expect(run.status).toBe(201);
    const runs = run.body.runs as Json[];
    expect(runs[0].id).toBe('TR-1');
    const createdBugs = run.body.createdBugs as Json[];
    expect(createdBugs).toHaveLength(1);
    expect(createdBugs[0].testCase).toBe('TC-1');

    const list = await req('GET', '/api/testcases?status=active');
    const first = (list.body as unknown as Json[])[0] as Json;
    expect(first.lastResult).toBe('fail');

    // The board summary carries the counts the chips render.
    const board = await req('GET', '/api/board');
    expect(board.body.totalTestCases).toBe(1);
    expect(board.body.totalTestRuns).toBe(1);
    expect((board.body.tests as Json).fail).toBe(1);

    // A passing run fixes the filed bug.
    const pass = await req('POST', '/api/testruns', { runs: [{ caseId: 'TC-1', result: 'pass', build: 'v0.4.1' }], batch: 'web smoke' });
    expect((pass.body.updatedBugs as Json[]).map((b) => b.status)).toEqual(['fixed']);

    // Case detail returns the case with its history, newest first.
    const detail = await req('GET', '/api/testcases/TC-1');
    const history = detail.body.runs as Json[];
    expect(history.map((r) => r.id)).toEqual(['TR-2', 'TR-1']);

    const report = await req('GET', '/api/testreport?batch=web%20smoke');
    expect(report.body.totals).toMatchObject({ cases: 1, runs: 2, pass: 1, fail: 1 });
    expect(report.body.passRate).toBe(50);
    expect((report.body.totals as Json).notRun).toBe(0);

    const runsList = await req('GET', '/api/testruns?caseId=TC-1&limit=1');
    expect((runsList.body as unknown as Json[])).toHaveLength(1);

    // Deleting the case is blocked while runs exist, then allowed with force.
    const blocked = await req('DELETE', '/api/testcases/TC-1');
    expect(blocked.status).toBe(500);
    expect(String(blocked.body.error)).toMatch(/execution record/);
    const forced = await req('DELETE', '/api/testcases/TC-1?force=1');
    expect(forced.status).toBe(200);
    expect(forced.body.deletedRuns).toBe(2);
  });

  it('exposes archive status, a forced archive, restore and reindex', async () => {
    const created = await req('POST', '/api/testcases', { title: 'Archivable', status: 'active' });
    const id = ((created.body as unknown as Json[])[0] as Json).id as string;
    // Two old runs plus one fresh run, all unbatched so nothing anchors the batch hot.
    await req('POST', '/api/testruns', { runs: [
      { caseId: id, result: 'pass', executedAt: '2024-01-05T00:00:00Z' },
      { caseId: id, result: 'fail', executedAt: '2024-01-01T00:00:00Z' },
      { caseId: id, result: 'pass' },
    ] });

    const before = await req('GET', '/api/testarchive');
    expect(before.status).toBe(200);
    expect((before.body.policy as Json).hotDays).toBe(90);

    const dry = await req('POST', '/api/testarchive', { dryRun: true });
    expect(dry.body.archived).toBe(2);
    expect(dry.body.dryRun).toBe(true);
    expect((await req('GET', '/api/testarchive')).body.archivedRuns).toBe(0);

    const moved = await req('POST', '/api/testarchive', {});
    expect(moved.body.archived).toBe(2);
    const bundle = ((moved.body.bundles as Json[])[0] as Json).file as string;
    expect(bundle).toBe('2024-01.jsonl');

    const status = await req('GET', '/api/testarchive');
    // This file shares one workspace across tests, so compare against the
    // snapshot taken before archiving rather than assuming an empty board.
    expect(status.body.hotRuns).toBe((before.body.hotRuns as number) - 2);
    expect(status.body.archivedRuns).toBe(2);
    expect((status.body.bundles as Json[])[0]).toMatchObject({ file: bundle, runs: 2 });

    // Merged by default, excludable on request.
    expect((await req('GET', `/api/testruns?caseId=${id}`)).body as unknown as Json[]).toHaveLength(3);
    expect((await req('GET', `/api/testruns?caseId=${id}&hotOnly=true`)).body as unknown as Json[]).toHaveLength(1);
    expect((await req('GET', '/api/testreport?hotOnly=true')).body.totals).toMatchObject({ runs: 1 });

    const restored = await req('POST', '/api/testarchive/restore', { bundle: '2024-01' });
    expect(restored.body.restored).toBe(2);
    expect((await req('GET', '/api/testarchive')).body.archivedRuns).toBe(0);

    const reindex = await req('POST', '/api/testarchive/reindex');
    expect(reindex.status).toBe(200);
  });
});
