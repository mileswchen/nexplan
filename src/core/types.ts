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

export interface BoardSummary {
  workItems: Record<string, number>;
  bugs: Record<string, number>;
  docs: number;
  totalWorkItems: number;
  totalBugs: number;
  recent: BoardActivity[];
}

export interface BoardActivity {
  kind: 'workitem' | 'bug' | 'doc';
  id: string;
  action: string;
  author: string;
  at: string;
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
