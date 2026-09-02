import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store } from '../src/core/store.js';
import { registerNexplanTools } from '../src/mcp/tools.js';

let dir: string;
let client: Client;
let server: McpServer;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-mcp-'));
  const store = new Store({ root: dir, agentName: 'mcp-agent', autoCommit: true });
  await store.init();
  server = new McpServer({ name: 'nexplan', version: '0.1.0' });
  registerNexplanTools(server, store);
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
    expect(names.length).toBeGreaterThanOrEqual(18);
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
  });
});
