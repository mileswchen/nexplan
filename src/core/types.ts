/** Domain types for NexPlan. */

export type WorkItemType =
  | 'task'
  | 'feature'
  | 'refactor'
  | 'chore'
  | 'research'
  | 'bug'
  | 'docs';

export type WorkItemStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export type ItemSource = 'manual' | 'agent';

export interface Note {
  id: string;
  author: string;
  body: string;
  at: string;
}

export interface WorkItem {
  id: string; // WI-N
  type: WorkItemType;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: Priority;
  assignee: string | null; // agent id or 'user'
  source: ItemSource;
  parent: string | null; // parent work item id (decomposition)
  children: string[]; // child work item ids
  tags: string[];
  estimate: number | null; // story points / hours
  fixesBug: string[]; // bug ids fixed by this item
  docLink: string | null; // URL of the design document for this item
  createdBy: string; // 'user' or agent name
  createdAt: string; // ISO
  updatedAt: string; // ISO
  completedAt: string | null;
  notes: Note[];
}

export type BugSeverity = 'critical' | 'major' | 'minor' | 'trivial';
export type BugStatus = 'open' | 'in_progress' | 'fixed' | 'verified' | 'wontfix' | 'reopened';

export interface Bug {
  id: string; // BUG-N
  title: string;
  description: string;
  severity: BugSeverity;
  status: BugStatus;
  foundBy: ItemSource;
  foundByAgent: string | null;
  evidence: string; // stack trace, logs, repro
  assignee: string | null;
  workItem: string | null; // linked work item that fixes it
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  notes: Note[];
  /** Test case that discovered this bug (additive; absent on older records). */
  testCase?: string | null;
  /** Test run that discovered this bug (additive; absent on older records). */
  testRun?: string | null;
}

export type DocType = 'design' | 'decision' | 'adr' | 'architecture' | 'notes';
export type DocStatus = 'draft' | 'review' | 'approved' | 'superseded';

export interface DocMeta {
  title: string;
  type: DocType;
  status: DocStatus;
  version: number;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** A fully loaded document: parsed meta + markdown body (frontmatter stripped). */
export interface Doc {
  slug: string;
  content: string; // markdown body, no frontmatter
  meta: DocMeta;
}

export interface DocVersion {
  sha: string;
  version: number;
  author: string;
  date: string; // ISO
  message: string;
}

/** A user/agent comment on a document (kept separate from the doc's versioned body). */
export interface DocComment {
  id: string;
  author: string;
  body: string;
  at: string; // ISO
}

export interface BoardSummary {
  workItems: Record<string, number>;
  bugs: Record<string, number>;
  docs: number;
  totalWorkItems: number;
  totalBugs: number;
  /** Test-case counts by their latest run result (includes a `notRun` key). Hot data only. */
  tests: Record<string, number>;
  totalTestCases: number;
  /** Runs currently in the hot directory (archived runs are not counted here). */
  totalTestRuns: number;
  recent: BoardActivity[];
}

export interface BoardActivity {
  kind: 'workitem' | 'bug' | 'doc' | 'testcase' | 'testrun';
  id: string;
  action: string;
  author: string;
  at: string;
}

// ---- multi-user / multi-project ---------------------------------------------

export type UserRole = 'admin' | 'member' | 'viewer';
export type UserKind = 'human' | 'agent';

export interface User {
  id: string; // e.g. "xiaomo", "claude-code"
  name: string;
  kind: UserKind;
  role: UserRole;
  createdAt: string;
  /** Scrypt hash (`scrypt$salt$hash`) for human logins. Absent for agent users. */
  passwordHash?: string;
  /** True when a default password was issued and must be changed on first login. */
  mustChangePassword?: boolean;
}

export interface Project {
  key: string; // e.g. "nexplan"
  name: string; // display name
  description: string;
  members: string[]; // user ids
  createdAt: string;
  updatedAt: string;
  /** Project-level overrides of the workspace test policy. */
  testPolicy?: TestPolicyOverride;
}

/** Per-project board summary (same shape as BoardSummary, scoped to a project). */
export interface ProjectSummary extends BoardSummary {
  projectKey: string;
}

export interface ListFilter {
  status?: WorkItemStatus | WorkItemStatus[];
  type?: WorkItemType | WorkItemType[];
  priority?: Priority | Priority[];
  assignee?: string;
  tags?: string[];
  query?: string; // substring on title/description
  limit?: number;
}

export interface BugFilter {
  status?: BugStatus | BugStatus[];
  severity?: BugSeverity | BugSeverity[];
  assignee?: string;
  tags?: string[];
  query?: string;
  limit?: number;
}

// ---- test cases & test runs --------------------------------------------------

export type TestCaseType =
  | 'functional'
  | 'regression'
  | 'integration'
  | 'e2e'
  | 'performance'
  | 'security'
  | 'usability'
  | 'other';

export type TestCaseStatus = 'draft' | 'active' | 'deprecated';

export type TestResult = 'pass' | 'fail' | 'blocked' | 'skipped';

export interface TestStep {
  action: string;
  expected: string;
}

export interface TestCase {
  id: string; // TC-N
  title: string;
  description: string;
  type: TestCaseType;
  priority: Priority;
  status: TestCaseStatus;
  preconditions: string;
  steps: TestStep[];
  tags: string[];
  workItem: string | null; // WI-N this case verifies
  bugs: string[]; // BUG-N this case guards
  automated: boolean;
  testFile: string | null; // automation locator, e.g. "test/store.test.ts::claims an item"
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  notes: Note[];
}

/** A test case decorated with derived run statistics (never persisted). */
export interface TestCaseWithStatus extends TestCase {
  lastResult: TestResult | null; // null = never run
  lastRunAt: string | null;
  lastBuild: string | null;
  /**
   * Number of hot runs for this case, or `null` when the caller did not ask for
   * counts (computing them requires a full scan, which the fast list path avoids).
   */
  runCount: number | null;
}

export interface TestRun {
  id: string; // TR-N
  caseId: string; // TC-N
  // ---- snapshot fields, frozen at write time: editing/deleting a case never
  // ---- rewrites history.
  caseTitle: string;
  workItem: string | null;
  // ---- result ----
  result: TestResult;
  actual: string;
  evidence: string;
  environment: string;
  build: string;
  batch: string;
  durationMs: number | null;
  bugIds: string[]; // bugs created by / linked to this run
  executedBy: string;
  executedAt: string;
  notes: Note[];
}

export interface TestCaseFilter {
  status?: TestCaseStatus | TestCaseStatus[];
  type?: TestCaseType | TestCaseType[];
  priority?: Priority | Priority[];
  workItem?: string;
  bug?: string;
  tags?: string[];
  automated?: boolean;
  /** Filter by the case's latest run result; `'notRun'` selects never-run cases. */
  lastResult?: TestResult | 'notRun';
  query?: string;
  limit?: number;
}

export interface TestRunFilter {
  caseId?: string;
  result?: TestResult | TestResult[];
  build?: string;
  batch?: string;
  environment?: string;
  workItem?: string;
  executedBy?: string;
  since?: string; // ISO, inclusive
  until?: string; // ISO, inclusive
  /** Merge archived (cold) runs into the result. Default true. */
  includeArchived?: boolean;
  limit?: number;
}

export interface TestReportFilter {
  batch?: string;
  build?: string;
  workItem?: string;
  since?: string;
  until?: string;
  /** Merge archived (cold) runs into the report. Default true. */
  includeArchived?: boolean;
}

export interface TestReport {
  scope: { project: string; batch?: string; build?: string; workItem?: string; from?: string; to?: string };
  totals: {
    cases: number; // active cases in scope
    runs: number;
    pass: number;
    fail: number;
    blocked: number;
    skipped: number;
    notRun: number; // active cases in scope with no qualifying run
  };
  passRate: number | null; // pass / (pass + fail); null when no pass/fail runs
  coverage: {
    itemsTotal: number;
    itemsWithCases: number;
    itemsWithoutCases: string[]; // capped at 20
    itemsWithoutCasesTotal: number;
  };
  failures: Array<{ caseId: string; title: string; runId: string; build: string; executedAt: string }>;
  notRunCases: Array<{ caseId: string; title: string }>;
  flaky: Array<{ caseId: string; title: string; pass: number; fail: number }>;
}

/** Result of recording one run, including all automatic side effects. */
export interface RecordRunResult {
  run: TestRun;
  testCase: TestCase;
  createdBugs: Bug[];
  updatedBugs: Bug[];
}

/** Verification summary for a work item (informational unless a gate is enabled). */
export interface WorkItemVerification {
  cases: number;
  pass: number;
  fail: number;
  notRun: number;
  failing: string[];
  notRunCases: string[];
}

// ---- archive (cold storage) --------------------------------------------------

export interface ArchivePolicy {
  auto: boolean;
  hotDays: number;
  hotMax: number;
  hysteresisRatio: number;
  minIntervalHours: number;
  minRunsPerArchive: number;
  budgetMs: number;
  bundle: 'month' | 'week';
}

export interface ArchiveResult {
  archived: number;
  bundles: Array<{ file: string; runs: number }>;
  dryRun: boolean;
  /** Set when nothing was archived, explaining why. */
  skipped?: string;
  runs: TestRun[]; // the runs selected (dry-run) or moved (real run)
}

export interface ArchiveBundleInfo {
  file: string;
  runs: number;
  bytes: number;
  from: string | null;
  to: string | null;
  cases: number;
}

export interface ArchiveStatus {
  hotRuns: number;
  archivedRuns: number;
  oldestHotAt: string | null;
  lastEvalAt: string | null;
  lastArchiveAt: string | null;
  policy: ArchivePolicy;
  bundles: ArchiveBundleInfo[];
  indexFresh: boolean;
}

/** Counters-only view of archiving (cheap enough to attach to every query). */
export interface ArchiveSummary {
  hotRuns: number;
  archivedRuns: number;
  oldestHotAt: string | null;
  lastArchiveAt: string | null;
  hotDays: number;
  hotMax: number;
}

/** Per-project test policy (work item completion gate + archive settings). */
export interface TestPolicy {
  requirePassingOnComplete: boolean;
  allowForce: boolean;
  archive: ArchivePolicy;
}

/** Stored override: every field optional, archive settings merged field-wise. */
export interface TestPolicyOverride {
  requirePassingOnComplete?: boolean;
  allowForce?: boolean;
  archive?: Partial<ArchivePolicy>;
}

export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  auto: true,
  hotDays: 90,
  hotMax: 5000,
  hysteresisRatio: 0.2,
  minIntervalHours: 24,
  minRunsPerArchive: 50,
  budgetMs: 2000,
  bundle: 'month',
};

export const DEFAULT_TEST_POLICY: TestPolicy = {
  requirePassingOnComplete: false,
  allowForce: true,
  archive: { ...DEFAULT_ARCHIVE_POLICY },
};
