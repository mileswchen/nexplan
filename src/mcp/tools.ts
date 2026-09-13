import { z } from 'zod';
import { Workspace } from '../core/workspace.js';
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
const USER_ROLES = ['admin', 'member', 'viewer'] as const;
const USER_KINDS = ['human', 'agent'] as const;
const TESTCASE_TYPES = [
  'functional',
  'regression',
  'integration',
  'e2e',
  'performance',
  'security',
  'usability',
  'other',
] as const;
const TESTCASE_STATUSES = ['draft', 'active', 'deprecated'] as const;
const TEST_RESULTS = ['pass', 'fail', 'blocked', 'skipped'] as const;

const priorities = z.enum(PRIORITIES);
const itemTypes = z.enum(ITEM_TYPES);
const itemStatuses = z.enum(ITEM_STATUSES);
const bugSeverities = z.enum(BUG_SEVERITIES);
const bugStatuses = z.enum(BUG_STATUSES);
const docTypes = z.enum(DOC_TYPES);
const docStatus = z.enum(DOC_STATUS);
const userRoles = z.enum(USER_ROLES);
const userKinds = z.enum(USER_KINDS);
const testCaseTypes = z.enum(TESTCASE_TYPES);
const testCaseStatuses = z.enum(TESTCASE_STATUSES);
const testResults = z.enum(TEST_RESULTS);

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

// Resolve the project + store + acting author for a tool call.
// `project` defaults to $NEXPLAN_PROJECT, then the workspace default. Access is
// gated by the project's member roster (and strict mode) via the workspace.
async function projectStore(workspace: Workspace, args: Record<string, unknown>, opts: { write?: boolean } = {}) {
  const project = await workspace.resolveProject(args.project as string | undefined);
  const store = workspace.getStore(project);
  const actor = (args.author as string) || process.env.NEXPLAN_AGENT || 'agent';
  await workspace.assertProjectAccess(project, actor, { write: opts.write });
  return { store, project, actor };
}

export function registerNexplanTools(server: McpServer, workspace: Workspace): void {
  const projectOpt = z.string().optional().describe('Project key. Defaults to the workspace default project.');

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
    docLink: z.string().optional().describe('URL of the design document for this item.'),
  });

  server.registerTool(
    'nexplan_backlog_add',
    {
      title: 'Add backlog items',
      description:
        'Add one or more work items to the backlog. Use this to enter decomposed tasks. ' +
        'Set `author` to your agent name for attribution. `project` selects the project.',
      inputSchema: z.object({
        items: z.array(addItemSchema).min(1),
        author: z.string().optional().describe('Attribution (agent or user name).'),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const created = [];
      for (const it of args.items) {
        created.push(
          await store.createWorkItem({
            ...it,
            author: actor,
            source: actor === 'user' ? 'manual' : it.source,
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
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.listWorkItems(args as never));
    },
  );

  server.registerTool(
    'nexplan_backlog_get',
    {
      title: 'Get a backlog item',
      description: 'Fetch a single work item by id (e.g. WI-3).',
      inputSchema: z.object({ id: z.string().describe('Work item id, e.g. WI-3.'), project: projectOpt }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
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
        'Call before starting work on an item.',
      inputSchema: z.object({
        id: z.string().describe('Work item id, e.g. WI-3.'),
        assignee: z.string().describe('Who is claiming it (your agent name).'),
        status: itemStatuses.optional(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.claimWorkItem(args.id, args.assignee || actor, args.status ?? 'in_progress', actor));
    },
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
        docLink: z.string().nullish(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const { id, author: _a, project: _p, ...patch } = args;
      return ok(await store.updateWorkItem(id, patch as never, actor));
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
        force: z.boolean().optional().describe('Complete even when linked test cases are failing or not run.'),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { project, actor } = await projectStore(workspace, args, { write: true });
      return ok(
        await workspace.completeWorkItem(project, args.id, {
          note: args.note,
          closeLinkedBugs: args.closeLinkedBugs,
          force: args.force,
          author: actor,
        }),
      );
    },
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
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.decomposeWorkItem(args.parentId, args.children, actor));
    },
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
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.addWorkItemNote(args.id, args.body, actor));
    },
  );

  server.registerTool(
    'nexplan_backlog_delete',
    {
      title: 'Delete a backlog item',
      description:
        'Delete a work item. Only the item\'s creator or a project admin (role=admin) can ' +
        'delete it; members can edit but not remove. An item that still has child items ' +
        'cannot be deleted — delete the children first.',
      inputSchema: z.object({
        id: z.string().describe('Work item id, e.g. WI-3.'),
        author: z.string().optional().describe('Deleting actor (your agent/user name).'),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { project, actor } = await projectStore(workspace, args, { write: true });
      return ok(await workspace.deleteWorkItem(project, args.id, actor));
    },
  );

  // ------------------------------------------------------------------- docs

  server.registerTool(
    'nexplan_docs_list',
    { title: 'List documents', description: 'List design/decision documents with their metadata.', inputSchema: z.object({ project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.listDocs());
    },
  );

  server.registerTool(
    'nexplan_docs_get',
    { title: 'Get a document', description: 'Fetch a document by slug (file name without .md).', inputSchema: z.object({ slug: z.string(), project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      const doc = await store.getDoc(args.slug);
      if (!doc) throw new Error(`doc not found: ${args.slug}`);
      return ok(doc);
    },
  );

  server.registerTool(
    'nexplan_docs_create',
    {
      title: 'Create a document',
      description: 'Create a new design/decision/ADR document. Content is markdown; version starts at 1.',
      inputSchema: z.object({
        title: z.string().min(1),
        type: docTypes.optional(),
        body: z.string().optional().describe('Markdown content.'),
        status: docStatus.optional(),
        tags: z.array(z.string()).optional(),
        slug: z.string().optional(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.createDoc({ ...args, author: actor }));
    },
  );

  server.registerTool(
    'nexplan_docs_update',
    {
      title: 'Update a document',
      description: 'Update a document (content/status/title/type/tags). Bumps the version number and records a version in git.',
      inputSchema: z.object({
        slug: z.string(),
        content: z.string().optional().describe('Replacement markdown content.'),
        title: z.string().optional(),
        type: docTypes.optional(),
        status: docStatus.optional(),
        tags: z.array(z.string()).optional(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const { slug, author: _a, project: _p, ...patch } = args;
      return ok(await store.updateDoc(slug, patch as never, actor));
    },
  );

  server.registerTool(
    'nexplan_docs_history',
    { title: 'Document version history', description: 'List the version history (git commits) of a document, newest first.', inputSchema: z.object({ slug: z.string(), limit: z.number().int().positive().optional(), project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.docHistory(args.slug, args.limit ?? 100));
    },
  );

  server.registerTool(
    'nexplan_docs_diff',
    { title: 'Diff two document versions', description: 'Show a git diff of a document between two commits in a project.', inputSchema: z.object({ slug: z.string(), shaA: z.string(), shaB: z.string(), project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.docDiff(args.slug, args.shaA, args.shaB));
    },
  );

  server.registerTool(
    'nexplan_docs_comment',
    {
      title: 'Comment on a document',
      description:
        'Append a comment to a document (kept separate from the versioned body). ' +
        'Only a project member or admin can comment.',
      inputSchema: z.object({
        slug: z.string(),
        body: z.string().min(1),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.addDocComment(args.slug, args.body, actor));
    },
  );

  // ------------------------------------------------------------------- bugs

  server.registerTool(
    'nexplan_bug_add',
    {
      title: 'Add a bug',
      description: 'Report a bug. Use this when you discover a defect automatically. Include evidence such as stack traces/logs.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        severity: bugSeverities.optional(),
        evidence: z.string().optional().describe('Stack trace, log lines, repro steps.'),
        tags: z.array(z.string()).optional(),
        workItem: z.string().nullish(),
        assignee: z.string().nullish(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      return ok(await store.createBug({ ...args, author: actor }));
    },
  );

  server.registerTool(
    'nexplan_bug_list',
    { title: 'List bugs', description: 'List/filter bugs in a project.', inputSchema: z.object({ status: z.union([bugStatuses, z.array(bugStatuses)]).optional(), severity: z.union([bugSeverities, z.array(bugSeverities)]).optional(), assignee: z.string().optional(), query: z.string().optional(), limit: z.number().int().positive().optional(), project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.listBugs(args as never));
    },
  );

  server.registerTool(
    'nexplan_bug_get',
    { title: 'Get a bug', description: 'Fetch a single bug by id (e.g. BUG-1).', inputSchema: z.object({ id: z.string(), project: projectOpt }) },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      const bug = await store.getBug(args.id);
      if (!bug) throw new Error(`bug not found: ${args.id}`);
      return ok(bug);
    },
  );

  server.registerTool(
    'nexplan_bug_update',
    { title: 'Update a bug', description: 'Update a bug (status, severity, assignee, workItem).', inputSchema: z.object({ id: z.string(), status: bugStatuses.optional(), severity: bugSeverities.optional(), assignee: z.string().nullish(), workItem: z.string().nullish(), author: z.string().optional(), project: projectOpt }) },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const { id, author: _a, project: _p, ...patch } = args;
      return ok(await store.updateBug(id, patch as never, actor));
    },
  );

  // ------------------------------------------------------------------ board

  server.registerTool(
    'nexplan_status',
    { title: 'Project status', description: 'Summary counts by status and recent activity for a project.', inputSchema: z.object({ project: projectOpt }) },
    async (args) => ok(await workspace.summary(args.project as string | undefined)),
  );

  server.registerTool(
    'nexplan_agent_next',
    {
      title: 'Suggest next item',
      description: 'Suggest the next item for an agent: the top open critical/major bug if any, otherwise the highest-priority unowned backlog item.',
      inputSchema: z.object({ assignee: z.string().optional(), project: projectOpt }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      const assignee = args.assignee ?? 'agent';
      const bugs = await store.listBugs({ status: ['open', 'in_progress', 'reopened'] });
      const critical = bugs.filter((b) => b.severity === 'critical' || b.severity === 'major').sort(bySeverity);
      if (critical.length > 0) return ok({ recommendation: 'bug', bug: critical[0], reason: 'an open critical/major bug needs attention' });
      const items = await store.listWorkItems({ status: ['backlog', 'todo'] });
      const candidates = items.filter((i) => i.status !== 'done' && i.status !== 'in_progress').sort((a, b) => prioRank(a.priority) - prioRank(b.priority));
      if (candidates.length > 0) return ok({ recommendation: 'workitem', item: candidates[0], reason: 'highest-priority open backlog item' });
      if (bugs.length > 0) return ok({ recommendation: 'bug', bug: bugs.sort(bySeverity)[0], reason: 'no open backlog; report to next open bug' });
      return ok({ recommendation: 'none', reason: 'no open work remains' });
    },
  );

  // ------------------------------------------- multi-user / multi-project

  server.registerTool(
    'nexplan_project_list',
    { title: 'List projects', description: 'List projects in the workspace.', inputSchema: z.object({}) },
    async () => ok(await workspace.listProjects()),
  );

  server.registerTool(
    'nexplan_project_create',
    {
      title: 'Create a project',
      description: 'Create a new project with its own backlog, bugs and docs.',
      inputSchema: z.object({
        key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).describe('Unique project key, e.g. api.'),
        name: z.string().optional(),
        description: z.string().optional(),
        members: z.array(z.string()).optional().describe('User ids with access to this project.'),
        author: z.string().optional(),
      }),
    },
    async (args) => {
      await workspace.assertAdmin(args.author ?? 'agent');
      return ok(await workspace.createProject({ key: args.key, name: args.name, description: args.description, members: args.members }));
    },
  );

  server.registerTool(
    'nexplan_project_set_default',
    { title: 'Set the default project', description: 'Set the workspace default project used when a call omits `project`.', inputSchema: z.object({ key: z.string(), author: z.string().optional() }) },
    async (args) => {
      await workspace.assertAdmin(args.author ?? 'agent');
      await workspace.setDefaultProject(args.key);
      return ok({ ok: true, defaultProject: args.key });
    },
  );

  server.registerTool(
    'nexplan_user_list',
    { title: 'List users', description: 'List registered users (humans + agents).', inputSchema: z.object({}) },
    async () => ok(await workspace.listUsers()),
  );

  server.registerTool(
    'nexplan_user_add',
    {
      title: 'Add a user',
      description: 'Register a user (human or agent) with a role: admin | member | viewer.',
      inputSchema: z.object({ id: z.string(), name: z.string().optional(), kind: userKinds.optional(), role: userRoles.optional(), author: z.string().optional() }),
    },
    async (args) => {
      await workspace.assertAdmin(args.author ?? 'agent');
      return ok(await workspace.createUser({ id: args.id, name: args.name, kind: args.kind, role: args.role }));
    },
  );

  server.registerTool(
    'nexplan_user_update',
    { title: 'Update a user', description: 'Change a user\'s name, kind or role.', inputSchema: z.object({ id: z.string(), name: z.string().optional(), kind: userKinds.optional(), role: userRoles.optional(), author: z.string().optional() }) },
    async (args) => {
      await workspace.assertAdmin(args.author ?? 'agent');
      return ok(await workspace.updateUser(args.id, { name: args.name, kind: args.kind, role: args.role }));
    },
  );

  // ---------------------------------------------- test cases / test runs

  const testCaseBody = z.object({
    title: z.string().min(1),
    description: z.string().optional().describe('Purpose / scope of the case.'),
    type: testCaseTypes.optional().describe('Default: functional.'),
    priority: priorities.optional().describe('P0..P3 (maps to bug severity when a run fails). Default: P2.'),
    status: testCaseStatuses.optional().describe('Default: draft; pass active to make it count in reports.'),
    preconditions: z.string().optional(),
    steps: z
      .array(z.object({ action: z.string(), expected: z.string() }))
      .optional()
      .describe('Ordered steps with their expected result.'),
    tags: z.array(z.string()).optional(),
    workItem: z.string().nullish().describe('Work item (WI-N) this case verifies.'),
    bugs: z.array(z.string()).optional().describe('Bug ids (BUG-N) this case guards.'),
    automated: z.boolean().optional(),
    testFile: z.string().nullish().describe('Automation locator, e.g. "test/store.test.ts::claims an item".'),
  });

  server.registerTool(
    'nexplan_test_case_add',
    {
      title: 'Add test cases',
      description:
        'Create one or more reusable test cases. Link them to a work item with `workItem` so ' +
        'verification and reports can trace them. Set status=active to include them in reports.',
      inputSchema: z.object({
        items: z.array(testCaseBody).min(1),
        author: z.string().optional().describe('Attribution (agent or user name).'),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const created = [];
      for (const item of args.items) created.push(await store.createTestCase({ ...item, author: actor }));
      return ok({ created, count: created.length });
    },
  );

  server.registerTool(
    'nexplan_test_case_list',
    {
      title: 'List test cases',
      description: 'List/filter test cases with their latest execution result (pass|fail|blocked|skipped|notRun).',
      inputSchema: z.object({
        status: z.union([testCaseStatuses, z.array(testCaseStatuses)]).optional(),
        type: z.union([testCaseTypes, z.array(testCaseTypes)]).optional(),
        priority: z.union([priorities, z.array(priorities)]).optional(),
        workItem: z.string().optional().describe('Only cases linked to this work item.'),
        bug: z.string().optional(),
        tags: z.array(z.string()).optional(),
        automated: z.boolean().optional(),
        lastResult: z.union([testResults, z.literal('notRun')]).optional(),
        query: z.string().optional(),
        limit: z.number().int().positive().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(await store.listTestCases(args as never));
    },
  );

  server.registerTool(
    'nexplan_test_case_get',
    {
      title: 'Get a test case',
      description: 'Fetch one test case plus its recent execution history (newest first).',
      inputSchema: z.object({
        id: z.string().describe('Test case id, e.g. TC-3.'),
        history: z.number().int().positive().optional().describe('How many recent runs to include. Default 10.'),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      const testCase = await store.getTestCase(args.id);
      if (!testCase) throw new Error(`test case not found: ${args.id}`);
      const history = await store.testCaseHistory(args.id, args.history ?? 10);
      return ok({ testCase, history });
    },
  );

  server.registerTool(
    'nexplan_test_case_update',
    {
      title: 'Update a test case',
      description: 'Update any editable field of a test case (including status → deprecated).',
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        type: testCaseTypes.optional(),
        priority: priorities.optional(),
        status: testCaseStatuses.optional(),
        preconditions: z.string().optional(),
        steps: z.array(z.object({ action: z.string(), expected: z.string() })).optional(),
        tags: z.array(z.string()).optional(),
        workItem: z.string().nullish(),
        bugs: z.array(z.string()).optional(),
        automated: z.boolean().optional(),
        testFile: z.string().nullish(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const { id, author: _a, project: _p, ...patch } = args;
      return ok(await store.updateTestCase(id, patch as never, actor));
    },
  );

  server.registerTool(
    'nexplan_test_case_delete',
    {
      title: 'Delete a test case',
      description:
        'Delete a test case. Only its creator or an admin can delete it. Refuses while execution ' +
        'records exist unless `force` is set (which deletes those runs too).',
      inputSchema: z.object({
        id: z.string(),
        force: z.boolean().optional(),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { project, actor } = await projectStore(workspace, args, { write: true });
      return ok(await workspace.deleteTestCase(project, args.id, actor, { force: args.force }));
    },
  );

  server.registerTool(
    'nexplan_test_run_record',
    {
      title: 'Record test executions',
      description:
        'Record one or more test executions (the whole suite in a single call). Each run is an ' +
        'immutable snapshot; a failing run can file a bug automatically (createBugOnFailure, default true), ' +
        'a passing run advances the guarded bugs (open→fixed, and fixed→verified with verifyBugs). ' +
        'Provide `caseId`, or `caseTitle` to reuse/auto-create a case.',
      inputSchema: z.object({
        runs: z
          .array(
            z.object({
              caseId: z.string().optional().describe('Existing test case id (TC-N).'),
              caseTitle: z.string().optional().describe('Case title; reused when it matches, otherwise auto-created.'),
              result: testResults,
              actual: z.string().optional().describe('Observed result.'),
              evidence: z.string().optional().describe('Logs, stack trace, artifact paths.'),
              environment: z.string().optional().describe('e.g. local | ci | staging.'),
              build: z.string().optional().describe('Build / version / commit.'),
              batch: z.string().optional().describe('Batch label, e.g. "v0.4.0 regression".'),
              durationMs: z.number().nonnegative().nullish(),
              executedAt: z.string().optional().describe('ISO timestamp; defaults to now.'),
            }),
          )
          .min(1),
        batch: z.string().optional().describe('Default batch label for every run in this call.'),
        createBugOnFailure: z.boolean().optional().describe('Default true.'),
        verifyBugs: z.boolean().optional().describe('Default false; advances fixed bugs to verified on pass.'),
        autoCreateCase: z.boolean().optional().describe('Default true.'),
        author: z.string().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store, actor } = await projectStore(workspace, args, { write: true });
      const results = await store.recordTestRuns(
        args.runs.map((run) => ({
          ...run,
          batch: run.batch ?? args.batch,
          author: actor,
          createBugOnFailure: args.createBugOnFailure !== false,
          verifyBugs: args.verifyBugs === true,
          autoCreateCase: args.autoCreateCase !== false,
        })),
      );
      return ok({
        runs: results.map((r) => r.run),
        createdBugs: results.flatMap((r) => r.createdBugs),
        updatedBugs: results.flatMap((r) => r.updatedBugs),
        count: results.length,
      });
    },
  );

  server.registerTool(
    'nexplan_test_run_list',
    {
      title: 'List test executions',
      description: 'List execution records, hot and archived merged by default. Use hotOnly to skip archived runs.',
      inputSchema: z.object({
        caseId: z.string().optional(),
        result: z.union([testResults, z.array(testResults)]).optional(),
        build: z.string().optional(),
        batch: z.string().optional(),
        environment: z.string().optional(),
        workItem: z.string().optional(),
        executedBy: z.string().optional(),
        since: z.string().optional().describe('ISO lower bound on executedAt.'),
        until: z.string().optional().describe('ISO upper bound on executedAt.'),
        from: z.string().optional().describe('Alias of `since`.'),
        to: z.string().optional().describe('Alias of `until`.'),
        includeArchived: z.boolean().optional().describe('Default true.'),
        hotOnly: z.boolean().optional().describe('Default false; true = ignore archived runs.'),
        limit: z.number().int().positive().optional(),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      const filter = {
        ...args,
        since: args.since ?? args.from,
        until: args.until ?? args.to,
        includeArchived: args.hotOnly ? false : args.includeArchived,
      };
      return ok(await store.listTestRuns(filter as never));
    },
  );

  server.registerTool(
    'nexplan_test_report',
    {
      title: 'Test report',
      description:
        'Pass rate, not-run cases, failing cases, flaky cases and work-item coverage for a batch, ' +
        'build, work item or time range.',
      inputSchema: z.object({
        batch: z.string().optional(),
        build: z.string().optional(),
        workItem: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        hotOnly: z.boolean().optional().describe('Default false; true = ignore archived runs.'),
        project: projectOpt,
      }),
    },
    async (args) => {
      const { store } = await projectStore(workspace, args);
      return ok(
        await store.testReport({
          batch: args.batch,
          build: args.build,
          workItem: args.workItem,
          since: args.from,
          until: args.to,
          includeArchived: !args.hotOnly,
        }),
      );
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
