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
let savedProjectEnv: string | undefined;

beforeEach(async () => {
  // Tools resolve their project from $NEXPLAN_PROJECT when a call omits
  // `project`, so a value exported in the developer's shell would otherwise
  // change what every expectation below sees. The tests that care set it.
  savedProjectEnv = process.env.NEXPLAN_PROJECT;
  delete process.env.NEXPLAN_PROJECT;
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
  if (savedProjectEnv === undefined) delete process.env.NEXPLAN_PROJECT;
  else process.env.NEXPLAN_PROJECT = savedProjectEnv;
  // Retries cover the ENOTEMPTY race when a git child process is still
  // finishing a write inside .git/ while the temp dir is being removed.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    expect(names).toContain('nexplan_backlog_tree');
    expect(names).toContain('nexplan_backlog_move');
    expect(names).toContain('nexplan_project_update');
    expect(names).toContain('nexplan_plan_create');
    expect(names).toContain('nexplan_plan_list');
    expect(names).toContain('nexplan_plan_get');
    expect(names).toContain('nexplan_plan_update');
    expect(names).toContain('nexplan_plan_task_add');
    expect(names).toContain('nexplan_plan_task_update');
    expect(names).toContain('nexplan_plan_task_remove');
    expect(names.length).toBe(46);
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

  it('only accepts work-nature types for new items', async () => {
    const rejected = await call('nexplan_backlog_add', { items: [{ title: 'Write the doc', type: 'docs' }] });
    expect(rejected.isError).toBe(true);
    const ok = await call('nexplan_backlog_add', { items: [{ title: 'Write the doc', type: 'chore', tags: ['docs'] }] });
    expect(ok.isError).toBeFalsy();
    // Legacy values stay readable/filterable for data written earlier.
    const list = await call('nexplan_backlog_list', { type: 'chore' });
    expect((list.structuredContent as any).items).toHaveLength(1);
  });

  it('exposes the decomposition tree through the MCP tools', async () => {
    const root = await call('nexplan_backlog_add', { items: [{ title: 'Ship v2' }] });
    const rootId = (root.structuredContent as any).created[0].id;
    const kids = await call('nexplan_backlog_decompose', {
      parentId: rootId,
      children: [{ title: 'API' }, { title: 'Docs' }],
    });
    const apiId = (kids.structuredContent as any).children[0].id;
    // A subtask created directly under a parent via `parent`.
    const deep = await call('nexplan_backlog_add', { items: [{ title: 'Schema', parent: apiId }] });
    const deepId = (deep.structuredContent as any).created[0].id;

    const tree = await call('nexplan_backlog_tree', { id: rootId });
    const node = tree.structuredContent as any;
    expect(node.depth).toBe(1);
    expect(node.childNodes).toHaveLength(2);
    expect(node.childNodes[0].depth).toBe(2);
    expect(node.childNodes[0].childNodes[0].id).toBe(deepId);
    expect(node.childNodes[0].childNodes[0].depth).toBe(3);
    expect(node.subtree).toEqual({ total: 3, done: 0, open: 3 });

    // The 3-level cap is enforced by the tools as well.
    const tooDeep = await call('nexplan_backlog_decompose', { parentId: deepId, children: [{ title: 'Nope' }] });
    expect(tooDeep.isError).toBe(true);

    // Flat listing can still be narrowed to subtasks or one absolute depth.
    const subs = await call('nexplan_backlog_list', { parent: apiId });
    expect((subs.structuredContent as any).items.map((i: any) => i.id)).toEqual([deepId]);
    const top = await call('nexplan_backlog_list', { parent: 'top', tree: true });
    expect((top.structuredContent as any).items.map((n: any) => n.id)).toEqual([rootId]);
    const level3 = await call('nexplan_backlog_list', { depth: 3 });
    expect((level3.structuredContent as any).items.map((i: any) => i.id)).toEqual([deepId]);
  });

  it('re-attaches an item with nexplan_backlog_move', async () => {
    const a = await call('nexplan_backlog_add', { items: [{ title: 'A' }] });
    const b = await call('nexplan_backlog_add', { items: [{ title: 'B' }] });
    const aId = (a.structuredContent as any).created[0].id;
    const bId = (b.structuredContent as any).created[0].id;
    const child = await call('nexplan_backlog_add', { items: [{ title: 'A child', parent: aId }] });
    const childId = (child.structuredContent as any).created[0].id;

    const moved = await call('nexplan_backlog_move', { id: childId, parent: bId, author: 'codex' });
    expect((moved.structuredContent as any).parent).toBe(bId);
    // Cycles are refused.
    const cycle = await call('nexplan_backlog_move', { id: bId, parent: childId });
    expect(cycle.isError).toBe(true);
    // Moving back to the top level.
    const promoted = await call('nexplan_backlog_move', { id: childId, parent: null });
    expect((promoted.structuredContent as any).parent).toBeNull();
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

  it('updates a project key and name over MCP', async () => {
    await call('nexplan_project_create', { key: 'editable', name: 'Editable', author: 'admin' });
    const item = await call('nexplan_backlog_add', { items: [{ title: 'Survives' }], project: 'editable', author: 'admin' });
    expect((item.structuredContent as any).created[0].id).toBe('WI-1');

    const renamed = await call('nexplan_project_update', { key: 'editable', newKey: 'renamed', name: 'Renamed', author: 'admin' });
    expect((renamed.structuredContent as any).key).toBe('renamed');
    expect((renamed.structuredContent as any).name).toBe('Renamed');

    const list = await call('nexplan_project_list', {});
    const keys = (list.structuredContent as any).items.map((p: any) => p.key);
    expect(keys).toContain('renamed');
    expect(keys).not.toContain('editable');
    // The work item moved with the project.
    const items = await call('nexplan_backlog_list', { project: 'renamed' });
    expect((items.structuredContent as any).items.map((i: any) => i.title)).toEqual(['Survives']);
    // Bad keys are refused.
    const bad = await call('nexplan_project_update', { key: 'renamed', newKey: 'bad key', author: 'admin' });
    expect(bad.isError).toBe(true);
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

  it('resolves the project from $NEXPLAN_PROJECT when a call omits it', async () => {
    await call('nexplan_project_create', { key: 'api', name: 'API' });
    await call('nexplan_backlog_add', { items: [{ title: 'Default task' }] });
    await call('nexplan_backlog_add', { items: [{ title: 'API task' }], project: 'api' });

    // `nexplan agent config <agent> --project api` scopes an agent through this
    // variable alone, so a call without `project` must stay inside `api` — for
    // reads and for writes. Falling back to the workspace default instead would
    // move an agent's work into another project without any error.
    process.env.NEXPLAN_PROJECT = 'api';
    try {
      const list = await call('nexplan_backlog_list', {});
      expect((list.structuredContent as any).items.map((i: any) => i.title)).toEqual(['API task']);

      const status = await call('nexplan_status', {});
      expect((status.structuredContent as any).projectKey).toBe('api');

      await call('nexplan_backlog_add', { items: [{ title: 'Also API' }] });
      const apiItems = await call('nexplan_backlog_list', { project: 'api' });
      expect((apiItems.structuredContent as any).items.map((i: any) => i.title).sort()).toEqual(['API task', 'Also API']);
      const defaultItems = await call('nexplan_backlog_list', { project: 'default' });
      expect((defaultItems.structuredContent as any).items.map((i: any) => i.title)).toEqual(['Default task']);

      // An explicit argument still beats the environment.
      const explicit = await call('nexplan_backlog_list', { project: 'default' });
      expect((explicit.structuredContent as any).items.map((i: any) => i.title)).toEqual(['Default task']);

      // A stale value fails loudly rather than landing somewhere else.
      process.env.NEXPLAN_PROJECT = 'missing';
      const bad = await call('nexplan_backlog_list', {});
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/project not found: missing/);
    } finally {
      delete process.env.NEXPLAN_PROJECT;
    }
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

  it('manages a plan and its tasks through the plan tools', async () => {
    // A linked work item drives one task's progress (workitems mode).
    const wi = await call('nexplan_backlog_add', { items: [{ title: '桥接拦截' }], author: 'codex' });
    const wiId = (wi.structuredContent as any).created[0].id;
    await call('nexplan_backlog_claim', { id: wiId, assignee: 'codex' }); // in_progress → 50

    const created = await call('nexplan_plan_create', { title: 'P1 执行计划', author: 'codex' });
    expect(created.isError).toBeFalsy();
    const planId = (created.structuredContent as any).id;
    expect(planId).toBe('PLAN-1');

    // Dependency chain T1 → T2 → T3.
    const t1 = await call('nexplan_plan_task_add', {
      id: planId, title: '地基', start: '2026-11-24', end: '2026-11-26', author: 'codex',
    });
    expect((t1.structuredContent as any).task.id).toBe('T1');
    const t2 = await call('nexplan_plan_task_add', {
      id: planId, title: '主体', start: '2026-11-27', end: '2026-11-28',
      deps: [{ id: 'T1' }], progressSource: 'workitems', workItems: [wiId], author: 'codex',
    });
    expect((t2.structuredContent as any).task.id).toBe('T2');
    await call('nexplan_plan_task_add', {
      id: planId, title: '上线', start: '2026-11-29', end: '2026-11-29',
      milestone: true, deps: [{ id: 'T2' }], author: 'codex',
    });

    // Hard validation is refused by the tools.
    const backwards = await call('nexplan_plan_task_add', {
      id: planId, title: '倒挂', start: '2026-12-05', end: '2026-12-01', author: 'codex',
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.content[0].text).toMatch(/is before start/);
    const badDate = await call('nexplan_plan_task_add', {
      id: planId, title: '坏日期', start: '2026-12-1', end: '2026-12-02', author: 'codex',
    });
    expect(badDate.isError).toBe(true); // zod catches the format first

    // Re-parenting T1 under T3 would close a cycle — refused, nothing written.
    const cycle = await call('nexplan_plan_task_update', {
      id: planId, task: 'T1', deps: [{ id: 'T3' }], author: 'codex',
    });
    expect(cycle.isError).toBe(true);
    expect(cycle.content[0].text).toMatch(/cycle/);

    // plan_get carries effective progress (workitems mode → 50 from in_progress WI).
    const got = await call('nexplan_plan_get', { id: planId });
    const view = got.structuredContent as any;
    expect(view.tasks).toHaveLength(3);
    expect(view.tasks.map((t: any) => t.id)).toEqual(['T1', 'T2', 'T3']);
    expect(view.tasks[0].effectiveProgress).toBe(0);
    expect(view.tasks[1].effectiveProgress).toBe(50);
    expect(view.tasks[2].effectiveProgress).toBe(0); // milestone still todo
    expect(view.summary).toEqual({ start: '2026-11-24', end: '2026-11-29', progress: 17 }); // (0*3+50*2+0*1)/6
    expect(view.warnings).toEqual([]);
    expect(view.status).toBe('draft');

    // Marking the milestone done flips its effective progress to 100 (manual rule).
    const doneUpdate = await call('nexplan_plan_task_update', {
      id: planId, task: 'T3', status: 'done', author: 'codex',
    });
    expect((doneUpdate.structuredContent as any).task.status).toBe('done');
    const afterDone = await call('nexplan_plan_get', { id: planId });
    expect(((afterDone.structuredContent as any).tasks[2]).effectiveProgress).toBe(100);
    expect(((afterDone.structuredContent as any).summary as any).progress).toBe(33); // (0*3+50*2+100*1)/6

    // plan_list carries the same derived view.
    const listed = await call('nexplan_plan_list', {});
    expect((listed.structuredContent as any).items).toHaveLength(1);
    expect((listed.structuredContent as any).items[0].id).toBe(planId);

    // The depended-on milestone cannot be removed while T2 references it.
    const blocked = await call('nexplan_plan_task_remove', { id: planId, task: 'T2', author: 'codex' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/still a dependency of T3/);
    // T1 is depended on by T2 as well — clear the edge first, then remove.
    const stillBlocked = await call('nexplan_plan_task_remove', { id: planId, task: 'T1', author: 'codex' });
    expect(stillBlocked.isError).toBe(true);
    await call('nexplan_plan_task_update', { id: planId, task: 'T2', deps: [], author: 'codex' });
    const removed = await call('nexplan_plan_task_remove', { id: planId, task: 'T1', author: 'codex' });
    expect(removed.isError).toBeFalsy();
    expect((removed.structuredContent as any).taskCount).toBe(2);

    // Archive replaces deletion.
    const archived = await call('nexplan_plan_update', { id: planId, status: 'archived', author: 'codex' });
    expect((archived.structuredContent as any).status).toBe('archived');
    const gone = await call('nexplan_plan_get', { id: 'PLAN-404' });
    expect(gone.isError).toBe(true);
  });
});
