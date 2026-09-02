import { z } from 'zod';
import { Store } from '../core/store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// `as const` tuples keep zod's inferred types as literal unions, which match the
// store's domain types exactly (a `[string, ...string[]]` cast would widen them).
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const ITEM_TYPES = ['task', 'feature', 'refactor', 'chore', 'research', 'bug', 'docs'] as const;
const ITEM_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'] as const;
const BUG_SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const;
const BUG_STATUSES = ['open', 'in_progress', 'fixed', 'verified', 'wontfix', 'reopened'] as const;
const DOC_TYPES = ['design', 'decision', 'adr', 'architecture', 'notes'] as const;
const DOC_STATUS = ['draft', 'review', 'approved', 'superseded'] as const;

// A tool handler returns the MCP CallToolResult. `text` is the universal
// representation; `structuredContent` is an optional JSON view for typed clients.
// The MCP result schema requires structuredContent to be a record (not an array),
// so arrays are wrapped in `{ items }`.
function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const isArray = Array.isArray(data);
  const isObject = data !== null && typeof data === 'object' && !isArray;
  const structuredContent = isObject
    ? (data as Record<string, unknown>)
    : isArray
      ? { items: data }
      : undefined;
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

const priorities = z.enum(PRIORITIES);
const itemTypes = z.enum(ITEM_TYPES);
const itemStatuses = z.enum(ITEM_STATUSES);
const bugSeverities = z.enum(BUG_SEVERITIES);
const bugStatuses = z.enum(BUG_STATUSES);
const docTypes = z.enum(DOC_TYPES);
const docStatus = z.enum(DOC_STATUS);

export function registerNexplanTools(server: McpServer, store: Store): void {
  const author = (v?: string) => v ?? 'agent';

  // ---------------------------------------------------------------- backlog

  const addItemSchema = z.object({
    title: z.string().min(1).describe('Short title of the work item.'),
    type: itemTypes.optional().describe('Type/kind of work item. Default: task.'),
    description: z.string().optional(),
    priority: priorities.optional().describe('P0..P3. Default: P2.'),
    assignee: z.string().nullish(),
    source: z.enum(['manual', 'agent']).optional(),
    tags: z.array(z.string()).optional(),
    estimate: z.number().nullish().describe('Story points / hours.'),
    fixesBug: z.array(z.string()).optional().describe('Bug ids this item will fix.'),
  });

  server.registerTool(
    'nexplan_backlog_add',
    {
      title: 'Add backlog items',
      description:
        'Add one or more work items to the backlog. Use this to enter decomposed tasks. ' +
        'Set `author` to your agent name for attribution.',
      inputSchema: z.object({
        items: z.array(addItemSchema).min(1),
        author: z.string().optional().describe('Attribution (agent or user name).'),
      }),
    },
    async (args) => {
      const created = [];
      for (const it of args.items) {
        created.push(
          await store.createWorkItem({
            ...it,
            author: author(args.author),
            source: args.author === 'user' ? 'manual' : it.source,
          }),
        );
      }
      return ok({ created, count: created.length });
    },
  );

  server.registerTool(
    'nexplan_backlog_list',
    {
      title: 'List backlog items',
      description: 'List/filter work items in the backlog.',
      inputSchema: z.object({
        status: z.union([itemStatuses, z.array(itemStatuses)]).optional(),
        type: z.union([itemTypes, z.array(itemTypes)]).optional(),
        priority: z.union([priorities, z.array(priorities)]).optional(),
        assignee: z.string().optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional().describe('Substring match on title/description.'),
        limit: z.number().int().positive().optional(),
      }),
    },
    async (args) => ok(await store.listWorkItems(args)),
  );

  server.registerTool(
    'nexplan_backlog_get',
    {
      title: 'Get a backlog item',
      description: 'Fetch a single work item by id (e.g. WI-3).',
      inputSchema: z.object({ id: z.string().describe('Work item id, e.g. WI-3.') }),
    },
    async (args) => {
      const item = await store.getWorkItem(args.id);
      if (!item) throw new Error(`work item not found: ${args.id}`);
      return ok(item);
    },
  );

  server.registerTool(
    'nexplan_backlog_claim',
    {
      title: 'Claim a backlog item',
      description:
        'Take ownership of a backlog item. Sets assignee and status to in_progress. ' +
        'This is the step to call before starting work on an item.',
      inputSchema: z.object({
        id: z.string().describe('Work item id, e.g. WI-3.'),
        assignee: z.string().describe('Who is claiming it (your agent name).'),
        status: itemStatuses.optional(),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.claimWorkItem(args.id, args.assignee, args.status ?? 'in_progress', author(args.author))),
  );

  server.registerTool(
    'nexplan_backlog_update',
    {
      title: 'Update a backlog item',
      description: 'Update any fields of a work item (status, priority, title, description, assignee, tags, estimate).',
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        type: itemTypes.optional(),
        priority: priorities.optional(),
        status: itemStatuses.optional(),
        assignee: z.string().nullish(),
        tags: z.array(z.string()).optional(),
        estimate: z.number().nullish(),
        author: z.string().optional(),
      }),
    },
    async (args) => {
      const { id, author: aut, ...patch } = args;
      return ok(await store.updateWorkItem(id, patch, author(aut)));
    },
  );

  server.registerTool(
    'nexplan_backlog_complete',
    {
      title: 'Complete a backlog item',
      description:
        'Mark a work item as done. Optionally add a completion note and automatically ' +
        'transition bugs listed in fixesBug to fixed.',
      inputSchema: z.object({
        id: z.string(),
        note: z.string().optional().describe('Summary of what was done.'),
        closeLinkedBugs: z.boolean().optional().describe('Default true.'),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.completeWorkItem(args.id, { note: args.note, closeLinkedBugs: args.closeLinkedBugs, author: author(args.author) })),
  );

  server.registerTool(
    'nexplan_backlog_decompose',
    {
      title: 'Decompose a backlog item',
      description: 'Split a parent item into child backlog items (linked to the parent).',
      inputSchema: z.object({
        parentId: z.string(),
        children: z
          .array(
            z.object({
              title: z.string().min(1),
              type: itemTypes.optional(),
              description: z.string().optional(),
              priority: priorities.optional(),
            }),
          )
          .min(1),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.decomposeWorkItem(args.parentId, args.children, author(args.author))),
  );

  server.registerTool(
    'nexplan_backlog_note',
    {
      title: 'Add a note to a backlog item',
      description: 'Append a progress/context note to a work item.',
      inputSchema: z.object({
        id: z.string(),
        body: z.string().min(1),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.addWorkItemNote(args.id, args.body, author(args.author))),
  );

  // ------------------------------------------------------------------- docs

  server.registerTool(
    'nexplan_docs_list',
    {
      title: 'List documents',
      description: 'List design/decision documents with their metadata.',
      inputSchema: z.object({}),
    },
    async () => ok(await store.listDocs()),
  );

  server.registerTool(
    'nexplan_docs_get',
    {
      title: 'Get a document',
      description: 'Fetch a document by slug (file name without .md).',
      inputSchema: z.object({ slug: z.string() }),
    },
    async (args) => {
      const doc = await store.getDoc(args.slug);
      if (!doc) throw new Error(`doc not found: ${args.slug}`);
      return ok(doc);
    },
  );

  server.registerTool(
    'nexplan_docs_create',
    {
      title: 'Create a document',
      description:
        'Create a new design/decision/ADR document. Agents should record their design ' +
        'decisions here (e.g. ADRs). Content is markdown; version starts at 1.',
      inputSchema: z.object({
        title: z.string().min(1),
        type: docTypes.optional(),
        body: z.string().optional().describe('Markdown content.'),
        status: docStatus.optional(),
        tags: z.array(z.string()).optional(),
        slug: z.string().optional(),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.createDoc({ ...args, author: author(args.author) })),
  );

  server.registerTool(
    'nexplan_docs_update',
    {
      title: 'Update a document',
      description:
        'Update a document (content/status/title/type/tags). Bumps the version number and ' +
        'records a version in git history. Use it to keep docs current as work evolves.',
      inputSchema: z.object({
        slug: z.string(),
        content: z.string().optional().describe('Replacement markdown content.'),
        title: z.string().optional(),
        type: docTypes.optional(),
        status: docStatus.optional(),
        tags: z.array(z.string()).optional(),
        author: z.string().optional(),
      }),
    },
    async (args) => {
      const { slug, author: aut, ...patch } = args;
      return ok(await store.updateDoc(slug, patch, author(aut)));
    },
  );

  server.registerTool(
    'nexplan_docs_history',
    {
      title: 'Document version history',
      description: 'List the version history (git commits) of a document, newest first.',
      inputSchema: z.object({ slug: z.string(), limit: z.number().int().positive().optional() }),
    },
    async (args) => ok(await store.docHistory(args.slug, args.limit ?? 100)),
  );

  server.registerTool(
    'nexplan_docs_diff',
    {
      title: 'Diff two document versions',
      description: 'Show a git diff of a document between two commits (shas from history).',
      inputSchema: z.object({
        slug: z.string(),
        shaA: z.string(),
        shaB: z.string(),
      }),
    },
    async (args) => ok(await store.docDiff(args.slug, args.shaA, args.shaB)),
  );

  // ------------------------------------------------------------------- bugs

  server.registerTool(
    'nexplan_bug_add',
    {
      title: 'Add a bug',
      description:
        'Report a bug. Use this when you discover a defect automatically (failed tests, ' +
        'lint errors, crashes). Include evidence such as stack traces/logs. Set `author` ' +
        'for attribution; foundBy becomes agent automatically.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        severity: bugSeverities.optional(),
        evidence: z.string().optional().describe('Stack trace, log lines, repro steps.'),
        tags: z.array(z.string()).optional(),
        workItem: z.string().nullish().describe('Optional linked work item id.'),
        assignee: z.string().nullish(),
        author: z.string().optional(),
      }),
    },
    async (args) => ok(await store.createBug({ ...args, author: author(args.author) })),
  );

  server.registerTool(
    'nexplan_bug_list',
    {
      title: 'List bugs',
      description: 'List/filter bugs.',
      inputSchema: z.object({
        status: z.union([bugStatuses, z.array(bugStatuses)]).optional(),
        severity: z.union([bugSeverities, z.array(bugSeverities)]).optional(),
        assignee: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().int().positive().optional(),
      }),
    },
    async (args) => ok(await store.listBugs(args)),
  );

  server.registerTool(
    'nexplan_bug_get',
    {
      title: 'Get a bug',
      description: 'Fetch a single bug by id (e.g. BUG-1).',
      inputSchema: z.object({ id: z.string() }),
    },
    async (args) => {
      const bug = await store.getBug(args.id);
      if (!bug) throw new Error(`bug not found: ${args.id}`);
      return ok(bug);
    },
  );

  server.registerTool(
    'nexplan_bug_update',
    {
      title: 'Update a bug',
      description: 'Update a bug (status, severity, assignee, workItem).',
      inputSchema: z.object({
        id: z.string(),
        status: bugStatuses.optional(),
        severity: bugSeverities.optional(),
        assignee: z.string().nullish(),
        workItem: z.string().nullish(),
        author: z.string().optional(),
      }),
    },
    async (args) => {
      const { id, author: aut, ...patch } = args;
      return ok(await store.updateBug(id, patch, author(aut)));
    },
  );

  // ------------------------------------------------------------------ board

  server.registerTool(
    'nexplan_status',
    {
      title: 'Project status',
      description: 'Summary counts by status and recent activity across the board.',
      inputSchema: z.object({}),
    },
    async () => ok(await store.boardSummary()),
  );

  server.registerTool(
    'nexplan_agent_next',
    {
      title: 'Suggest next item',
      description:
        'Suggest the next item for an agent to pick up: the top open critical/major bug ' +
        'if any, otherwise the highest-priority unowned backlog item.',
      inputSchema: z.object({ assignee: z.string().optional().describe('Your agent name.') }),
    },
    async (args) => {
      const assignee = args.assignee ?? 'agent';
      const bugs = await store.listBugs({ status: ['open', 'in_progress', 'reopened'] });
      const critical = bugs
        .filter((b) => b.severity === 'critical' || b.severity === 'major')
        .sort(bySeverity);
      if (critical.length > 0) {
        return ok({ recommendation: 'bug', bug: critical[0], reason: 'an open critical/major bug needs attention' });
      }
      const items = await store.listWorkItems({ status: ['backlog', 'todo'] });
      const candidates = items
        .filter((i) => i.status !== 'done' && i.status !== 'in_progress')
        .sort((a, b) => prioRank(a.priority) - prioRank(b.priority));
      if (candidates.length > 0) {
        return ok({
          recommendation: 'workitem',
          item: candidates[0],
          reason: 'highest-priority open backlog item',
        });
      }
      const openBugs = bugs.sort(bySeverity);
      if (openBugs.length > 0) {
        return ok({ recommendation: 'bug', bug: openBugs[0], reason: 'no open backlog; report to next open bug' });
      }
      return ok({ recommendation: 'none', reason: 'no open work remains' });
    },
  );
}

function prioRank(p: string): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[p] ?? 9;
}

function bySeverity(a: { severity: string }, b: { severity: string }): number {
  const rank: Record<string, number> = { critical: 0, major: 1, minor: 2, trivial: 3 };
  return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
}
