import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { Git } from '../src/core/git.js';

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

describe('init', () => {
  it('creates a git repo and board directories', async () => {
    const git = new Git(dir);
    expect(await git.isRepo()).toBe(true);
    const meta = await store.loadMeta();
    expect(meta.name).toBe('NexPlan');
    await expect(store.listWorkItems()).resolves.toEqual([]);
  });
});

describe('work items', () => {
  it('creates and lists a backlog item', async () => {
    const item = await store.createWorkItem({
      title: 'Add login flow',
      type: 'feature',
      priority: 'P1',
      description: 'Implement OAuth login',
      tags: ['auth'],
    });
    expect(item.id).toMatch(/^WI-1$/);
    expect(item.status).toBe('backlog');
    expect(item.source).toBe('agent'); // default agent attribution
    const all = await store.listWorkItems();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Add login flow');
  });

  it('claims an item (assign + in_progress)', async () => {
    const item = await store.createWorkItem({ title: 'T', priority: 'P0' });
    const claimed = await store.claimWorkItem(item.id, 'claude-code');
    expect(claimed.status).toBe('in_progress');
    expect(claimed.assignee).toBe('claude-code');
    expect(claimed.notes.at(-1)?.body).toContain('claimed');
  });

  it('completes an item and sets status/dates', async () => {
    const item = await store.createWorkItem({ title: 'Task A' });
    const { item: done } = await store.completeWorkItem(item.id, {
      note: 'implemented + tested',
      closeLinkedBugs: false,
    });
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeTruthy();
    expect(done.notes.at(-1)?.body).toContain('complete');
    const after = await store.getWorkItem(item.id);
    expect(after?.status).toBe('done');
  });

  it('decomposes a parent into child backlog items', async () => {
    const parent = await store.createWorkItem({ title: 'Ship v1', type: 'feature' });
    const { parent: updated, children } = await store.decomposeWorkItem(parent.id, [
      { title: 'Build API', type: 'refactor' },
      { title: 'Write docs', type: 'docs' },
    ]);
    expect(children).toHaveLength(2);
    expect(children[0].parent).toBe(parent.id);
    expect(children[0].status).toBe('backlog');
    expect(updated.children).toEqual(children.map((c) => c.id));
    // Child ids are unique and monotonic.
    expect(children.map((c) => c.id)).toEqual(['WI-2', 'WI-3']);
  });

  it('applies list filters', async () => {
    await store.createWorkItem({ title: 'A', priority: 'P0', type: 'feature' });
    await store.createWorkItem({ title: 'B', priority: 'P2', type: 'task' });
    await store.createWorkItem({ title: 'C', priority: 'P1', type: 'task', tags: ['api'] });
    const p0 = await store.listWorkItems({ priority: 'P0' });
    expect(p0).toHaveLength(1);
    const tasks = await store.listWorkItems({ type: 'task', tags: ['api'] });
    expect(tasks).toHaveLength(1);
    const q = await store.listWorkItems({ query: 'B' });
    expect(q).toHaveLength(1);
  });
});

describe('bugs', () => {
  it('creates a bug from an agent', async () => {
    const bug = await store.createBug({
      title: 'Crash on login',
      severity: 'critical',
      evidence: 'TypeError: foo is undefined',
    });
    expect(bug.id).toBe('BUG-1');
    expect(bug.foundBy).toBe('agent');
    expect(bug.foundByAgent).toBe('test-agent');
    expect(bug.evidence).toContain('TypeError');
  });

  it('creates a bug manually', async () => {
    const bug = await store.createBug({ title: 'UI glitch', author: 'user' });
    expect(bug.foundBy).toBe('manual');
    expect(bug.foundByAgent).toBeNull();
  });

  it('completing a linked work item auto-closes the bug', async () => {
    const bug = await store.createBug({ title: 'Bug Z', severity: 'major' });
    const item = await store.createWorkItem({ title: 'Fix Z', fixesBug: [bug.id] });
    const { closedBugs } = await store.completeWorkItem(item.id, { note: 'fixed' });
    expect(closedBugs).toHaveLength(1);
    expect(closedBugs[0].status).toBe('fixed');
    expect(closedBugs[0].workItem).toBe(item.id);
    const after = await store.getBug(bug.id);
    expect(after?.status).toBe('fixed');
  });
});

describe('docs', () => {
  it('creates a doc with frontmatter metadata', async () => {
    const doc = await store.createDoc({
      title: 'API Design',
      type: 'design',
      body: '# API Design\n\nREST over JSON.',
      tags: ['api'],
    });
    expect(doc.slug).toBe('api-design');
    expect(doc.meta.version).toBe(1);
    expect(doc.meta.type).toBe('design');
    expect(doc.content).toContain('REST over JSON');

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(path.join(dir, 'docs', 'api-design.md'), 'utf8'));
    expect(raw).toContain('title: API Design');
  });

  it('updates a doc and bumps the version', async () => {
    const doc = await store.createDoc({ title: 'ADR: storage', type: 'adr', body: 'body v1' });
    const updated = await store.updateDoc(doc.slug, { content: 'body v2', status: 'approved' });
    expect(updated.meta.version).toBe(2);
    expect(updated.meta.status).toBe('approved');
    expect(updated.content).toBe('body v2');
  });

  it('reports full version history via git', async () => {
    const doc = await store.createDoc({ title: 'Decision', type: 'decision', body: 'version one' });
    await store.updateDoc(doc.slug, { content: 'version two' });
    await store.updateDoc(doc.slug, { content: 'version three' });
    const history = await store.docHistory(doc.slug);
    // Newest first, 3 commits.
    expect(history.length).toBe(3);
    expect(history[0].version).toBe(3);
    expect(history[1].version).toBe(2);
    expect(history[0].message).toContain('v3');
  });

  it('lists docs sorted by recency', async () => {
    await store.createDoc({ title: 'Doc A' });
    await store.createDoc({ title: 'Doc B' });
    const docs = await store.listDocs();
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.slug).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('generates a unique slug when title collides', async () => {
    await store.createDoc({ title: 'Same' });
    const second = await store.createDoc({ title: 'Same' });
    expect(second.slug).toBe('same-2');
  });

  it('keeps CJK characters in slugs and versions them', async () => {
    const doc = await store.createDoc({ title: '下单设计', type: 'design', body: 'v1' });
    expect(doc.slug).toBe('下单设计');
    const updated = await store.updateDoc(doc.slug, { content: 'v2' });
    expect(updated.meta.version).toBe(2);
    const history = await store.docHistory(doc.slug);
    expect(history.length).toBe(2);
  });
});

describe('board summary', () => {
  it('aggregates counts and recent activity', async () => {
    await store.createWorkItem({ title: 'W1' });
    await store.createWorkItem({ title: 'W2' });
    await store.createBug({ title: 'B1' });
    const s = await store.boardSummary();
    expect(s.workItems.backlog).toBe(2);
    expect(s.bugs.open).toBe(1);
    expect(s.totalWorkItems).toBe(2);
    expect(s.recent.length).toBeGreaterThanOrEqual(1);
  });
});
