import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEGACY_WORK_ITEM_TYPES, Store, WORKITEM_TYPES } from '../src/core/store.js';
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
      { title: 'Write docs', type: 'chore' },
    ]);
    expect(children).toHaveLength(2);
    expect(children[0].parent).toBe(parent.id);
    expect(children[0].status).toBe('backlog');
    expect(updated.children).toEqual(children.map((c) => c.id));
    // Child ids are unique and monotonic.
    expect(children.map((c) => c.id)).toEqual(['WI-2', 'WI-3']);
  });

  it('stores and updates a design document link', async () => {
    const item = await store.createWorkItem({ title: 'Auth', docLink: 'https://example.com/design' });
    expect(item.docLink).toBe('https://example.com/design');
    const updated = await store.updateWorkItem(item.id, { docLink: 'https://example.com/design-v2' });
    expect(updated.docLink).toBe('https://example.com/design-v2');
    // Clear it back to null.
    const cleared = await store.updateWorkItem(item.id, { docLink: null });
    expect(cleared.docLink).toBeNull();
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

  it('deletes a work item and detaches it from its parent', async () => {
    const parent = await store.createWorkItem({ title: 'Parent', type: 'feature' });
    const { children } = await store.decomposeWorkItem(parent.id, [{ title: 'Child' }]);
    // Refuses to delete a parent that still has children.
    await expect(store.deleteWorkItem(parent.id)).rejects.toThrow(/child/);
    // Deleting a detached leaf works and clears it from the parent's children.
    const deleted = await store.deleteWorkItem(children[0].id);
    expect(deleted.id).toBe(children[0].id);
    expect(await store.getWorkItem(children[0].id)).toBeNull();
    expect((await store.getWorkItem(parent.id))?.children).toEqual([]);
    // Deleting an unknown id throws.
    await expect(store.deleteWorkItem('WI-999')).rejects.toThrow(/not found/);
  });
});

describe('work item hierarchy', () => {
  /** WI-1 → WI-2 → WI-3, i.e. task → subtask → sub-subtask. */
  async function threeLevels() {
    const task = await store.createWorkItem({ title: 'Ship v1', type: 'feature' });
    const { children: subs } = await store.decomposeWorkItem(task.id, [{ title: 'Build API' }]);
    const { children: subsubs } = await store.decomposeWorkItem(subs[0].id, [{ title: 'Design schema' }]);
    return { task, sub: subs[0], subsub: subsubs[0] };
  }

  it('builds a 3-level tree with depths, rollups and a breadcrumb path', async () => {
    const { task, sub, subsub } = await threeLevels();
    const tree = await store.getWorkItemTree(task.id);
    expect(tree?.depth).toBe(1);
    expect(tree?.root).toBe(true);
    expect(tree?.childNodes.map((n) => n.id)).toEqual([sub.id]);
    expect(tree?.childNodes[0].depth).toBe(2);
    expect(tree?.childNodes[0].childNodes.map((n) => n.id)).toEqual([subsub.id]);
    expect(tree?.childNodes[0].childNodes[0].depth).toBe(3);
    expect(tree?.childNodes[0].childNodes[0].overCap).toBe(false);
    // Rollups: the deep node counts toward both the child and the subtree totals.
    expect(tree?.childProgress).toEqual({ total: 1, done: 0, open: 1 });
    expect(tree?.subtree).toEqual({ total: 2, done: 0, open: 2 });
    await store.completeWorkItem(subsub.id, { closeLinkedBugs: false });
    const after = await store.getWorkItemTree(task.id);
    expect(after?.subtree).toEqual({ total: 2, done: 1, open: 1 });

    const path = await store.workItemPath(subsub.id);
    expect(path?.depth).toBe(3);
    expect(path?.ancestors.map((a) => a.id)).toEqual([task.id, sub.id]);
    expect(await store.getWorkItemTree('WI-404')).toBeNull();
    expect(await store.workItemPath('WI-404')).toBeNull();
  });

  it('refuses to decompose past the 3-level cap', async () => {
    const { subsub } = await threeLevels();
    await expect(store.decomposeWorkItem(subsub.id, [{ title: 'Too deep' }])).rejects.toThrow(/3 levels|level 3/);
    // Nothing was created by the refused call.
    expect(await store.listWorkItems()).toHaveLength(3);
  });

  it('filters by parent and depth, and lists an attached forest', async () => {
    const { task, sub, subsub } = await threeLevels();
    const other = await store.createWorkItem({ title: 'Unrelated' });

    expect((await store.listWorkItems({ parent: sub.id })).map((i) => i.id)).toEqual([subsub.id]);
    expect((await store.listWorkItems({ parent: null })).map((i) => i.id).sort()).toEqual([task.id, other.id].sort());
    expect((await store.listWorkItems({ depth: 3 })).map((i) => i.id)).toEqual([subsub.id]);

    // A filter that matches only the deepest item still shows where it hangs:
    // the match becomes the root of its own subtree.
    const forest = await store.listWorkItemTrees({ query: 'Design schema' });
    expect(forest.map((n) => n.id)).toEqual([subsub.id]);
    expect(forest[0].root).toBe(true);
    expect(forest[0].matched).toBe(true);
    expect(forest[0].depth).toBe(3);

    // Matching an ancestor and a descendant never duplicates the descendant.
    const both = await store.listWorkItemTrees({ status: ['backlog'] });
    expect(both.map((n) => n.id).sort()).toEqual([task.id, other.id].sort());
    const taskNode = both.find((n) => n.id === task.id)!;
    expect(taskNode.childNodes[0].childNodes[0].matched).toBe(true);
    expect(taskNode.childNodes[0].childNodes[0].root).toBe(false);
  });

  it('re-parents with moveWorkItem and keeps both sides of the link', async () => {
    const { task, sub, subsub } = await threeLevels();
    const other = await store.createWorkItem({ title: 'Other feature' });
    // Move the middle item (with its child) under an unrelated task.
    const moved = await store.moveWorkItem(sub.id, other.id);
    expect(moved.parent).toBe(other.id);
    expect(moved.notes.at(-1)?.body).toContain('moved');
    expect((await store.getWorkItem(task.id))?.children).toEqual([]);
    expect((await store.getWorkItem(other.id))?.children).toEqual([sub.id]);
    // The subtree came along.
    const tree = await store.getWorkItemTree(other.id);
    expect(tree?.childNodes[0].id).toBe(sub.id);
    expect(tree?.childNodes[0].childNodes[0].id).toBe(subsub.id);
    expect(tree?.subtree).toEqual({ total: 2, done: 0, open: 2 });

    // Promote back to the top level.
    const promoted = await store.moveWorkItem(sub.id, null);
    expect(promoted.parent).toBeNull();
    expect((await store.getWorkItem(other.id))?.children).toEqual([]);
    expect((await store.workItemPath(sub.id))?.depth).toBe(1);

    // A no-op move leaves the item untouched.
    expect((await store.moveWorkItem(sub.id, null)).parent).toBeNull();
  });

  it('rejects cycles and depth overflow when moving', async () => {
    const { task, sub, subsub } = await threeLevels();
    await expect(store.moveWorkItem(task.id, sub.id)).rejects.toThrow(/cycle/);
    await expect(store.moveWorkItem(task.id, subsub.id)).rejects.toThrow(/cycle/);
    await expect(store.moveWorkItem(task.id, task.id)).rejects.toThrow(/own parent/);
    // WI-2 → WI-3 is 2 levels; hanging it under a level-2 item would make 4.
    const otherRoot = await store.createWorkItem({ title: 'Root' });
    const { children: otherSubs } = await store.decomposeWorkItem(otherRoot.id, [{ title: 'Sub' }]);
    await expect(store.moveWorkItem(sub.id, otherSubs[0].id)).rejects.toThrow(/limit 3|limited to 3/);
    await expect(store.moveWorkItem('WI-999', null)).rejects.toThrow(/not found/);
    await expect(store.moveWorkItem(sub.id, 'WI-999')).rejects.toThrow(/parent work item not found/);
  });

  it('creates a subtask directly under a parent, both sides in sync', async () => {
    const parent = await store.createWorkItem({ title: 'Parent', priority: 'P1', tags: ['api'] });
    const child = await store.createWorkItem({ title: 'Child', parent: parent.id });
    expect(child.parent).toBe(parent.id);
    expect(child.priority).toBe('P1'); // inherits from the parent
    expect(child.tags).toEqual(['api']);
    expect((await store.getWorkItem(parent.id))?.children).toEqual([child.id]);
    // The cap applies to direct creation too.
    const grand = await store.createWorkItem({ title: 'Grandchild', parent: child.id });
    await expect(store.createWorkItem({ title: 'Too deep', parent: grand.id })).rejects.toThrow(/limited to 3 levels/);
    await expect(store.createWorkItem({ title: 'Orphan', parent: 'WI-999' })).rejects.toThrow(/parent work item not found/);
  });

  it('offers only work-nature types, and still reads legacy ones', async () => {
    // Bugs, test cases and documents have their own records, so they are not
    // work-item types any more.
    expect(WORKITEM_TYPES).toEqual(['task', 'feature', 'refactor', 'chore', 'research']);
    expect([...LEGACY_WORK_ITEM_TYPES]).toEqual(['test', 'bug', 'docs']);

    // A record written by an older version keeps its type: readable, filterable,
    // and rendered in trees. Nothing is rewritten on read.
    const item = await store.createWorkItem({ title: 'Legacy docs task' });
    const file = path.join(dir, 'workitems', `${item.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.type = 'docs';
    await writeFile(file, JSON.stringify(raw));

    expect((await store.getWorkItem(item.id))?.type).toBe('docs');
    expect((await store.getWorkItemTree(item.id))?.type).toBe('docs');
    const filtered = await store.listWorkItems({ type: 'docs' as never });
    expect(filtered.map((i) => i.id)).toEqual([item.id]);
  });

  it('guards the parent/children links against raw patches', async () => {
    const { task, sub } = await threeLevels();
    await expect(store.updateWorkItem(sub.id, { parent: null })).rejects.toThrow(/moveWorkItem/);
    await expect(store.updateWorkItem(task.id, { children: [] })).rejects.toThrow(/decomposeWorkItem|moveWorkItem/);
    // Re-sending the current values is allowed (idempotent patches must not throw).
    const current = (await store.getWorkItem(sub.id))!;
    const same = await store.updateWorkItem(sub.id, { parent: current.parent, children: current.children });
    expect(same.parent).toBe(task.id);
    // Unrelated fields still update normally.
    const renamed = await store.updateWorkItem(sub.id, { title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');
  });

  it('rolls child progress into the completion verification', async () => {
    const { task, sub } = await threeLevels();
    const before = await store.verificationForWorkItem(task.id);
    expect(before.childrenTotal).toBe(1);
    expect(before.childrenDone).toBe(0);
    expect(before.childrenOpenIds).toEqual([sub.id]);
    const { verification } = await store.completeWorkItem(task.id, { closeLinkedBugs: false });
    expect(verification.childrenOpen).toBe(1);
    expect((await store.getWorkItem(task.id))?.notes.at(-2)?.body).toContain('0/1 child item(s) done');
  });

  it('survives a cycle written directly to disk', async () => {
    const { task, sub } = await threeLevels();
    // Hand-written bad data: WI-1 is its own grandparent.
    const raw = JSON.parse(await readFile(path.join(dir, 'workitems', `${task.id}.json`), 'utf8'));
    raw.parent = sub.id;
    await writeFile(path.join(dir, 'workitems', `${task.id}.json`), JSON.stringify(raw));
    const tree = await store.getWorkItemTree(task.id); // must terminate
    expect(tree?.id).toBe(task.id);
    expect(tree?.childNodes.map((n) => n.id)).toEqual([sub.id]);
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

  it('adds and lists doc comments without bumping the doc version', async () => {
    const doc = await store.createDoc({ title: 'Design', body: 'v1' });
    const c1 = await store.addDocComment(doc.slug, 'first', 'alice');
    const c2 = await store.addDocComment(doc.slug, 'second', 'bob');
    expect(c1.author).toBe('alice');
    const list = await store.listDocComments(doc.slug);
    expect(list.map((c) => c.body)).toEqual(['first', 'second']);
    // Comments live in a separate file and do not change the doc content/version.
    expect((await store.getDoc(doc.slug))?.content).toBe('v1\n');
    expect((await store.getDoc(doc.slug))?.meta.version).toBe(1);
    // A comment on a missing doc errors.
    await expect(store.addDocComment('nope', 'x', 'alice')).rejects.toThrow(/not found/);
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
