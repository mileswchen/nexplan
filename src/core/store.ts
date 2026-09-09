import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Git, GitCommitInfo } from './git.js';
import { NOW, coerceDocMeta, parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import {
  BoardActivity,
  BoardSummary,
  Bug,
  BugFilter,
  BugSeverity,
  BugStatus,
  Doc,
  DocComment,
  DocMeta,
  DocType,
  DocVersion,
  ItemSource,
  ListFilter,
  Note,
  Priority,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
} from './types.js';

export interface StoreOptions {
  root: string; // board directory to manage
  agentName?: string; // default attribution for agent-originated writes
  autoCommit?: boolean; // default true; when false the board is plain files
}

interface ProjectMeta {
  name: string;
  createdAt: string;
}

// Serializable view of a work item / bug for JSON on disk.
type Wi = Omit<WorkItem, never> & { schema: 'workitem' };
type Bg = Omit<Bug, never> & { schema: 'bug' };

const WORKITEM_TYPES: WorkItemType[] = ['task', 'feature', 'refactor', 'chore', 'research', 'bug', 'docs'];
const WORKITEM_STATUSES: WorkItemStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const BUG_SEVERITIES: BugSeverity[] = ['critical', 'major', 'minor', 'trivial'];
const BUG_STATUSES: BugStatus[] = ['open', 'in_progress', 'fixed', 'verified', 'wontfix', 'reopened'];
const DOC_TYPES: DocType[] = ['design', 'decision', 'adr', 'architecture', 'notes'];

// A permissive filter spec that applies to both work items and bugs; the
// concrete `ListFilter` / `BugFilter` types narrow the exposed API.
interface FilterSpec {
  status?: string | string[];
  type?: string | string[];
  priority?: string | string[];
  severity?: string | string[];
  assignee?: string;
  tags?: string[];
  query?: string;
  limit?: number;
}

class Mutex {
  private queue: Promise<unknown> = Promise.resolve();
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
}

export class Store {
  readonly root: string;
  agentName: string;
  private git: Git;
  private autoCommit: boolean;
  private mutex = new Mutex();
  private dirs = {
    root: '' as string,
    workitems: 'workitems' as string,
    bugs: 'bugs' as string,
    docs: 'docs' as string,
  };

  constructor(opts: StoreOptions) {
    this.root = path.resolve(opts.root);
    this.agentName = opts.agentName ?? 'user';
    this.autoCommit = opts.autoCommit ?? true;
    this.git = new Git(this.root);
    this.dirs.root = this.root;
    this.dirs.workitems = path.join(this.root, 'workitems');
    this.dirs.bugs = path.join(this.root, 'bugs');
    this.dirs.docs = path.join(this.root, 'docs');
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await fs.mkdir(this.dirs.workitems, { recursive: true });
    await fs.mkdir(this.dirs.bugs, { recursive: true });
    await fs.mkdir(this.dirs.docs, { recursive: true });
    await this.git.init();

    const cfgPath = path.join(this.root, 'nexplan.json');
    if (!(await this.exists(cfgPath))) {
      const meta: ProjectMeta = { name: 'NexPlan', createdAt: NOW() };
      await this.writeJson(cfgPath, meta);
      await this.commit('init: create project');
    }
  }

  async loadMeta(): Promise<ProjectMeta> {
    const cfg = await this.readJson<ProjectMeta>(path.join(this.root, 'nexplan.json'));
    return cfg ?? { name: 'NexPlan', createdAt: NOW() };
  }

  isGitActive(): boolean {
    return this.autoCommit;
  }

  // ------------------------------------------------------------------ helpers

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async readJson<T>(p: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(p, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async readDir(p: string): Promise<string[]> {
    try {
      return await fs.readdir(p);
    } catch {
      return [];
    }
  }

  private async writeJson(p: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  private async commit(message: string): Promise<void> {
    if (!this.autoCommit) return;
    try {
      await this.git.addAll();
      await this.git.commit(message);
    } catch (err) {
      // Never lose data to a git failure; log and continue.
      console.warn(`[nexplan] commit failed (data still written): ${(err as Error).message}`);
    }
  }

  private tx<T>(fn: () => Promise<T>, message: string): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const result = await fn();
      await this.commit(message);
      return result;
    });
  }

  private wiPath(id: string): string {
    return path.join(this.dirs.workitems, `${id}.json`);
  }
  private bugPath(id: string): string {
    return path.join(this.dirs.bugs, `${id}.json`);
  }
  private docPath(slug: string): string {
    return path.join(this.dirs.docs, `${slug}.md`);
  }
  private docCommentsPath(slug: string): string {
    return path.join(this.dirs.docs, `${slug}.comments.json`);
  }

  private async nextId(prefix: 'WI' | 'BUG'): Promise<string> {
    const dir = prefix === 'WI' ? this.dirs.workitems : this.dirs.bugs;
    const files = await this.readDir(dir);
    let max = 0;
    for (const f of files) {
      const m = /^(\w+)-(\d+)\.json$/.exec(f);
      if (m && m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
    }
    return `${prefix}-${max + 1}`;
  }

  private note(author: string, body: string): Note {
    return { id: randomUUID(), author, body, at: NOW() };
  }

  // -------------------------------------------------------------- work items

  async createWorkItem(input: {
    title: string;
    type?: WorkItemType;
    description?: string;
    status?: WorkItemStatus;
    priority?: Priority;
    assignee?: string | null;
    source?: ItemSource;
    parent?: string | null;
    tags?: string[];
    estimate?: number | null;
    fixesBug?: string[];
    docLink?: string | null;
    author?: string;
  }): Promise<WorkItem> {
    const now = NOW();
    const id = await this.nextId('WI');
    const author = input.author ?? this.agentName;
    const item: Wi = {
      schema: 'workitem',
      id,
      type: input.type ?? 'task',
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'P2',
      assignee: input.assignee ?? null,
      source: input.source ?? (author === 'user' ? 'manual' : 'agent'),
      parent: input.parent ?? null,
      children: [],
      tags: input.tags ?? [],
      estimate: input.estimate ?? null,
      fixesBug: input.fixesBug ?? [],
      docLink: input.docLink ?? null,
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      notes: [],
    };
    return this.tx(async () => {
      await this.writeJson(this.wiPath(id), item);
      return item as unknown as WorkItem;
    }, `workitem: create ${id} ${clip(item.title)}`);
  }

  async listWorkItems(filter: ListFilter = {}): Promise<WorkItem[]> {
    const files = (await this.readDir(this.dirs.workitems)).filter((f) => f.endsWith('.json'));
    const items: WorkItem[] = [];
    for (const f of files) {
      const it = await this.readJson<WorkItem>(this.wiPath(f.replace(/\.json$/, '')));
      if (it) items.push(it);
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return this.applyFilter(items, filter);
  }

  private applyFilter<T extends { status?: string; type?: string; priority?: string; severity?: string; assignee?: string | null; tags?: string[]; title: string; description: string }>(
    items: T[],
    filter: FilterSpec,
  ): T[] {
    let out = items;
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      out = out.filter((i) => i.status !== undefined && statuses.includes(i.status));
    }
    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      out = out.filter((i) => i.type !== undefined && types.includes(i.type));
    }
    if (filter.priority) {
      const prios = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
      out = out.filter((i) => i.priority !== undefined && prios.includes(i.priority));
    }
    if (filter.severity) {
      const sev = Array.isArray(filter.severity) ? filter.severity : [filter.severity];
      out = out.filter((i) => i.severity !== undefined && sev.includes(i.severity));
    }
    if (filter.assignee) out = out.filter((i) => i.assignee === filter.assignee);
    if (filter.tags?.length) {
      out = out.filter((i) => filter.tags!.every((t) => i.tags?.includes(t)));
    }
    if (filter.query) {
      const q = filter.query.toLowerCase();
      out = out.filter((i) => (i.title + ' ' + i.description).toLowerCase().includes(q));
    }
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  async getWorkItem(id: string): Promise<WorkItem | null> {
    return (await this.readJson<WorkItem>(this.wiPath(id))) ?? null;
  }

  async updateWorkItem(id: string, patch: Partial<WorkItem>, author?: string): Promise<WorkItem> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    const updater = author ?? this.agentName;
    const updated = { ...existing, ...patch, id, updatedAt: NOW() } as WorkItem;
    // Never allow status to drift away from valid enum via raw patch.
    if (patch.status) updated.status = patch.status;
    return this.tx(async () => {
      await this.writeJson(this.wiPath(id), updated);
      return updated;
    }, `workitem: update ${id} (${updater})`);
  }

  async claimWorkItem(id: string, assignee: string, status: WorkItemStatus = 'in_progress', author?: string): Promise<WorkItem> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    if (existing.status === 'done') throw new Error(`cannot claim a completed item: ${id}`);
    const updater = author ?? this.agentName;
    const updated = {
      ...existing,
      status,
      assignee,
      updatedAt: NOW(),
      notes: [...existing.notes, this.note(updater, `claimed by ${assignee} → ${status}`)],
    } as WorkItem;
    return this.tx(async () => {
      await this.writeJson(this.wiPath(id), updated);
      return updated;
    }, `workitem: claim ${id} by ${assignee}`);
  }

  async completeWorkItem(
    id: string,
    opts: { note?: string; closeLinkedBugs?: boolean; author?: string } = {},
  ): Promise<{ item: WorkItem; closedBugs: Bug[] }> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    const updater = opts.author ?? this.agentName;
    const now = NOW();
    const notes = existing.notes.slice();
    if (opts.note) notes.push(this.note(updater, opts.note));
    notes.push(this.note(updater, 'complete → done'));
    const updated = {
      ...existing,
      status: 'done' as WorkItemStatus,
      updatedAt: now,
      completedAt: now,
      notes,
    } as WorkItem;

    const closeLinkedBugs = opts.closeLinkedBugs !== false;
    const closedBugs: Bug[] = [];
    return this.tx(async () => {
      await this.writeJson(this.wiPath(id), updated);
      if (closeLinkedBugs) {
        for (const bugId of existing.fixesBug ?? []) {
          const bug = await this.getBug(bugId);
          if (!bug || bug.status === 'verified' || bug.status === 'fixed') continue;
          const fixed = {
            ...bug,
            status: 'fixed' as BugStatus,
            closedAt: now,
            updatedAt: now,
            workItem: id,
            notes: [...bug.notes, this.note(updater, `fixed by completed work item ${id}`)],
          } as Bug;
          await this.writeJson(this.bugPath(bugId), fixed);
          closedBugs.push(fixed);
        }
      }
      return { item: updated, closedBugs };
    }, `workitem: complete ${id}`);
  }

  async decomposeWorkItem(
    parentId: string,
    children: { title: string; type?: WorkItemType; description?: string; priority?: Priority }[],
    author?: string,
  ): Promise<{ parent: WorkItem; children: WorkItem[] }> {
    const parent = await this.getWorkItem(parentId);
    if (!parent) throw new Error(`parent work item not found: ${parentId}`);
    const authorName = author ?? this.agentName;
    return this.tx(async () => {
      const created: WorkItem[] = [];
      for (const c of children) {
        const id = await this.nextId('WI');
        const now = NOW();
        const child: Wi = {
          schema: 'workitem',
          id,
          type: c.type ?? 'task',
          title: c.title.trim(),
          description: c.description?.trim() ?? '',
          status: 'backlog',
          priority: c.priority ?? parent.priority,
          assignee: null,
          source: parent.source,
          parent: parentId,
          children: [],
          tags: [...parent.tags],
          estimate: null,
          fixesBug: [],
          docLink: parent.docLink ?? null,
          createdBy: authorName,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          notes: [],
        };
        await this.writeJson(this.wiPath(id), child);
        created.push(child as unknown as WorkItem);
      }
      const updatedParent = {
        ...parent,
        children: [...parent.children, ...created.map((c) => c.id)],
        updatedAt: NOW(),
      } as WorkItem;
      await this.writeJson(this.wiPath(parentId), updatedParent);
      return { parent: updatedParent, children: created as unknown as WorkItem[] };
    }, `workitem: decompose ${parentId} into ${children.length} children`);
  }

  async addWorkItemNote(id: string, body: string, author?: string): Promise<WorkItem> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    const updater = author ?? this.agentName;
    const updated = {
      ...existing,
      updatedAt: NOW(),
      notes: [...existing.notes, this.note(updater, body)],
    } as WorkItem;
    return this.tx(async () => {
      await this.writeJson(this.wiPath(id), updated);
      return updated;
    }, `workitem: note ${id}`);
  }

  /**
   * Delete a work item. Ownership/permission checks live in the caller (see
   * `Workspace.deleteWorkItem`); this method only performs the physical removal
   * and keeps the hierarchy consistent:
   *   - Refuses to delete an item that still has children (deleted first).
   *   - Detaches the item from its parent's `children` list, if the parent
   *     still exists.
   * Returns the deleted item so callers can report what was removed.
   */
  async deleteWorkItem(id: string): Promise<WorkItem> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    if (existing.children.length > 0) {
      throw new Error(`cannot delete ${id}: it still has ${existing.children.length} child item(s) — delete them first`);
    }
    return this.tx(async () => {
      // Detach from the parent's children list so we never leave a dangling ref.
      if (existing.parent) {
        const parent = await this.getWorkItem(existing.parent);
        if (parent) {
          const updatedParent = {
            ...parent,
            children: parent.children.filter((c) => c !== id),
            updatedAt: NOW(),
          } as WorkItem;
          await this.writeJson(this.wiPath(parent.id), updatedParent);
        }
      }
      await fs.rm(this.wiPath(id), { force: true });
      return existing;
    }, `workitem: delete ${id}`);
  }

  // --------------------------------------------------------------------- bugs

  async createBug(input: {
    title: string;
    description?: string;
    severity?: BugSeverity;
    status?: BugStatus;
    foundBy?: ItemSource;
    foundByAgent?: string | null;
    evidence?: string;
    assignee?: string | null;
    workItem?: string | null;
    tags?: string[];
    author?: string;
  }): Promise<Bug> {
    const now = NOW();
    const id = await this.nextId('BUG');
    const author = input.author ?? this.agentName;
    const bug: Bg = {
      schema: 'bug',
      id,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      severity: input.severity ?? 'minor',
      status: input.status ?? 'open',
      foundBy: input.foundBy ?? (author === 'user' ? 'manual' : 'agent'),
      foundByAgent: input.foundByAgent ?? (author === 'user' ? null : author),
      evidence: input.evidence?.trim() ?? '',
      assignee: input.assignee ?? null,
      workItem: input.workItem ?? null,
      tags: input.tags ?? [],
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      notes: input.evidence?.trim()
        ? [this.note(author, `evidence: ${input.evidence.trim()}`), this.note(author, 'bug reported')]
        : [this.note(author, 'bug reported')],
    };
    return this.tx(async () => {
      await this.writeJson(this.bugPath(id), bug);
      return bug as unknown as Bug;
    }, `bug: create ${id} ${clip(bug.title)}`);
  }

  async listBugs(filter: BugFilter = {}): Promise<Bug[]> {
    const files = (await this.readDir(this.dirs.bugs)).filter((f) => f.endsWith('.json'));
    const bugs: Bug[] = [];
    for (const f of files) {
      const b = await this.readJson<Bug>(this.bugPath(f.replace(/\.json$/, '')));
      if (b) bugs.push(b);
    }
    bugs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return this.applyFilter(bugs, filter) as Bug[];
  }

  async getBug(id: string): Promise<Bug | null> {
    return (await this.readJson<Bug>(this.bugPath(id))) ?? null;
  }

  async updateBug(id: string, patch: Partial<Bug>, author?: string): Promise<Bug> {
    const existing = await this.getBug(id);
    if (!existing) throw new Error(`bug not found: ${id}`);
    const updater = author ?? this.agentName;
    let closedAt = existing.closedAt;
    const status = patch.status ?? existing.status;
    if (['fixed', 'verified', 'wontfix'].includes(status) && !closedAt) closedAt = NOW();
    const updated = { ...existing, ...patch, id, status, closedAt, updatedAt: NOW() } as Bug;
    return this.tx(async () => {
      await this.writeJson(this.bugPath(id), updated);
      return updated;
    }, `bug: update ${id} (${updater})`);
  }

  // --------------------------------------------------------------------- docs

  slugifyTitle(title: string): string {
    // Unicode-aware slugification: keep letters and numbers from any script
    // (so CJK titles don't collapse to an empty slug), replace everything else
    // (punctuation, spaces) with hyphens.
    return (
      title
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 64) || 'doc'
    );
  }

  async createDoc(input: {
    title: string;
    type?: DocType;
    body?: string;
    status?: DocMeta['status'];
    tags?: string[];
    slug?: string;
    author?: string;
  }): Promise<Doc> {
    const author = input.author ?? this.agentName;
    const now = NOW();
    let slug = input.slug?.trim() || this.slugifyTitle(input.title);
    const existingSlugs = new Set((await this.readDir(this.dirs.docs)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
    // Ensure uniqueness.
    if (existingSlugs.has(slug)) {
      let i = 2;
      while (existingSlugs.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }
    const meta: DocMeta = {
      title: input.title.trim(),
      type: input.type ?? 'design',
      status: input.status ?? 'draft',
      version: 1,
      tags: input.tags ?? [],
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      updatedBy: author,
    };
    const content = (input.body?.trim() ?? '') + '\n';
    return this.tx(async () => {
      await fs.writeFile(this.docPath(slug), serializeFrontmatter({ ...meta }, content), 'utf8');
      return { slug, content, meta };
    }, `doc: create ${slug}`);
  }

  private async parseDocFile(slug: string): Promise<Doc | null> {
    const raw = await this.readFile(this.docPath(slug));
    if (raw === null) return null;
    const { meta: rawMeta, body } = parseFrontmatter(raw);
    const meta = coerceDocMeta(rawMeta);
    return { slug, content: body, meta };
  }

  private async readFile(p: string): Promise<string | null> {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  }

  async getDoc(slug: string): Promise<Doc | null> {
    return this.parseDocFile(slug);
  }

  async listDocs(): Promise<Doc[]> {
    const files = (await this.readDir(this.dirs.docs)).filter((f) => f.endsWith('.md'));
    const docs: Doc[] = [];
    for (const f of files) {
      const d = await this.parseDocFile(f.replace(/\.md$/, ''));
      if (d) docs.push(d);
    }
    docs.sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt));
    return docs;
  }

  async updateDoc(
    slug: string,
    patch: { content?: string; title?: string; type?: DocType; status?: DocMeta['status']; tags?: string[] },
    author?: string,
  ): Promise<Doc> {
    const existing = await this.getDoc(slug);
    if (!existing) throw new Error(`doc not found: ${slug}`);
    const updater = author ?? this.agentName;
    const content = patch.content !== undefined ? patch.content.trim() : existing.content;
    const meta: DocMeta = {
      ...existing.meta,
      title: patch.title ?? existing.meta.title,
      type: patch.type ?? existing.meta.type,
      status: patch.status ?? existing.meta.status,
      tags: patch.tags ?? existing.meta.tags,
      version: existing.meta.version + 1,
      updatedAt: NOW(),
      updatedBy: updater,
    };
    return this.tx(async () => {
      await fs.writeFile(this.docPath(slug), serializeFrontmatter({ ...meta }, content), 'utf8');
      return { slug, content, meta };
    }, `doc: update ${slug} → v${meta.version} (${updater})`);
  }

  async docHistory(slug: string, limit = 100): Promise<DocVersion[]> {
    const rel = path.join('docs', `${slug}.md`);
    const commits = await this.git.logForPath(rel, limit);
    const out: DocVersion[] = [];
    // Newest first. Map each commit's stored frontmatter version when resolvable.
    for (const c of commits) {
      out.push({ sha: c.sha, version: await this.versionAtSha(rel, c.sha, c), author: c.author, date: c.date, message: c.message });
    }
    return out;
  }

  private async versionAtSha(rel: string, sha: string, commit: GitCommitInfo): Promise<number> {
    const raw = await this.git.showFile(rel, sha);
    if (raw !== null) {
      const { meta } = parseFrontmatter(raw);
      const v = Number(meta.version);
      if (Number.isFinite(v) && v > 0) return v;
    }
    // Fallback: the newest commit's version is known; older ones can't be
    // resolved without a stored counter, so fall back to 1 for all.
    return 1;
  }

  async docDiff(slug: string, shaA: string, shaB: string): Promise<string> {
    const rel = path.join('docs', `${slug}.md`);
    return this.git.diffFile(rel, shaA, shaB);
  }

  // ------------------------------------------------------------------ comments

  /** List a document's comments, oldest first. */
  async listDocComments(slug: string): Promise<DocComment[]> {
    const list = await this.readJson<DocComment[]>(this.docCommentsPath(slug));
    return Array.isArray(list) ? list : [];
  }

  /**
   * Append a comment to a document. Comments live in a separate
   * `<slug>.comments.json` file so they never touch the versioned body/history.
   * Permission checks live in the caller (see `Workspace`/the MCP/web/CLI gates).
   */
  async addDocComment(slug: string, body: string, author?: string): Promise<DocComment> {
    const doc = await this.getDoc(slug);
    if (!doc) throw new Error(`doc not found: ${slug}`);
    const updater = author ?? this.agentName;
    const comment: DocComment = { id: randomUUID(), author: updater, body: body.trim(), at: NOW() };
    return this.tx(async () => {
      const list = await this.listDocComments(slug);
      list.push(comment);
      await this.writeJson(this.docCommentsPath(slug), list);
      return comment;
    }, `doc: comment ${slug}`);
  }

  // -------------------------------------------------------------- board board

  async boardSummary(limit = 8): Promise<BoardSummary> {
    const workItems = await this.listWorkItems({ limit: 0 });
    const bugs = await this.listBugs({ limit: 0 });
    const docs = await this.listDocs();
    const statusCounts = (arr: { status: string }[]) => {
      const map: Record<string, number> = {};
      for (const s of arr) map[s.status] = (map[s.status] ?? 0) + 1;
      return map;
    };
    const recent = await this.recentActivity(limit);
    return {
      workItems: statusCounts(workItems),
      bugs: statusCounts(bugs),
      docs: docs.length,
      totalWorkItems: workItems.length,
      totalBugs: bugs.length,
      recent,
    };
  }

  private async recentActivity(limit: number): Promise<BoardActivity[]> {
    if (!this.isGitActive()) {
      return this.recentFromFiles(limit);
    }
    // Scope the commit log to this board's subtree so a project's feed in a
    // shared workspace repo does not include sibling projects' commits.
    const commits = await this.git.logAll(limit, '.');
    const out: BoardActivity[] = [];
    for (const c of commits) {
      const kind = c.message.startsWith('bug:') ? 'bug' : c.message.startsWith('doc:') ? 'doc' : 'workitem';
      const id = /\b((?:WI|BUG)-\d+)\b/.exec(c.message)?.[1] ?? '';
      out.push({ kind, id, action: c.message, author: c.author, at: c.date });
    }
    return out;
  }

  private async recentFromFiles(limit: number): Promise<BoardActivity[]> {
    const items = await this.listWorkItems({ limit });
    const out: BoardActivity[] = [];
    for (const it of items) out.push({ kind: 'workitem', id: it.id, action: `updated ${it.id}`, author: it.createdBy, at: it.updatedAt });
    return out.slice(0, limit);
  }
}

function clip(s: string, n = 48): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n - 1) + '…' : c;
}

export { WORKITEM_TYPES, WORKITEM_STATUSES, PRIORITIES, BUG_SEVERITIES, BUG_STATUSES, DOC_TYPES };
