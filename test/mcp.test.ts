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
    expect(names.length).toBe(26);
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
});
