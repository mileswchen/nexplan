import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Git, GitCommitInfo } from './git.js';
import {
  bundleName,
  filterBundle,
  mergeBundle,
  parseBundle,
  selectArchivable,
  summarizeBundle,
} from './archive.js';
import { NOW, coerceDocMeta, parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import {
  ArchiveBundleInfo,
  ArchivePolicy,
  ArchiveResult,
  ArchiveStatus,
  ArchiveSummary,
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
  RecordRunResult,
  TestCase,
  TestCaseFilter,
  TestCaseStatus,
  TestCaseType,
  TestCaseWithStatus,
  TestPolicy,
  TestReport,
  TestReportFilter,
  TestResult,
  TestRun,
  TestRunFilter,
  TestStep,
  DEFAULT_ARCHIVE_POLICY,
  WorkItem,
  WorkItemStatus,
  WorkItemType,
  WorkItemVerification,
} from './types.js';

export interface StoreOptions {
  root: string; // board directory to manage
  agentName?: string; // default attribution for agent-originated writes
  autoCommit?: boolean; // default true; when false the board is plain files
  /** Effective test policy provider (injected by Workspace; workspace + project). */
  testPolicy?: () => Promise<TestPolicy>;
}

interface ProjectMeta {
  name: string;
  createdAt: string;
}

/**
 * Persisted id counters + archive bookkeeping for one project
 * (`<project>/.counters.json`). Kept in git so id allocation survives
 * deletion/archiving of the highest-numbered record — see §13.6 of the design
 * doc: scanning the directory for `max + 1` would reuse ids once records are
 * removed, silently repointing references (bug.workItem, case.workItem, …).
 */
interface Counters {
  WI?: number;
  BUG?: number;
  TC?: number;
  TR?: number;
  /** Number of runs moved out of the hot directory into archive bundles. */
  TR_ARCHIVED?: number;
  /** Earliest `executedAt` among hot runs (O(1) archive time gate). */
  oldestHotAt?: string | null;
  lastEvalAt?: string | null;
  lastArchiveAt?: string | null;
}

type CounterKey = 'WI' | 'BUG' | 'TC' | 'TR';

// Serializable view of a work item / bug / test record for JSON on disk.
type Wi = Omit<WorkItem, never> & { schema: 'workitem' };
type Bg = Omit<Bug, never> & { schema: 'bug' };
type Tc = Omit<TestCase, never> & { schema: 'testcase' };
type Tr = Omit<TestRun, never> & { schema: 'testrun' };

const WORKITEM_TYPES: WorkItemType[] = ['task', 'feature', 'refactor', 'chore', 'research', 'test', 'bug', 'docs'];
const WORKITEM_STATUSES: WorkItemStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const BUG_SEVERITIES: BugSeverity[] = ['critical', 'major', 'minor', 'trivial'];
const BUG_STATUSES: BugStatus[] = ['open', 'in_progress', 'fixed', 'verified', 'wontfix', 'reopened'];
const DOC_TYPES: DocType[] = ['design', 'decision', 'adr', 'architecture', 'notes'];
const TESTCASE_TYPES: TestCaseType[] = [
  'functional',
  'regression',
  'integration',
  'e2e',
  'performance',
  'security',
  'usability',
  'other',
];
const TESTCASE_STATUSES: TestCaseStatus[] = ['draft', 'active', 'deprecated'];
const TEST_RESULTS: TestResult[] = ['pass', 'fail', 'blocked', 'skipped'];

/** Test case priority → bug severity, used when a failing run files a bug. */
const PRIORITY_TO_SEVERITY: Record<Priority, BugSeverity> = {
  P0: 'critical',
  P1: 'major',
  P2: 'minor',
  P3: 'trivial',
};


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
  private testPolicyProvider?: () => Promise<TestPolicy>;
  private mutex = new Mutex();
  private dirs = {
    root: '' as string,
    workitems: 'workitems' as string,
    bugs: 'bugs' as string,
    docs: 'docs' as string,
    testcases: 'testcases' as string,
    testruns: 'testruns' as string,
    testrunsArchive: 'testruns/archive' as string,
  };

  constructor(opts: StoreOptions) {
    this.root = path.resolve(opts.root);
    this.agentName = opts.agentName ?? 'user';
    this.autoCommit = opts.autoCommit ?? true;
    this.git = new Git(this.root);
    this.testPolicyProvider = opts.testPolicy;
    this.dirs.root = this.root;
    this.dirs.workitems = path.join(this.root, 'workitems');
    this.dirs.bugs = path.join(this.root, 'bugs');
    this.dirs.docs = path.join(this.root, 'docs');
    this.dirs.testcases = path.join(this.root, 'testcases');
    this.dirs.testruns = path.join(this.root, 'testruns');
    this.dirs.testrunsArchive = path.join(this.dirs.testruns, 'archive');
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await fs.mkdir(this.dirs.workitems, { recursive: true });
    await fs.mkdir(this.dirs.bugs, { recursive: true });
    await fs.mkdir(this.dirs.docs, { recursive: true });
    await fs.mkdir(this.dirs.testcases, { recursive: true });
    await fs.mkdir(this.dirs.testruns, { recursive: true });
    await fs.mkdir(this.dirs.testrunsArchive, { recursive: true });
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

  /**
   * Run a mutation under the store mutex and commit it. The message may be a
   * factory so id allocation can happen inside the critical section (ids are
   * read-modify-write on `.counters.json` and must not race).
   */
  private tx<T>(fn: () => Promise<T>, message: string | ((result: T) => string)): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const result = await fn();
      await this.commit(typeof message === 'function' ? message(result) : message);
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
  private testCasePath(id: string): string {
    return path.join(this.dirs.testcases, `${id}.json`);
  }
  private testRunPath(id: string): string {
    return path.join(this.dirs.testruns, `${id}.json`);
  }
  private countersPath(): string {
    return path.join(this.root, '.counters.json');
  }

  // ------------------------------------------------------------- id counters

  async readCounters(): Promise<Counters> {
    return (await this.readJson<Counters>(this.countersPath())) ?? {};
  }

  private async writeCounters(counters: Counters): Promise<void> {
    await this.writeJson(this.countersPath(), counters);
  }

  /** Merge a patch into `.counters.json`. Callers inside `tx()` get it committed. */
  async patchCounters(patch: Partial<Counters>): Promise<Counters> {
    const next = { ...(await this.readCounters()), ...patch };
    await this.writeCounters(next);
    return next;
  }

  /** Highest existing id for a prefix, by scanning the data directory (legacy fallback). */
  private async scanMaxId(prefix: CounterKey): Promise<number> {
    const dir =
      prefix === 'WI'
        ? this.dirs.workitems
        : prefix === 'BUG'
          ? this.dirs.bugs
          : prefix === 'TC'
            ? this.dirs.testcases
            : this.dirs.testruns;
    const files = await this.readDir(dir);
    let max = 0;
    for (const f of files) {
      const m = /^(\w+)-(\d+)\.json$/.exec(f);
      if (m && m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
    }
    return max;
  }

  /**
   * Allocate the next id for a prefix. Prefers the persisted counter so ids are
   * never reused after a record is deleted or archived; falls back to scanning
   * the directory for workspaces created before counters existed.
   */
  private async nextId(prefix: CounterKey): Promise<string> {
    const counters = await this.readCounters();
    const known = counters[prefix];
    const max = typeof known === 'number' && Number.isFinite(known) ? known : await this.scanMaxId(prefix);
    const next = max + 1;
    counters[prefix] = next;
    await this.writeCounters(counters);
    return `${prefix}-${next}`;
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
    const author = input.author ?? this.agentName;
    return this.tx(async () => {
      const now = NOW();
      const id = await this.nextId('WI');
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
      await this.writeJson(this.wiPath(id), item);
      return item as unknown as WorkItem;
    }, (item) => `workitem: create ${item.id} ${clip(item.title)}`);
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
    opts: { note?: string; closeLinkedBugs?: boolean; author?: string; force?: boolean } = {},
  ): Promise<{ item: WorkItem; closedBugs: Bug[]; verification: WorkItemVerification }> {
    const existing = await this.getWorkItem(id);
    if (!existing) throw new Error(`work item not found: ${id}`);
    const updater = opts.author ?? this.agentName;
    const now = NOW();
    const verification = await this.verificationForWorkItem(id);
    const notes = existing.notes.slice();
    if (opts.note) notes.push(this.note(updater, opts.note));
    if (verification.fail > 0 && !opts.force) {
      notes.push(
        this.note(
          updater,
          `tests: ${verification.fail} of ${verification.cases} linked case(s) failing — ${verification.failing.join(', ')}`,
        ),
      );
    }
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
      return { item: updated, closedBugs, verification };
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
    return this.tx(
      () => this.createBugInner(input),
      (bug) => `bug: create ${bug.id} ${clip(bug.title)}`,
    );
  }

  /** Non-transactional core so run recording can file bugs inside its own tx. */
  private async createBugInner(input: {
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
    testCase?: string | null;
    testRun?: string | null;
  }): Promise<Bug> {
    const author = input.author ?? this.agentName;
    const now = NOW();
    const id = await this.nextId('BUG');
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
      testCase: input.testCase ?? null,
      testRun: input.testRun ?? null,
      notes: input.evidence?.trim()
        ? [this.note(author, `evidence: ${input.evidence.trim()}`), this.note(author, 'bug reported')]
        : [this.note(author, 'bug reported')],
    };
    await this.writeJson(this.bugPath(id), bug);
    return bug as unknown as Bug;
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
    const updater = author ?? this.agentName;
    return this.tx(() => this.updateBugInner(id, patch, updater), `bug: update ${id} (${updater})`);
  }

  /** Non-transactional core so run recording can advance bugs inside its own tx. */
  private async updateBugInner(id: string, patch: Partial<Bug>, author?: string): Promise<Bug> {
    const existing = await this.getBug(id);
    if (!existing) throw new Error(`bug not found: ${id}`);
    const updater = author ?? this.agentName;
    let closedAt = existing.closedAt;
    const status = patch.status ?? existing.status;
    if (['fixed', 'verified', 'wontfix'].includes(status) && !closedAt) closedAt = NOW();
    if (status === 'reopened') closedAt = null;
    const updated = { ...existing, ...patch, id, status, closedAt, updatedAt: NOW() } as Bug;
    await this.writeJson(this.bugPath(id), updated);
    return updated;
  }

  // -------------------------------------------------------------- test cases

  async createTestCase(input: {
    title: string;
    description?: string;
    type?: TestCaseType;
    priority?: Priority;
    status?: TestCaseStatus;
    preconditions?: string;
    steps?: TestStep[];
    tags?: string[];
    workItem?: string | null;
    bugs?: string[];
    automated?: boolean;
    testFile?: string | null;
    author?: string;
  }): Promise<TestCase> {
    return this.tx(
      () => this.createTestCaseInner(input),
      (tc) => `testcase: create ${tc.id} ${clip(tc.title)}`,
    );
  }

  /** Non-transactional core (run recording may auto-create a case inside its tx). */
  private async createTestCaseInner(input: {
    title: string;
    description?: string;
    type?: TestCaseType;
    priority?: Priority;
    status?: TestCaseStatus;
    preconditions?: string;
    steps?: TestStep[];
    tags?: string[];
    workItem?: string | null;
    bugs?: string[];
    automated?: boolean;
    testFile?: string | null;
    author?: string;
  }): Promise<TestCase> {
    const author = input.author ?? this.agentName;
    const now = NOW();
    const id = await this.nextId('TC');
    const tc: Tc = {
      schema: 'testcase',
      id,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      type: input.type ?? 'functional',
      priority: input.priority ?? 'P2',
      status: input.status ?? 'draft',
      preconditions: input.preconditions?.trim() ?? '',
      steps: (input.steps ?? []).map((s) => ({ action: s.action ?? '', expected: s.expected ?? '' })),
      tags: input.tags ?? [],
      workItem: input.workItem ?? null,
      bugs: input.bugs ?? [],
      automated: input.automated ?? false,
      testFile: input.testFile ?? null,
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      notes: [],
    };
    await this.writeJson(this.testCasePath(id), tc);
    return tc as unknown as TestCase;
  }

  /**
   * List cases with derived run statistics. The latest-result scan reads hot run
   * files newest-id-first and stops as soon as every case is resolved, so the
   * common list/badge path stays O(cases) instead of O(runs).
   */
  async listTestCases(
    filter: TestCaseFilter = {},
    opts: { withLastRun?: boolean; withRunCount?: boolean; includeArchived?: boolean } = {},
  ): Promise<TestCaseWithStatus[]> {
    const files = (await this.readDir(this.dirs.testcases)).filter((f) => f.endsWith('.json'));
    const cases: TestCase[] = [];
    for (const f of files) {
      const tc = await this.readJson<TestCase>(this.testCasePath(f.replace(/\.json$/, '')));
      if (tc) cases.push(tc);
    }
    const withLastRun = opts.withLastRun !== false;
    const stats = withLastRun
      ? await this.collectRunStats(new Set(cases.map((c) => c.id)), {
          includeArchived: opts.includeArchived !== false,
          countAll: opts.withRunCount === true,
        })
      : new Map<string, { last: TestRun | null; count: number | null }>();

    let out: TestCaseWithStatus[] = cases.map((c) => {
      const st = stats.get(c.id);
      return {
        ...c,
        lastResult: st?.last ? st.last.result : null,
        lastRunAt: st?.last ? st.last.executedAt : null,
        lastBuild: st?.last ? st.last.build : null,
        runCount: opts.withRunCount ? (st?.count ?? 0) : null,
      };
    });

    out = out.filter((c) => matchesTestCaseFilter(c, filter));
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (filter.limit) out = out.slice(0, filter.limit);
    return out;
  }

  async getTestCase(id: string): Promise<TestCase | null> {
    return (await this.readJson<TestCase>(this.testCasePath(id))) ?? null;
  }

  async updateTestCase(
    id: string,
    patch: Partial<TestCase>,
    author?: string,
  ): Promise<TestCase> {
    const updater = author ?? this.agentName;
    return this.tx(
      () => this.updateTestCaseInner(id, patch, updater),
      `testcase: update ${id} (${updater})`,
    );
  }

  private async updateTestCaseInner(id: string, patch: Partial<TestCase>, author?: string): Promise<TestCase> {
    const existing = await this.getTestCase(id);
    if (!existing) throw new Error(`test case not found: ${id}`);
    const updated = { ...existing, ...patch, id, updatedAt: NOW() } as TestCase;
    await this.writeJson(this.testCasePath(id), updated);
    return updated;
  }

  /**
   * Delete a test case. Refuses while execution records exist unless `force`,
   * which removes the case's hot runs too (bug provenance fields are left as
   * historical record).
   */
  async deleteTestCase(id: string, opts: { force?: boolean } = {}): Promise<{ deleted: TestCase; deletedRuns: number }> {
    const existing = await this.getTestCase(id);
    if (!existing) throw new Error(`test case not found: ${id}`);
    const runIds = (await this.listTestRuns({ caseId: id, includeArchived: false })).map((r) => r.id);
    const archived = (await this.readArchivedRuns(id)).length;
    const totalRuns = runIds.length + archived;
    if (totalRuns > 0 && !opts.force) {
      throw new Error(
        `cannot delete ${id}: it still has ${totalRuns} execution record(s) — use force to delete them too`,
      );
    }
    return this.tx(async () => {
      let deletedRuns = 0;
      for (const runId of runIds) {
        await fs.rm(this.testRunPath(runId), { force: true });
        deletedRuns++;
      }
      if (archived > 0) deletedRuns += await this.removeArchivedRuns((r) => r.caseId === id);
      await fs.rm(this.testCasePath(id), { force: true });
      return { deleted: existing, deletedRuns };
    }, `testcase: delete ${id}`);
  }

  // --------------------------------------------------------------- test runs

  async recordTestRun(input: RecordTestRunInput): Promise<RecordRunResult> {
    const result = await this.tx(() => this.recordTestRunInner(input), (res) => {
      const extra = res.createdBugs.length ? ` +${res.createdBugs.map((b) => b.id).join(',')}` : '';
      return `test: run ${res.run.id} ${res.run.caseId} ${res.run.result} (${res.run.executedBy})${extra}`;
    });
    await this.runAutoArchive();
    return result;
  }

  /**
   * Post-write archive check. Failures are swallowed on purpose: archiving is an
   * optimization, never a correctness dependency (design §13.1 I6).
   */
  private async runAutoArchive(): Promise<void> {
    try {
      await this.archiveIfNeeded();
    } catch (err) {
      console.warn(`[nexplan] archive check failed (data untouched): ${(err as Error).message}`);
    }
  }

  /**
   * Record many runs in ONE commit (agents report a whole suite at once).
   * Every run still gets its own file; only the git commit is shared.
   */
  async recordTestRuns(inputs: RecordTestRunInput[]): Promise<RecordRunResult[]> {
    if (!inputs.length) return [];
    const results = await this.tx(
      async () => {
        const out: RecordRunResult[] = [];
        for (const input of inputs) out.push(await this.recordTestRunInner(input));
        return out;
      },
      (results) => {
        const counts = results.reduce<Record<string, number>>((acc, r) => {
          acc[r.run.result] = (acc[r.run.result] ?? 0) + 1;
          return acc;
        }, {});
        const summary = Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join('/');
        const bugs = [...new Set(results.flatMap((r) => r.createdBugs.map((b) => b.id)))];
        const first = results[0]?.run.id ?? '';
        const last = results[results.length - 1]?.run.id ?? '';
        return `test: run ${first}..${last} (${results.length}) ${summary}${bugs.length ? ` +${bugs.join(',')}` : ''}`;
      },
    );
    await this.runAutoArchive();
    return results;
  }

  /** Non-transactional core: one run plus every side effect lands in one commit. */
  private async recordTestRunInner(input: RecordTestRunInput): Promise<RecordRunResult> {
    const author = input.author ?? this.agentName;
    const now = NOW();

    // --- resolve (or auto-create) the test case -----------------------------
    let testCase: TestCase | null = null;
    if (input.caseId) {
      testCase = await this.getTestCase(input.caseId);
      if (!testCase) throw new Error(`test case not found: ${input.caseId}`);
    } else if (input.caseTitle?.trim()) {
      const title = input.caseTitle.trim();
      const all = (await this.listTestCases({}, { withLastRun: false })) as unknown as TestCase[];
      const matches = all.filter((c) => c.title.toLowerCase() === title.toLowerCase());
      testCase =
        matches.find((c) => c.status === 'active') ??
        matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
        null;
      if (!testCase) {
        if (input.autoCreateCase === false) throw new Error(`test case not found by title: ${title}`);
        testCase = await this.createTestCaseInner({ title, status: 'active', author });
      }
    } else {
      throw new Error('recordTestRun requires caseId or caseTitle');
    }

    // --- create the run record (snapshot fields are frozen here) -------------
    const runId = await this.nextId('TR');
    const executedAt = input.executedAt ?? now;
    const run: Tr = {
      schema: 'testrun',
      id: runId,
      caseId: testCase.id,
      caseTitle: testCase.title,
      workItem: testCase.workItem ?? null,
      result: input.result,
      actual: input.actual?.trim() ?? '',
      evidence: input.evidence?.trim() ?? '',
      environment: input.environment?.trim() ?? '',
      build: input.build?.trim() ?? '',
      batch: input.batch?.trim() ?? '',
      durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
      bugIds: [],
      executedBy: author,
      executedAt,
      notes: [],
    };

    const where = [run.build && `build ${run.build}`, run.environment && `env ${run.environment}`]
      .filter(Boolean)
      .join(', ');
    const linked = await this.linkedBugsForCase(testCase);
    const createdBugs: Bug[] = [];
    const updatedBugs: Bug[] = [];

    // --- R2: file a bug on failure (deduplicated) ---------------------------
    if (run.result === 'fail' && input.createBugOnFailure) {
      const alreadyOpen = linked.find((b) => b.status === 'open' || b.status === 'reopened');
      if (alreadyOpen) {
        updatedBugs.push(
          await this.updateBugInner(
            alreadyOpen.id,
            {
              testRun: run.id,
              notes: [
                ...alreadyOpen.notes,
                this.note(author, `${run.id} failed again${where ? ` (${where})` : ''}: ${clip(run.actual || run.evidence || run.caseTitle, 160)}`),
              ],
            },
            author,
          ),
        );
      } else {
        const evidence = [run.actual && `actual: ${run.actual}`, run.evidence, where && `(${where})`]
          .filter(Boolean)
          .join('\n');
        createdBugs.push(
          await this.createBugInner({
            title: `[${testCase.id}] ${testCase.title} failed`,
            description: `Failing test case ${testCase.id}${run.batch ? ` in batch "${run.batch}"` : ''}.`,
            severity: PRIORITY_TO_SEVERITY[testCase.priority] ?? 'minor',
            evidence,
            workItem: testCase.workItem ?? null,
            tags: [...new Set([...testCase.tags, 'from-test'])],
            author,
            testCase: testCase.id,
            testRun: run.id,
          }),
        );
      }
    }

    // --- R3: advance / regress the bugs this case guards --------------------
    for (const bug of linked) {
      if (run.result === 'pass') {
        if (bug.status === 'open' || bug.status === 'reopened') {
          updatedBugs.push(
            await this.updateBugInner(
              bug.id,
              {
                status: 'fixed',
                notes: [...bug.notes, this.note(author, `${run.id} passed (${testCase.id}${where ? `, ${where}` : ''}) → fixed`)],
              },
              author,
            ),
          );
        } else if (bug.status === 'fixed' && input.verifyBugs) {
          updatedBugs.push(
            await this.updateBugInner(
              bug.id,
              {
                status: 'verified',
                notes: [...bug.notes, this.note(author, `${run.id} passed (${testCase.id}${where ? `, ${where}` : ''}) → verified`)],
              },
              author,
            ),
          );
        }
      } else if (run.result === 'fail' && (bug.status === 'fixed' || bug.status === 'verified')) {
        updatedBugs.push(
          await this.updateBugInner(
            bug.id,
            {
              status: 'reopened',
              notes: [
                ...bug.notes,
                this.note(author, `${run.id} failed (${testCase.id}${where ? `, ${where}` : ''}) → reopened: ${clip(run.actual || run.evidence, 160)}`),
              ],
            },
            author,
          ),
        );
      }
    }

    run.bugIds = [...new Set([...createdBugs.map((b) => b.id), ...updatedBugs.map((b) => b.id)])];
    await this.writeJson(this.testRunPath(run.id), run);

    // Keep the case's note trail (and updatedAt) in step with its runs.
    const updatedCase = await this.updateTestCaseInner(
      testCase.id,
      {
        notes: [
          ...testCase.notes,
          this.note(author, `${run.id} ${run.result}${where ? ` (${where})` : ''}`),
        ],
      },
      author,
    );

    // O(1) archive time gate bookkeeping (see design §13.3).
    const counters = await this.readCounters();
    const oldest = counters.oldestHotAt ?? null;
    if (!oldest || executedAt < oldest) counters.oldestHotAt = executedAt;
    await this.writeCounters(counters);

    return { run: run as unknown as TestRun, testCase: updatedCase, createdBugs, updatedBugs };
  }

  /**
   * List runs, hot and (by default) archived merged. A plain "newest N" query
   * reads only N hot files; filtered queries scan the hot directory.
   */
  async listTestRuns(filter: TestRunFilter = {}): Promise<TestRun[]> {
    const includeArchived = filter.includeArchived !== false;
    const filtered = Boolean(
      filter.caseId ||
        filter.result ||
        filter.build ||
        filter.batch ||
        filter.environment ||
        filter.workItem ||
        filter.executedBy ||
        filter.since ||
        filter.until,
    );
    const out: TestRun[] = [];
    const fastPath = !filtered && typeof filter.limit === 'number' && filter.limit > 0;

    for (const runId of await this.hotRunIdsDesc()) {
      const run = await this.getTestRun(runId);
      if (!run) continue;
      if (fastPath) {
        out.push(run);
        if (out.length >= (filter.limit as number)) break;
      } else if (matchesRunFilter(run, filter)) {
        out.push(run);
      }
    }

    if (includeArchived) {
      for (const run of await this.readArchivedRuns(filter.caseId)) {
        if (matchesRunFilter(run, filter)) out.push(run);
      }
    }

    out.sort(compareRunsDesc);
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  async getTestRun(id: string): Promise<TestRun | null> {
    return (await this.readJson<TestRun>(this.testRunPath(id))) ?? null;
  }

  /** Execution history for one case (newest first), hot + archived merged. */
  async testCaseHistory(caseId: string, limit = 100): Promise<TestRun[]> {
    return this.listTestRuns({ caseId, limit });
  }

  async deleteTestRun(id: string, opts: { force?: boolean } = {}): Promise<TestRun> {
    if (!opts.force) throw new Error(`refusing to delete ${id}: execution records are immutable (pass force)`);
    const hot = await this.getTestRun(id);
    if (hot) {
      return this.tx(async () => {
        await fs.rm(this.testRunPath(id), { force: true });
        const counters = await this.readCounters();
        counters.TR_ARCHIVED = counters.TR_ARCHIVED ?? 0;
        await this.writeCounters(counters);
        return hot;
      }, `test: delete ${id}`);
    }
    const archived = (await this.readArchivedRuns()).find((r) => r.id === id);
    if (!archived) throw new Error(`test run not found: ${id}`);
    await this.tx(() => this.removeArchivedRuns((r) => r.id === id), `test: delete archived ${id}`);
    return archived;
  }

  // ----------------------------------------------------------------- archive

  /** Effective archive policy (injected by Workspace; defaults otherwise). */
  private async archivePolicy(): Promise<ArchivePolicy> {
    if (!this.testPolicyProvider) return { ...DEFAULT_ARCHIVE_POLICY };
    const policy = await this.testPolicyProvider();
    return { ...DEFAULT_ARCHIVE_POLICY, ...(policy?.archive ?? {}) };
  }

  /** Every hot run (unsorted). */
  private async readHotRuns(): Promise<TestRun[]> {
    const out: TestRun[] = [];
    for (const runId of await this.hotRunIdsDesc()) {
      const run = await this.getTestRun(runId);
      if (run) out.push(run);
    }
    return out;
  }

  /**
   * Opportunistic archive trigger, called after a write has been committed
   * (design §13.2 T1). The gate is O(1) — it reads `.counters.json`, which the
   * write path already loads to allocate an id — so the common case adds no IO.
   */
  async archiveIfNeeded(): Promise<ArchiveResult | null> {
    const policy = await this.archivePolicy();
    if (!policy.auto) return null;

    const counters = await this.readCounters();
    const hot = (counters.TR ?? 0) - (counters.TR_ARCHIVED ?? 0);
    const countGate = hot >= policy.hotMax * (1 + policy.hysteresisRatio);
    const oldest = counters.oldestHotAt ?? null;
    const olderThanHotWindow = !oldest || oldest < new Date(Date.now() - policy.hotDays * 86400000).toISOString();
    const throttled =
      counters.lastEvalAt !== null &&
      counters.lastEvalAt !== undefined &&
      Date.now() - Date.parse(counters.lastEvalAt) < policy.minIntervalHours * 3600000;
    // OR semantics: either gate alone is enough to justify evaluating (§13.3).
    if (!countGate && !(olderThanHotWindow && !throttled)) return null;

    await this.patchCounters({ lastEvalAt: NOW() }); // record the evaluation unconditionally
    const policyForSelection = policy;
    const selected = selectArchivable(await this.readHotRuns(), policyForSelection);
    if (selected.length < policy.minRunsPerArchive) {
      return { archived: 0, bundles: [], dryRun: false, skipped: 'below minRunsPerArchive', runs: [] };
    }
    return this.performArchive(selected, policyForSelection);
  }

  /**
   * Move runs out of the hot directory into monthly bundles. Idempotent: bundles
   * are merged by run id, so a re-run after a crash is safe.
   */
  async archiveRuns(opts: { before?: string; keep?: number; dryRun?: boolean } = {}): Promise<ArchiveResult> {
    const policy = await this.archivePolicy();
    const selected = selectArchivable(await this.readHotRuns(), policy, new Date(), opts);
    if (!selected.length) {
      return { archived: 0, bundles: [], dryRun: Boolean(opts.dryRun), skipped: 'nothing qualifies', runs: [] };
    }
    if (opts.dryRun) {
      const groups = groupRunsByBundle(selected, policy.bundle);
      return {
        archived: selected.length,
        bundles: [...groups].map(([file, runs]) => ({ file, runs: runs.length })),
        dryRun: true,
        runs: selected,
      };
    }
    return this.performArchive(selected, policy);
  }

  private async performArchive(selected: TestRun[], policy: ArchivePolicy): Promise<ArchiveResult> {
    return this.tx(
      async () => {
        await fs.mkdir(this.dirs.testrunsArchive, { recursive: true });
        const started = Date.now();
        const bundles: Array<{ file: string; runs: number }> = [];
        for (const [file, runs] of groupRunsByBundle(selected, policy.bundle)) {
          if (bundles.length && Date.now() - started > policy.budgetMs) break; // partial is fine: idempotent
          const full = path.join(this.dirs.testrunsArchive, file);
          const existing = await this.readFile(full);
          await this.writeFileAtomic(full, mergeBundle(existing, runs));
          for (const run of runs) {
            await fs.rm(this.testRunPath(run.id), { force: true });
          }
          bundles.push({ file, runs: runs.length });
        }
        const moved = bundles.reduce((n, b) => n + b.runs, 0);
        const remaining = await this.readHotRuns();
        const counters = await this.readCounters();
        await this.patchCounters({
          TR_ARCHIVED: (counters.TR_ARCHIVED ?? 0) + moved,
          oldestHotAt: remaining.length ? remaining.map((r) => r.executedAt).sort()[0] : null,
          lastArchiveAt: NOW(),
        });
        await this.reindexArchiveInner();
        return { archived: moved, bundles, dryRun: false, runs: selected.slice(0, moved) };
      },
      (res) =>
        `test: archive ${res.bundles.map((b) => b.file.replace(/\.jsonl$/, '')).join(', ')} (${res.archived} runs)`,
    );
  }

  /** Move a bundle's runs back into the hot directory (rollback / correction). */
  async restoreArchive(bundle: string): Promise<{ restored: number; file: string }> {
    const file = bundle.endsWith('.jsonl') ? bundle : `${bundle}.jsonl`;
    const full = path.join(this.dirs.testrunsArchive, file);
    const raw = await this.readFile(full);
    if (raw === null) throw new Error(`archive bundle not found: ${file}`);
    return this.tx(
      async () => {
        const { runs } = parseBundle(raw);
        for (const run of runs) await this.writeJson(this.testRunPath(run.id), run);
        await fs.rm(full, { force: true });
        const remaining = await this.readHotRuns();
        const counters = await this.readCounters();
        await this.patchCounters({
          TR_ARCHIVED: Math.max(0, (counters.TR_ARCHIVED ?? 0) - runs.length),
          oldestHotAt: remaining.length ? remaining.map((r) => r.executedAt).sort()[0] : null,
        });
        await this.reindexArchiveInner();
        return { restored: runs.length, file };
      },
      `test: restore ${file}`,
    );
  }

  /**
   * Cheap archive summary derived from `.counters.json` only — no bundle scan.
   * Attached to query results so callers (agents, scripts) know whether what
   * they are looking at spans archived cold data.
   */
  async archiveSummary(): Promise<ArchiveSummary> {
    const counters = await this.readCounters();
    const policy = await this.archivePolicy();
    const archived = counters.TR_ARCHIVED ?? 0;
    return {
      hotRuns: (counters.TR ?? 0) - archived,
      archivedRuns: archived,
      oldestHotAt: counters.oldestHotAt ?? null,
      lastArchiveAt: counters.lastArchiveAt ?? null,
      hotDays: policy.hotDays,
      hotMax: policy.hotMax,
    };
  }

  async archiveStatus(policy?: ArchivePolicy): Promise<ArchiveStatus> {
    const effective = policy ?? (await this.archivePolicy());
    const counters = await this.readCounters();
    const hotIds = await this.hotRunIdsDesc();
    const bundles: ArchiveBundleInfo[] = [];
    let archivedRuns = 0;
    for (const file of await this.archiveBundleFiles()) {
      const raw = (await this.readFile(path.join(this.dirs.testrunsArchive, file))) ?? '';
      const summary = summarizeBundle(raw);
      archivedRuns += summary.runs;
      bundles.push({
        file,
        runs: summary.runs,
        bytes: Buffer.byteLength(raw, 'utf8'),
        from: summary.from,
        to: summary.to,
        cases: summary.cases,
      });
    }
    return {
      hotRuns: counters.TR !== undefined ? (counters.TR ?? 0) - (counters.TR_ARCHIVED ?? 0) : hotIds.length,
      archivedRuns: counters.TR_ARCHIVED ?? archivedRuns,
      oldestHotAt: counters.oldestHotAt ?? null,
      lastEvalAt: counters.lastEvalAt ?? null,
      lastArchiveAt: counters.lastArchiveAt ?? null,
      policy: effective,
      bundles,
      indexFresh: Boolean((await this.readArchiveIndex()).builtAt),
    };
  }

  /** Rebuild the optional plain-text archive index (`archive/index.json`). */
  async reindexArchive(): Promise<Record<string, unknown>> {
    await this.tx(() => this.reindexArchiveInner(), 'test: reindex archive');
    return this.readArchiveIndex();
  }

  private async reindexArchiveInner(): Promise<void> {
    const bundles: ArchiveBundleInfo[] = [];
    const byCase: Record<string, string[]> = {};
    for (const file of (await this.archiveBundleFiles()).slice().reverse()) {
      const raw = (await this.readFile(path.join(this.dirs.testrunsArchive, file))) ?? '';
      const summary = summarizeBundle(raw);
      const month = file.replace(/\.jsonl$/, '');
      bundles.push({
        file,
        runs: summary.runs,
        bytes: Buffer.byteLength(raw, 'utf8'),
        from: summary.from,
        to: summary.to,
        cases: summary.cases,
      });
      for (const run of parseBundle(raw).runs) {
        const months = byCase[run.caseId] ?? [];
        if (!months.includes(month)) months.push(month);
        byCase[run.caseId] = months;
      }
    }
    await this.writeJson(path.join(this.dirs.testrunsArchive, 'index.json'), { builtAt: NOW(), bundles, byCase });
  }

  private async readArchiveIndex(): Promise<Record<string, unknown>> {
    return (await this.readJson<Record<string, unknown>>(path.join(this.dirs.testrunsArchive, 'index.json'))) ?? {};
  }

  /** Atomic write (tmp + rename) so readers never see a half-written bundle. */
  private async writeFileAtomic(target: string, content: string): Promise<void> {
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
  }

  /** Aggregate pass/fail/coverage insight for a batch, build or work item. */
  async testReport(filter: TestReportFilter = {}): Promise<TestReport> {
    const includeArchived = filter.includeArchived !== false;
    const runFilter: TestRunFilter = {
      batch: filter.batch,
      build: filter.build,
      workItem: filter.workItem,
      since: filter.since,
      until: filter.until,
      includeArchived,
    };
    const runs = await this.listTestRuns(runFilter);
    const cases = (await this.listTestCases({ workItem: filter.workItem }, { withLastRun: false })).filter(
      (c) => c.status === 'active',
    );

    const byCase = new Map<string, TestRun[]>();
    for (const run of runs) {
      const list = byCase.get(run.caseId) ?? [];
      list.push(run);
      byCase.set(run.caseId, list);
    }

    const totals = { cases: cases.length, runs: runs.length, pass: 0, fail: 0, blocked: 0, skipped: 0, notRun: 0 };
    for (const run of runs) {
      if (run.result === 'pass') totals.pass++;
      else if (run.result === 'fail') totals.fail++;
      else if (run.result === 'blocked') totals.blocked++;
      else totals.skipped++;
    }

    const failures: TestReport['failures'] = [];
    const notRunCases: TestReport['notRunCases'] = [];
    const flaky: TestReport['flaky'] = [];
    for (const c of cases) {
      const list = byCase.get(c.id) ?? [];
      if (!list.length) {
        totals.notRun++;
        notRunCases.push({ caseId: c.id, title: c.title });
        continue;
      }
      const pass = list.filter((r) => r.result === 'pass').length;
      const fail = list.filter((r) => r.result === 'fail').length;
      if (pass > 0 && fail > 0) flaky.push({ caseId: c.id, title: c.title, pass, fail });
      const latest = list.slice().sort(compareRunsDesc)[0];
      if (latest.result === 'fail') {
        failures.push({
          caseId: c.id,
          title: c.title,
          runId: latest.id,
          build: latest.build,
          executedAt: latest.executedAt,
        });
      }
    }

    const items = await this.listWorkItems({ limit: 0 });
    const coveredItems = new Set<string>();
    for (const c of await this.listTestCases({}, { withLastRun: false })) {
      if (c.workItem) coveredItems.add(c.workItem);
    }
    const withoutCases = items.filter((i) => !coveredItems.has(i.id)).map((i) => i.id);

    const decided = totals.pass + totals.fail;
    return {
      scope: {
        project: path.basename(this.root),
        batch: filter.batch,
        build: filter.build,
        workItem: filter.workItem,
        from: filter.since,
        to: filter.until,
      },
      totals,
      passRate: decided ? Math.round((totals.pass / decided) * 1000) / 10 : null,
      coverage: {
        itemsTotal: items.length,
        itemsWithCases: items.length - withoutCases.length,
        itemsWithoutCases: withoutCases.slice(0, 20),
        itemsWithoutCasesTotal: withoutCases.length,
      },
      failures: failures.slice(0, 20),
      notRunCases: notRunCases.slice(0, 50),
      flaky,
    };
  }

  /**
   * Verification summary for a work item: how its active test cases last
   * executed. Informational — the optional blocking gate lives in `Workspace`.
   */
  async verificationForWorkItem(id: string): Promise<WorkItemVerification> {
    const cases = (await this.listTestCases({ workItem: id }, { withLastRun: false })).filter(
      (c) => c.status === 'active',
    );
    const runs = await this.listTestRuns({ workItem: id });
    const latest = new Map<string, TestRun>();
    for (const run of runs.slice().sort(compareRunsDesc)) {
      if (!latest.has(run.caseId)) latest.set(run.caseId, run);
    }
    const result: WorkItemVerification = { cases: cases.length, pass: 0, fail: 0, notRun: 0, failing: [], notRunCases: [] };
    for (const c of cases) {
      const run = latest.get(c.id);
      if (!run) {
        result.notRun++;
        result.notRunCases.push(c.id);
      } else if (run.result === 'pass') {
        result.pass++;
      } else if (run.result === 'fail') {
        result.fail++;
        result.failing.push(c.id);
      }
    }
    return result;
  }

  // -------------------------------------------------- test run/archive helpers

  /** Hot run ids, newest first. Ids are monotonic per project. */
  private async hotRunIdsDesc(): Promise<string[]> {
    const files = (await this.readDir(this.dirs.testruns)).filter((f) => /^TR-\d+\.json$/.test(f));
    return files
      .map((f) => parseInt(f.slice(3, -5), 10))
      .sort((a, b) => b - a)
      .map((n) => `TR-${n}`);
  }

  /** Bundle files newest-first (names sort chronologically). */
  private async archiveBundleFiles(): Promise<string[]> {
    const files = (await this.readDir(this.dirs.testrunsArchive)).filter((f) => f.endsWith('.jsonl'));
    return files.sort().reverse();
  }

  /**
   * Read archived runs (cold data). Empty until archiving has run. When a caseId
   * is given, the optional plain-text index narrows the bundles to open.
   */
  private async readArchivedRuns(caseId?: string): Promise<TestRun[]> {
    const out: TestRun[] = [];
    const files = caseId ? await this.bundlesForCase(caseId) : await this.archiveBundleFiles();
    for (const file of files) {
      const raw = await this.readFile(path.join(this.dirs.testrunsArchive, file));
      if (raw === null) continue;
      for (const run of parseBundle(raw).runs) {
        if (!caseId || run.caseId === caseId) out.push(run);
      }
    }
    return out;
  }

  /** Bundles that may contain a case, per `archive/index.json` (falls back to all). */
  private async bundlesForCase(caseId: string): Promise<string[]> {
    const index = await this.readArchiveIndex();
    const byCase = (index.byCase ?? {}) as Record<string, string[]>;
    const months = byCase[caseId];
    if (!Array.isArray(months) || !months.length) return this.archiveBundleFiles();
    return months.map((m) => `${m}.jsonl`).filter((f) => f.endsWith('.jsonl'));
  }

  /** Remove archived runs matching a predicate; returns how many were removed. */
  private async removeArchivedRuns(predicate: (run: TestRun) => boolean): Promise<number> {
    let removed = 0;
    for (const file of await this.archiveBundleFiles()) {
      const full = path.join(this.dirs.testrunsArchive, file);
      const raw = await this.readFile(full);
      if (raw === null) continue;
      const result = filterBundle(raw, predicate);
      removed += result.removed;
      if (!result.raw) await fs.rm(full, { force: true });
      else await this.writeFileAtomic(full, result.raw);
    }
    if (removed) await this.reindexArchiveInner();
    return removed;
  }

  /**
   * Latest run + (optional) hot run count per case. Scans hot runs newest-first
   * and stops early once every requested case is resolved.
   */
  private async collectRunStats(
    caseIds: Set<string>,
    opts: { includeArchived: boolean; countAll: boolean },
  ): Promise<Map<string, { last: TestRun | null; count: number | null }>> {
    const stats = new Map<string, { last: TestRun | null; count: number | null }>();
    if (!caseIds.size) return stats;
    for (const id of caseIds) stats.set(id, { last: null, count: opts.countAll ? 0 : null });

    for (const runId of await this.hotRunIdsDesc()) {
      const run = await this.getTestRun(runId);
      if (!run || !caseIds.has(run.caseId)) continue;
      const st = stats.get(run.caseId)!;
      if (!st.last) st.last = run;
      if (st.count !== null) st.count++;
      if (!opts.countAll && [...stats.values()].every((s) => s.last)) break;
    }

    const unresolved = [...stats.values()].some((s) => !s.last);
    if (opts.includeArchived && unresolved) {
      for (const file of await this.archiveBundleFiles()) {
        const raw = await this.readFile(path.join(this.dirs.testrunsArchive, file));
        if (raw === null) continue;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let run: TestRun;
          try {
            run = JSON.parse(line) as TestRun;
          } catch {
            continue;
          }
          if (!caseIds.has(run.caseId)) continue;
          const st = stats.get(run.caseId)!;
          if (!st.last) st.last = run;
        }
        if ([...stats.values()].every((s) => s.last)) break;
      }
    }
    return stats;
  }

  /** Bugs this case guards: explicit `bugs[]` links plus bugs that name the case. */
  private async linkedBugsForCase(testCase: TestCase): Promise<Bug[]> {
    const out = new Map<string, Bug>();
    for (const id of testCase.bugs ?? []) {
      const bug = await this.getBug(id);
      if (bug) out.set(bug.id, bug);
    }
    for (const bug of await this.listBugs({ limit: 0 })) {
      if (bug.testCase === testCase.id) out.set(bug.id, bug);
    }
    return [...out.values()];
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
    // Test counts are derived from the hot directory only: the board chips must
    // not pay for reading archived bundles.
    const cases = await this.listTestCases({}, { withLastRun: true });
    const tests: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0, notRun: 0 };
    for (const c of cases) tests[c.lastResult ?? 'notRun'] = (tests[c.lastResult ?? 'notRun'] ?? 0) + 1;
    const recent = await this.recentActivity(limit);
    return {
      workItems: statusCounts(workItems),
      bugs: statusCounts(bugs),
      docs: docs.length,
      totalWorkItems: workItems.length,
      totalBugs: bugs.length,
      tests,
      totalTestCases: cases.length,
      totalTestRuns: (await this.hotRunIdsDesc()).length,
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
      const kind: BoardActivity['kind'] = c.message.startsWith('bug:')
        ? 'bug'
        : c.message.startsWith('doc:')
          ? 'doc'
          : c.message.startsWith('testcase:')
            ? 'testcase'
            : c.message.startsWith('test:')
              ? 'testrun'
              : 'workitem';
      const id = /\b((?:WI|BUG|TC|TR)-\d+)\b/.exec(c.message)?.[1] ?? '';
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

/** Input accepted by `Store.recordTestRun`. */
export interface RecordTestRunInput {
  /** Existing case id (`TC-N`). Either this or `caseTitle` is required. */
  caseId?: string;
  /** Case title; an active match is reused, otherwise a case is auto-created. */
  caseTitle?: string;
  result: TestResult;
  actual?: string;
  evidence?: string;
  environment?: string;
  build?: string;
  batch?: string;
  durationMs?: number | null;
  executedAt?: string;
  author?: string;
  /** File a bug when the result is a failure (deduplicated per case). Core default: false. */
  createBugOnFailure?: boolean;
  /** Advance a `fixed` bug to `verified` on a passing run. Default false. */
  verifyBugs?: boolean;
  /** Auto-create the case when `caseTitle` matches nothing. Default true. */
  autoCreateCase?: boolean;
}

/** Group runs by their bundle file name, preserving oldest-first order. */
function groupRunsByBundle(runs: TestRun[], bundle: ArchivePolicy['bundle']): Map<string, TestRun[]> {
  const groups = new Map<string, TestRun[]>();
  for (const run of runs) {
    const name = bundleName(run.executedAt, bundle);
    const list = groups.get(name) ?? [];
    list.push(run);
    groups.set(name, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Newest execution first: by `executedAt`, then by id (ids are monotonic). */
function compareRunsDesc(a: TestRun, b: TestRun): number {
  const byTime = b.executedAt.localeCompare(a.executedAt);
  if (byTime !== 0) return byTime;
  return b.id.localeCompare(a.id, undefined, { numeric: true });
}

function matchesTestCaseFilter(tc: TestCaseWithStatus, filter: TestCaseFilter): boolean {
  if (filter.status) {
    const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!wanted.includes(tc.status)) return false;
  }
  if (filter.type) {
    const wanted = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!wanted.includes(tc.type)) return false;
  }
  if (filter.priority) {
    const wanted = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
    if (!wanted.includes(tc.priority)) return false;
  }
  if (filter.workItem && tc.workItem !== filter.workItem) return false;
  if (filter.bug && !(tc.bugs ?? []).includes(filter.bug)) return false;
  if (typeof filter.automated === 'boolean' && tc.automated !== filter.automated) return false;
  if (filter.lastResult) {
    const actual = tc.lastResult ?? 'notRun';
    if (actual !== filter.lastResult) return false;
  }
  if (filter.tags?.length && !filter.tags.every((t) => tc.tags?.includes(t))) return false;
  if (filter.query) {
    const q = filter.query.toLowerCase();
    const haystack = [tc.title, tc.description, tc.preconditions, ...(tc.steps ?? []).flatMap((s) => [s.action, s.expected])]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

function matchesRunFilter(run: TestRun, filter: TestRunFilter): boolean {
  if (filter.caseId && run.caseId !== filter.caseId) return false;
  if (filter.result) {
    const wanted = Array.isArray(filter.result) ? filter.result : [filter.result];
    if (!wanted.includes(run.result)) return false;
  }
  if (filter.build && run.build !== filter.build) return false;
  if (filter.batch && run.batch !== filter.batch) return false;
  if (filter.environment && run.environment !== filter.environment) return false;
  if (filter.workItem && run.workItem !== filter.workItem) return false;
  if (filter.executedBy && run.executedBy !== filter.executedBy) return false;
  if (filter.since && run.executedAt < filter.since) return false;
  if (filter.until && run.executedAt > filter.until) return false;
  return true;
}

export {
  WORKITEM_TYPES,
  WORKITEM_STATUSES,
  PRIORITIES,
  BUG_SEVERITIES,
  BUG_STATUSES,
  DOC_TYPES,
  TESTCASE_TYPES,
  TESTCASE_STATUSES,
  TEST_RESULTS,
};
