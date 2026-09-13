import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Workspace } from '../src/core/workspace.js';
import { registerNexplanTools } from '../src/mcp/tools.js';

let dir: string;
let client: Client;
let server: McpServer;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-mcp-'));
  const workspace = new Workspace({ root: dir, agentName: 'mcp-agent', autoCommit: true });
  await workspace.init();
  server = new McpServer({ name: 'nexplan', version: '0.2.0' });
  registerNexplanTools(server, workspace);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  // Connect the server before the client: the in-memory transport queues the
  // client's `initialize` until the server side is listening, so connecting the
  // client first would block forever awaiting the handshake response.
  await server.connect(serverT);
  await client.connect(clientT);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return res;
}

describe('MCP server tools', () => {
  it('registers all tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain('nexplan_backlog_add');
    expect(names).toContain('nexplan_backlog_complete');
    expect(names).toContain('nexplan_docs_update');
    expect(names).toContain('nexplan_bug_add');
    expect(names).toContain('nexplan_agent_next');
    expect(names).toContain('nexplan_project_create');
    expect(names).toContain('nexplan_user_add');
    expect(names).toContain('nexplan_test_case_add');
    expect(names).toContain('nexplan_test_run_record');
    expect(names).toContain('nexplan_test_report');
    expect(names.length).toBe(36);
  });

  it('adds a backlog item and lists it', async () => {
    const r = await call('nexplan_backlog_add', {
      items: [{ title: 'Build parser', type: 'feature', priority: 'P1', tags: ['core'] }],
      author: 'claude-code',
    });
    expect(r.isError).toBeFalsy();
    const created = (r.structuredContent as any).created;
    expect(created[0].id).toBe('WI-1');
    expect(created[0].source).toBe('agent');

    const list = await call('nexplan_backlog_list', { query: 'parser' });
    expect((list.structuredContent as any).items).toHaveLength(1);
  });

  it('claims, completes, and auto-closes a linked bug', async () => {
    const bug = await call('nexplan_bug_add', { title: 'Segfault', severity: 'critical', evidence: 'core dump' });
    const bugId = (bug.structuredContent as any).id;
    const item = await call('nexplan_backlog_add', { items: [{ title: 'Fix segfault', fixesBug: [bugId] }], author: 'codex' });
    const itemId = (item.structuredContent as any).created[0].id;

    const claimed = await call('nexplan_backlog_claim', { id: itemId, assignee: 'codex' });
    expect((claimed.structuredContent as any).status).toBe('in_progress');
    expect((claimed.structuredContent as any).assignee).toBe('codex');

    const done = await call('nexplan_backlog_complete', { id: itemId, note: 'fixed with bounds checks' });
    expect((done.structuredContent as any).item.status).toBe('done');
    expect((done.structuredContent as any).closedBugs).toHaveLength(1);

    const bugAfter = await call('nexplan_bug_get', { id: bugId });
    expect((bugAfter.structuredContent as any).status).toBe('fixed');
  });

  it('stores and updates a design document link', async () => {
    const r = await call('nexplan_backlog_add', { items: [{ title: 'X', docLink: 'https://example.com/d' }], author: 'codex' });
    expect((r.structuredContent as any).created[0].docLink).toBe('https://example.com/d');
    const id = (r.structuredContent as any).created[0].id;
    const up = await call('nexplan_backlog_update', { id, docLink: 'https://example.com/d2', author: 'codex' });
    expect((up.structuredContent as any).docLink).toBe('https://example.com/d2');
  });

  it('decomposes a parent item', async () => {
    const parent = await call('nexplan_backlog_add', { items: [{ title: 'Ship v1' }] });
    const pid = (parent.structuredContent as any).created[0].id;
    const r = await call('nexplan_backlog_decompose', {
      parentId: pid,
      children: [{ title: 'API' }, { title: 'Docs' }],
    });
    const children = (r.structuredContent as any).children;
    expect(children).toHaveLength(2);
    expect(children[0].parent).toBe(pid);
    expect((r.structuredContent as any).parent.children).toEqual(children.map((c: any) => c.id));
  });

  it('creates, updates, and shows version history for a doc', async () => {
    const doc = await call('nexplan_docs_create', { title: 'ADR: DB', type: 'decision', body: 'v1' });
    const slug = (doc.structuredContent as any).slug;
    await call('nexplan_docs_update', { slug, content: 'v2', status: 'approved' });
    const hist = await call('nexplan_docs_history', { slug });
    expect((hist.structuredContent as any).items).toHaveLength(2);
    expect((hist.structuredContent as any).items[0].version).toBe(2);
  });

  it('adds comments to a doc, restricted to project members/admins', async () => {
    await call('nexplan_user_add', { id: 'alice', kind: 'human', role: 'member' });
    await call('nexplan_project_create', { key: 'team', name: 'Team', members: ['alice'], author: 'alice' });
    const doc = await call('nexplan_docs_create', { title: 'Design', body: 'body', author: 'alice', project: 'team' });
    const slug = (doc.structuredContent as any).slug;
    // A project member (the creator) can comment.
    const c = await call('nexplan_docs_comment', { slug, body: 'Looks good', author: 'alice', project: 'team' });
    expect(c.isError).toBeFalsy();
    expect((c.structuredContent as any).author).toBe('alice');
    // A non-member cannot comment on a rostered project.
    const denied = await call('nexplan_docs_comment', { slug, body: 'nope', author: 'bob', project: 'team' });
    expect(denied.isError).toBeTruthy();
    expect(denied.content[0].text).toMatch(/not a project member/);
  });

  it('reports status and suggests next work', async () => {
    await call('nexplan_backlog_add', { items: [{ title: 'Important', priority: 'P0' }] });
    await call('nexplan_bug_add', { title: 'Crash', severity: 'critical' });
    const next = await call('nexplan_agent_next', { assignee: 'opencode' });
    expect((next.structuredContent as any).recommendation).toBe('bug'); // critical bug wins
    const status = await call('nexplan_status', {});
    const b = (status.structuredContent as any);
    expect(b.totalWorkItems).toBe(1);
    expect(b.totalBugs).toBe(1);
    expect(b.projectKey).toBe('default');
  });

  it('creates a project and isolates work within it', async () => {
    await call('nexplan_project_create', { key: 'api', name: 'API' });
    await call('nexplan_backlog_add', { items: [{ title: 'API task' }], project: 'api' });
    const defaultList = await call('nexplan_backlog_list', {});
    const apiList = await call('nexplan_backlog_list', { project: 'api' });
    expect((defaultList.structuredContent as any).items).toHaveLength(0);
    expect((apiList.structuredContent as any).items).toHaveLength(1);
    expect((apiList.structuredContent as any).items[0].title).toBe('API task');
    const projects = await call('nexplan_project_list', {});
    expect((projects.structuredContent as any).items.map((p: any) => p.key)).toEqual(['default', 'api']);
  });

  it('deletes an item as its creator or an admin, but not as an unrelated member', async () => {
    const item = await call('nexplan_backlog_add', { items: [{ title: 'Delete me' }], author: 'codex' });
    const itemId = (item.structuredContent as any).created[0].id;

    // Creator can delete.
    const del = await call('nexplan_backlog_delete', { id: itemId, author: 'codex' });
    expect(del.isError).toBeFalsy();
    expect((del.structuredContent as any).id).toBe(itemId);
    const after = await call('nexplan_backlog_get', { id: itemId, author: 'codex' });
    expect(after.isError).toBeTruthy(); // gone

    // A non-creator, non-admin member is denied (SDK surfaces as isError).
    const item2 = await call('nexplan_backlog_add', { items: [{ title: 'Keep' }], author: 'codex' });
    const item2Id = (item2.structuredContent as any).created[0].id;
    const denied = await call('nexplan_backlog_delete', { id: item2Id, author: 'alice' });
    expect(denied.isError).toBeTruthy();
    expect(denied.content[0].text).toMatch(/creator|admin/);

    // Admin can delete regardless of who created it.
    const adminDel = await call('nexplan_backlog_delete', { id: item2Id, author: 'admin' });
    expect(adminDel.isError).toBeFalsy();
  });

  it('manages users through MCP', async () => {
    await call('nexplan_user_add', { id: 'claude-code', kind: 'agent', role: 'member' });
    const users = await call('nexplan_user_list', {});
    const list = (users.structuredContent as any).items;
    expect(list.map((u: any) => u.id).sort()).toEqual(['admin', 'claude-code']);
    const claude = list.find((u: any) => u.id === 'claude-code');
    expect(claude.kind).toBe('agent');
  });

  it('enforces a project member roster for board access', async () => {
    await call('nexplan_user_add', { id: 'alice', kind: 'human', role: 'member' });
    await call('nexplan_project_create', { key: 'team', name: 'Team', members: ['alice'], author: 'alice' });
    // A project member can write.
    const ok = await call('nexplan_backlog_add', { items: [{ title: 'ok' }], project: 'team', author: 'alice' });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as any).created).toHaveLength(1);
    // A non-member is denied on both reads and writes (SDK surfaces as isError).
    const noWrite = await call('nexplan_backlog_add', { items: [{ title: 'no' }], project: 'team', author: 'bob' });
    expect(noWrite.isError).toBeTruthy();
    expect(noWrite.content[0].text).toMatch(/not a project member/);
    const noRead = await call('nexplan_backlog_list', { project: 'team', author: 'bob' });
    expect(noRead.isError).toBeTruthy();
  });

  it('adds test cases, records a batch of runs, and files one bug for the failure', async () => {
    const cases = await call('nexplan_test_case_add', {
      items: [
        { title: 'Order: out-of-stock message', priority: 'P1', status: 'active', tags: ['orders'] },
        { title: 'Order: happy path', status: 'active' },
      ],
      author: 'claude-code',
    });
    expect(cases.isError).toBeFalsy();
    const created = (cases.structuredContent as any).created;
    expect(created.map((c: any) => c.id)).toEqual(['TC-1', 'TC-2']);

    const recorded = await call('nexplan_test_run_record', {
      runs: [
        { caseId: 'TC-1', result: 'fail', actual: 'returned 500', evidence: 'logs/order.log:42', build: 'v0.4.0' },
        { caseId: 'TC-2', result: 'pass', build: 'v0.4.0' },
      ],
      batch: 'v0.4.0 regression',
      author: 'claude-code',
    });
    expect(recorded.isError).toBeFalsy();
    const body = recorded.structuredContent as any;
    expect(body.count).toBe(2);
    expect(body.runs.map((r: any) => r.id)).toEqual(['TR-1', 'TR-2']);
    expect(body.runs.every((r: any) => r.batch === 'v0.4.0 regression')).toBe(true);
    expect(body.createdBugs).toHaveLength(1);
    expect(body.createdBugs[0].severity).toBe('major'); // P1 → major
    expect(body.createdBugs[0].testCase).toBe('TC-1');

    // Listing cases decorates them with their latest result.
    const listed = await call('nexplan_test_case_list', { status: 'active' });
    const byId = new Map((listed.structuredContent as any).items.map((c: any) => [c.id, c]));
    expect((byId.get('TC-1') as any).lastResult).toBe('fail');
    expect((byId.get('TC-2') as any).lastResult).toBe('pass');
    // Latest-result filtering works on the decorated view.
    const failing = await call('nexplan_test_case_list', { lastResult: 'fail' });
    expect((failing.structuredContent as any).items.map((c: any) => c.id)).toEqual(['TC-1']);

    // The passing run two runs later advances the bug to fixed.
    const fixed = await call('nexplan_test_run_record', {
      runs: [{ caseId: 'TC-1', result: 'pass', build: 'v0.4.0-rc2' }],
      batch: 'v0.4.0 regression',
      author: 'claude-code',
    });
    expect((fixed.structuredContent as any).updatedBugs.map((b: any) => b.status)).toEqual(['fixed']);

    const history = await call('nexplan_test_run_list', { caseId: 'TC-1' });
    expect((history.structuredContent as any).items).toHaveLength(2);

    const report = await call('nexplan_test_report', { batch: 'v0.4.0 regression' });
    const r = report.structuredContent as any;
    expect(r.totals).toMatchObject({ cases: 2, runs: 3, pass: 2, fail: 1, notRun: 0 });
    expect(r.passRate).toBeCloseTo(66.7, 1);
  });

  it('suggests test-driven work: re-verify a fixed bug whose case still fails, then fix a failing case', async () => {
    // A work item with a guarded bug and a case that keeps failing.
    const bug = await call('nexplan_bug_add', { title: 'Guarded defect', severity: 'minor', author: 'codex' });
    const bugId = (bug.structuredContent as any).id;
    const item = await call('nexplan_backlog_add', { items: [{ title: 'Fix guarded defect', priority: 'P2' }], author: 'codex' });
    const itemId = (item.structuredContent as any).created[0].id;
    await call('nexplan_test_case_add', {
      items: [{ title: 'Guarded case', status: 'active', workItem: itemId, bugs: [bugId] }],
      author: 'codex',
    });
    await call('nexplan_test_run_record', {
      runs: [{ caseId: 'TC-1', result: 'fail', actual: 'still broken' }],
      createBugOnFailure: false,
      author: 'codex',
    });

    // With the bug still open, the next thing is to fix it through its work item.
    const fix = await call('nexplan_agent_next', { author: 'codex' });
    expect((fix.structuredContent as any).recommendation).toBe('workitem');
    expect((fix.structuredContent as any).item.id).toBe(itemId);
    expect((fix.structuredContent as any).reason).toMatch(/TC-1 is failing/);

    // Someone marks the bug fixed while the case still fails → re-check the fix.
    await call('nexplan_bug_update', { id: bugId, status: 'fixed', author: 'codex' });
    const verify = await call('nexplan_agent_next', { author: 'codex' });
    expect((verify.structuredContent as any).recommendation).toBe('test-verify');
    expect((verify.structuredContent as any).testCase.id).toBe('TC-1');
    expect((verify.structuredContent as any).reason).toMatch(/still fails while BUG-1 is fixed/);
  });

  it('reports a verification summary when completing an item with failing cases', async () => {
    const item = await call('nexplan_backlog_add', { items: [{ title: 'Gated' }], author: 'codex' });
    const itemId = (item.structuredContent as any).created[0].id;
    await call('nexplan_test_case_add', {
      items: [{ title: 'Gate case', status: 'active', workItem: itemId }],
      author: 'codex',
    });
    await call('nexplan_test_run_record', {
      runs: [{ caseId: 'TC-1', result: 'fail' }],
      createBugOnFailure: false,
      author: 'codex',
    });

    // Gate off (default): completes, and reports the verification summary.
    const free = await call('nexplan_backlog_complete', { id: itemId, author: 'codex' });
    expect(free.isError).toBeFalsy();
    expect((free.structuredContent as any).verification).toMatchObject({ cases: 1, fail: 1 });
  });

  it('deletes a test case only for its creator, and only when forced past its runs', async () => {
    await call('nexplan_test_case_add', { items: [{ title: 'Guarded' }], author: 'codex' });
    await call('nexplan_test_run_record', { runs: [{ caseId: 'TC-1', result: 'pass' }], author: 'codex' });

    const denied = await call('nexplan_test_case_delete', { id: 'TC-1', author: 'alice' });
    expect(denied.isError).toBeTruthy();

    const blocked = await call('nexplan_test_case_delete', { id: 'TC-1', author: 'codex' });
    expect(blocked.isError).toBeTruthy();
    expect(blocked.content[0].text).toMatch(/execution record/);

    const forced = await call('nexplan_test_case_delete', { id: 'TC-1', author: 'codex', force: true });
    expect(forced.isError).toBeFalsy();
    expect((forced.structuredContent as any).deletedRuns).toBe(1);
  });
});
