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
  // Wait for the bind, but never wait for an event that already fired: on a fast
  // runner `listening` can be emitted before this line runs, which would hang the
  // hook forever (the original reason this suite could fail only on CI).
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
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

describe('web dashboard: work item hierarchy', () => {
  it('serves the decomposition tree, breadcrumbs and moves over REST', async () => {
    // POST /api/workitems returns the array of created items.
    const root = await req('POST', '/api/workitems', { title: 'Ship v3', type: 'feature' });
    const rootId = (root.body as unknown as Json[])[0].id as string;
    const kids = await req('POST', `/api/workitems/${rootId}/decompose`, { children: [{ title: 'API' }, { title: 'Docs' }] });
    const apiId = ((kids.body as unknown as { children: Json[] }).children[0] as Json).id as string;
    const deep = await req('POST', '/api/workitems', { title: 'Schema', parent: apiId });
    const deepId = (deep.body as unknown as Json[])[0].id as string;
    expect((deep.body as unknown as Json[])[0].parent).toBe(apiId);

    // Forest: roots carry their subtree, with depths and rollups.
    const forest = (await req('GET', '/api/workitems?tree=1')).body as unknown as Json[];
    const rootNode = forest.find((n) => n.id === rootId) as Json;
    expect(rootNode.depth).toBe(1);
    expect(rootNode.childNodes).toHaveLength(2);
    expect((rootNode.subtree as Json)).toMatchObject({ total: 3, done: 0, open: 3 });
    expect(((rootNode.childNodes as Json[])[0].childNodes as Json[])[0].id).toBe(deepId);

    // Filtering keeps the attachment: a level-3 match still reports its depth.
    const filtered = (await req('GET', '/api/workitems?tree=1&query=Schema')).body as unknown as Json[];
    expect(filtered.map((n) => n.id)).toEqual([deepId]);
    expect(filtered[0].depth).toBe(3);

    // Item detail carries the breadcrumb and the direct subtasks.
    const detail = (await req('GET', `/api/workitems/${deepId}`)).body;
    expect(detail.depth).toBe(3);
    expect((detail.ancestors as Json[]).map((a) => a.id)).toEqual([rootId, apiId]);
    expect((detail.childNodes as Json[])).toHaveLength(0);
    const mid = (await req('GET', `/api/workitems/${apiId}`)).body;
    expect((mid.childNodes as Json[]).map((c) => c.id)).toEqual([deepId]);

    // Explicit subtree route.
    const tree = await req('GET', `/api/workitems/${rootId}/tree`);
    expect(tree.body.depth).toBe(1);
    expect((tree.body.childNodes as Json[])).toHaveLength(2);
    expect((await req('GET', '/api/workitems/WI-999/tree')).status).toBe(404);

    // Subtask/depth filters.
    const subs = (await req('GET', `/api/workitems?parent=${apiId}`)).body as unknown as Json[];
    expect(subs.map((i) => i.id)).toEqual([deepId]);
    const top = (await req('GET', '/api/workitems?tree=1&parent=top')).body as unknown as Json[];
    expect(top.every((n) => n.parent === null)).toBe(true);

    // The 3-level cap is enforced server-side.
    const tooDeep = await req('POST', `/api/workitems/${deepId}/decompose`, { children: [{ title: 'Nope' }] });
    expect(tooDeep.status).toBe(500);
    expect(String(tooDeep.body.error)).toMatch(/level 3 of 3/);

    // The move endpoint refuses anything that would break the level cap:
    // WI-2 (with a level-3 child) cannot hang under a level-2 item.
    const docsId = ((kids.body as unknown as { children: Json[] }).children[1] as Json).id as string;
    const tooDeepMove = await req('POST', `/api/workitems/${apiId}/move`, { parent: docsId });
    expect(String(tooDeepMove.body.error)).toMatch(/limit 3/);

    // Re-attaching a leaf keeps both sides of the link.
    const other = await req('POST', '/api/workitems', { title: 'Other feature' });
    const otherId = (other.body as unknown as Json[])[0].id as string;
    const moved = await req('POST', `/api/workitems/${docsId}/move`, { parent: otherId });
    expect(moved.body.parent).toBe(otherId);
    const oldParent = (await req('GET', `/api/workitems/${rootId}`)).body;
    expect((oldParent.childNodes as Json[]).map((c) => c.id)).toEqual([apiId]);
    const cycle = await req('POST', `/api/workitems/${otherId}/move`, { parent: docsId });
    expect(String(cycle.body.error)).toMatch(/cycle/);
    const promoted = await req('POST', `/api/workitems/${docsId}/move`, { parent: null });
    expect(promoted.body.parent).toBeNull();

    // Raw parent/children patches are refused so a link can never be half-written.
    const patch = await req('PATCH', `/api/workitems/${apiId}`, { parent: otherId });
    expect(String(patch.body.error)).toMatch(/moveWorkItem/);
    // Re-sending the current value is a no-op, not an error.
    const idempotent = await req('PATCH', `/api/workitems/${apiId}`, { parent: rootId, title: 'API v2' });
    expect(idempotent.status).toBe(200);
    expect(idempotent.body.parent).toBe(rootId);
  });
});

describe('web dashboard: project key and name editing', () => {
  it('renames a project key through PATCH and keeps its data reachable', async () => {
    const created = await req('POST', '/api/projects', { key: 'editable', name: 'Editable', author: 'admin' });
    expect(created.status).toBe(201);
    const item = await req('POST', '/api/workitems?project=editable', { title: 'Survives the rename' });
    const itemId = (item.body as unknown as Json[])[0].id as string;

    // Rename the key and the display name in one request.
    const patched = await req('PATCH', '/api/projects/editable', { newKey: 'renamed', name: 'Renamed project' });
    expect(patched.status).toBe(200);
    expect(patched.body.key).toBe('renamed');
    expect(patched.body.name).toBe('Renamed project');

    const projects = (await req('GET', '/api/projects')).body as unknown as Json[];
    const keys = projects.map((p) => p.key);
    expect(keys).toContain('renamed');
    expect(keys).not.toContain('editable');
    expect(projects.find((p) => p.key === 'renamed')?.name).toBe('Renamed project');

    // The old key no longer resolves; the new one serves the same records.
    expect((await req('GET', '/api/workitems?project=editable')).status).toBe(500);
    const items = (await req('GET', '/api/workitems?project=renamed')).body as unknown as Json[];
    expect(items.map((i) => i.id)).toEqual([itemId]);

    // Invalid and colliding keys are rejected with a readable reason.
    const bad = await req('PATCH', '/api/projects/renamed', { newKey: 'bad key' });
    expect(String(bad.body.error)).toMatch(/invalid project key/);
    const clash = await req('PATCH', '/api/projects/renamed', { newKey: 'default' });
    expect(String(clash.body.error)).toMatch(/exists/);

    // A name-only patch leaves the key alone.
    const nameOnly = await req('PATCH', '/api/projects/renamed', { name: 'Just the name' });
    expect(nameOnly.body.key).toBe('renamed');
    expect(nameOnly.body.name).toBe('Just the name');
  });
});
