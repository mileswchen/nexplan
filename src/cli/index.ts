#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Workspace } from '../core/workspace.js';
import { getBoardRoot } from '../core/paths.js';
import { BugFilter, ListFilter } from '../core/types.js';
import { formatBug, formatBugFull, formatDoc, formatWorkItem, formatWorkItemFull } from './format.js';

const program = new Command();
program
  .name('nexplan')
  .description('NexPlan — git-backed, multi-project project management hub for coding agents.')
  .version('0.3.0')
  .option('--root <path>', 'Workspace dir (default: $NEXPLAN_BOARD or ./.nexplan)')
  .option('--project <key>', 'Project key (default: $NEXPLAN_PROJECT or the workspace default)')
  .option('--json', 'JSON output');

function root(): string {
  return program.opts().root || getBoardRoot();
}

// A shared Workspace (cached) so CLI operations share the same store instances
// and user/project registries for the duration of one process.
let _workspace: Workspace | null = null;
async function workspace(): Promise<Workspace> {
  if (!_workspace) {
    _workspace = new Workspace({ root: root(), agentName: process.env.NEXPLAN_AGENT || 'user', autoCommit: true });
    await _workspace.init();
  }
  return _workspace;
}

// Resolve the project key for board operations.
async function projectKey(): Promise<string> {
  const ws = await workspace();
  return ws.resolveProject(program.opts().project || process.env.NEXPLAN_PROJECT);
}

// A Store scoped to the selected project, with access control applied.
// `write=true` additionally enforces the viewer read-only rule.
async function store(write = false): Promise<Store> {
  const ws = await workspace();
  const key = await projectKey();
  const actor = process.env.NEXPLAN_AGENT || 'user';
  await ws.assertProjectAccess(key, actor, { write });
  return ws.getStore(key);
}

// Require the `admin` role for workspace management (no-op when permissions off).
async function requireAdmin(): Promise<void> {
  await (await workspace()).assertAdmin(process.env.NEXPLAN_AGENT || 'user');
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// Writes without returning a value so command actions stay `Promise<void>`.
function out(s: string): void {
  process.stdout.write(s);
}

// ---- work items --------------------------------------------------------------

program
  .command('add')
  .description('Add a work item to the backlog.')
  .argument('[title]', 'Title of the work item (or use --title).')
  .option('--title <title>', 'Title of the work item.')
  .option('--type <type>', 'Type: task|feature|refactor|chore|research|bug|docs.')
  .option('--description <text>', 'Description.')
  .option('--priority <p>', 'Priority: P0..P3.')
  .option('--assignee <name>', 'Assignee (agent name or user).')
  .option('--tags <tags>', 'Comma-separated tags.')
  .option('--estimate <n>', 'Estimate (points/hours).')
  .option('--fixes-bug <ids>', 'Comma-separated bug ids this item fixes.')
  .option('--manual', 'Mark source as manual (human-entered).')
  .option('--json-input', 'Read a JSON array of items from stdin instead of flags.')
  .action(async (title: string | undefined, opts: Record<string, string>) => {
    const s = await store(true);
    const items = [];
    const source = opts.manual ? 'manual' : undefined;
    if (opts.jsonInput) {
      const raw = await readStdin();
      const parsed = JSON.parse(raw);
      for (const it of Array.isArray(parsed) ? parsed : [parsed]) {
        items.push({ ...it, source: it.source ?? (opts.manual ? 'manual' : source) });
      }
    } else {
      items.push({
        title: title ?? opts.title,
        type: opts.type,
        description: opts.description,
        priority: opts.priority,
        assignee: opts.assignee,
        tags: split(opts.tags),
        estimate: opts.estimate ? Number(opts.estimate) : undefined,
        fixesBug: split(opts.fixesBug),
        source,
      });
    }
    const created = [];
    for (const it of items) {
      // Leave author undefined for non-manual adds so the store falls back to
      // NEXPLAN_AGENT (or 'user'), which keeps source attribution correct.
      created.push(await s.createWorkItem({ ...it, author: opts.manual ? 'user' : undefined }));
    }
    if (program.opts().json) return printJson(created);
    for (const w of created) process.stdout.write(formatWorkItem(w) + '\n');
  });

program
  .command('list')
  .alias('ls')
  .description('List work items.')
  .option('--status <s>', 'Filter by status (repeatable).')
  .option('--type <t>', 'Filter by type.')
  .option('--priority <p>', 'Filter by priority.')
  .option('--assignee <name>', 'Filter by assignee.')
  .option('--tags <tags>', 'Filter by tags (comma-separated).')
  .option('--query <q>', 'Full-text substring filter.')
  .option('--limit <n>', 'Max results.')
  .action(async (opts: Record<string, string>) => {
    const items = await (await store()).listWorkItems({
      status: opts.status ? [opts.status] : undefined,
      type: opts.type,
      priority: opts.priority,
      assignee: opts.assignee,
      tags: split(opts.tags),
      query: opts.query,
      limit: opts.limit ? Number(opts.limit) : undefined,
    } as ListFilter);
    if (program.opts().json) return printJson(items);
    if (!items.length) return out('(no work items)\n');
    for (const w of items) out(formatWorkItem(w) + '\n');
  });

program
  .command('get <id>')
  .description('Show a work item in full.')
  .action(async (id: string) => {
    const w = await (await store()).getWorkItem(id);
    if (!w) throw new Error(`work item not found: ${id}`);
    if (program.opts().json) return printJson(w);
    process.stdout.write(formatWorkItemFull(w) + '\n');
  });

program
  .command('claim <id>')
  .description('Claim a work item (assign + set in_progress).')
  .option('--assignee <name>', 'Who claims it.', 'agent')
  .option('--status <s>', 'Status to set.', 'in_progress')
  .action(async (id: string, opts: Record<string, string>) => {
    const w = await (await store(true)).claimWorkItem(id, opts.assignee, (opts.status as never) ?? 'in_progress');
    if (program.opts().json) return printJson(w);
    process.stdout.write(formatWorkItem(w) + '\n');
  });

program
  .command('update <id>')
  .description('Update a work item.')
  .option('--title <v>')
  .option('--description <v>')
  .option('--type <v>')
  .option('--priority <v>')
  .option('--status <v>')
  .option('--assignee <v>')
  .option('--tags <v>')
  .option('--estimate <n>')
  .action(async (id: string, opts: Record<string, string>) => {
    const patch: Record<string, unknown> = {};
    if (opts.title !== undefined) patch.title = opts.title;
    if (opts.description !== undefined) patch.description = opts.description;
    if (opts.type !== undefined) patch.type = opts.type;
    if (opts.priority !== undefined) patch.priority = opts.priority;
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.assignee !== undefined) patch.assignee = opts.assignee;
    if (opts.tags !== undefined) patch.tags = split(opts.tags);
    if (opts.estimate !== undefined) patch.estimate = Number(opts.estimate);
    const w = await (await store(true)).updateWorkItem(id, patch);
    if (program.opts().json) return printJson(w);
    process.stdout.write(formatWorkItem(w) + '\n');
  });

program
  .command('done <id>')
  .alias('complete')
  .description('Mark a work item done (auto-closes linked bugs).')
  .option('--note <text>', 'Completion note.')
  .option('--no-close-bugs', 'Do not auto-close linked bugs.')
  .action(async (id: string, opts: Record<string, string>) => {
    const closeBugs = (opts as unknown as { closeBugs?: boolean }).closeBugs !== false;
    const res = await (await store(true)).completeWorkItem(id, {
      note: opts.note,
      closeLinkedBugs: closeBugs,
    });
    if (program.opts().json) return printJson(res);
    out(formatWorkItem(res.item) + '\n');
    if (res.closedBugs.length) out('\nclosed bugs:\n' + res.closedBugs.map(formatBug).join('\n') + '\n');
  });

program
  .command('decompose <parentId>')
  .description('Split a parent item into child backlog items.')
  .option('--child <title>', 'Child title (repeatable).')
  .action(async (parentId: string, opts: Record<string, string[] | string>) => {
    const children = (typeof opts.child === 'string' ? [opts.child] : opts.child ?? []).map((t) => ({ title: t }));
    if (!children.length) throw new Error('provide at least one --child');
    const res = await (await store(true)).decomposeWorkItem(parentId, children);
    if (program.opts().json) return printJson(res);
    process.stdout.write(formatWorkItem(res.parent) + '\n');
    for (const c of res.children) process.stdout.write('  → ' + formatWorkItem(c) + '\n');
  });

program
  .command('note <id> <body>')
  .description('Add a note to a work item.')
  .action(async (id: string, body: string) => {
    const w = await (await store(true)).addWorkItemNote(id, body);
    if (program.opts().json) return printJson(w);
    process.stdout.write(formatWorkItem(w) + '\n');
  });

// ---- bugs --------------------------------------------------------------------

const bug = program.command('bug').description('Bug commands.');

bug
  .command('add <title>')
  .description('Add a bug.')
  .option('--description <text>')
  .option('--severity <s>', 'critical|major|minor|trivial.')
  .option('--evidence <text>', 'Stack trace / logs / repro.')
  .option('--tags <tags>')
  .option('--manual', 'Mark as human-entered.')
  .action(async (title: string, opts: Record<string, string>) => {
    const b = await (await store(true)).createBug({
      title,
      description: opts.description,
      severity: opts.severity as never,
      evidence: opts.evidence,
      tags: split(opts.tags),
      author: opts.manual ? 'user' : process.env.NEXPLAN_AGENT || 'agent',
    });
    if (program.opts().json) return printJson(b);
    process.stdout.write(formatBug(b) + '\n');
  });

bug
  .command('list')
  .alias('ls')
  .description('List bugs.')
  .option('--status <s>')
  .option('--severity <s>')
  .option('--assignee <name>')
  .option('--query <q>')
  .option('--limit <n>')
  .action(async (opts: Record<string, string>) => {
    const bugs = await (await store()).listBugs({
      status: opts.status ? [opts.status] : undefined,
      severity: opts.severity,
      assignee: opts.assignee,
      query: opts.query,
      limit: opts.limit ? Number(opts.limit) : undefined,
    } as BugFilter);
    if (program.opts().json) return printJson(bugs);
    if (!bugs.length) return out('(no bugs)\n');
    for (const b of bugs) out(formatBug(b) + '\n');
  });

bug
  .command('get <id>')
  .description('Show a bug in full.')
  .action(async (id: string) => {
    const b = await (await store()).getBug(id);
    if (!b) throw new Error(`bug not found: ${id}`);
    if (program.opts().json) return printJson(b);
    process.stdout.write(formatBugFull(b) + '\n');
  });

bug
  .command('update <id>')
  .description('Update a bug.')
  .option('--status <v>')
  .option('--severity <v>')
  .option('--assignee <v>')
  .option('--work-item <v>')
  .action(async (id: string, opts: Record<string, string>) => {
    const patch: Record<string, unknown> = {};
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.severity !== undefined) patch.severity = opts.severity;
    if (opts.assignee !== undefined) patch.assignee = opts.assignee;
    if (opts.workItem !== undefined) patch.workItem = opts.workItem;
    const b = await (await store(true)).updateBug(id, patch);
    if (program.opts().json) return printJson(b);
    process.stdout.write(formatBug(b) + '\n');
  });

// ---- docs --------------------------------------------------------------------

const docs = program.command('docs').description('Document commands.');

docs
  .command('list')
  .alias('ls')
  .description('List documents.')
  .action(async () => {
    const all = await (await store()).listDocs();
    if (program.opts().json) return printJson(all);
    if (!all.length) return out('(no docs)\n');
    for (const d of all) out(formatDoc(d) + '\n');
  });

docs
  .command('show <slug>')
  .description('Show a document (markdown).')
  .action(async (slug: string) => {
    const d = await (await store()).getDoc(slug);
    if (!d) throw new Error(`doc not found: ${slug}`);
    if (program.opts().json) return printJson(d);
    process.stdout.write(d.content + '\n');
  });

docs
  .command('new <title>')
  .description('Create a document from a title.')
  .option('--type <t>', 'design|decision|adr|architecture|notes.')
  .option('--body <text>', 'Initial markdown body.')
  .option('--status <s>', 'draft|review|approved|superseded.')
  .option('--tags <tags>')
  .option('--slug <slug>')
  .action(async (title: string, opts: Record<string, string>) => {
    const d = await (await store(true)).createDoc({
      title,
      type: opts.type as never,
      body: opts.body,
      status: opts.status as never,
      tags: split(opts.tags),
      slug: opts.slug,
    });
    if (program.opts().json) return printJson(d);
    process.stdout.write(`created ${d.slug} v${d.meta.version}\n`);
  });

docs
  .command('update <slug>')
  .description('Update a document (bump version).')
  .option('--content <text>', 'Replacement markdown content.')
  .option('--title <v>')
  .option('--type <v>')
  .option('--status <v>')
  .option('--tags <v>')
  .action(async (slug: string, opts: Record<string, string>) => {
    const patch: Record<string, unknown> = {};
    if (opts.content !== undefined) patch.content = opts.content;
    if (opts.title !== undefined) patch.title = opts.title;
    if (opts.type !== undefined) patch.type = opts.type;
    if (opts.status !== undefined) patch.status = opts.status;
    if (opts.tags !== undefined) patch.tags = split(opts.tags);
    const d = await (await store(true)).updateDoc(slug, patch);
    if (program.opts().json) return printJson(d);
    process.stdout.write(`${d.slug} → v${d.meta.version}\n`);
  });

docs
  .command('history <slug>')
  .description('Show version history.')
  .action(async (slug: string) => {
    const h = await (await store()).docHistory(slug);
    if (program.opts().json) return printJson(h);
    for (const v of h) process.stdout.write(`v${v.version}  ${v.sha.slice(0, 8)}  ${v.author}  ${formatDate(v.date)}  ${v.message}\n`);
  });

docs
  .command('diff <slug> <shaA> <shaB>')
  .description('Diff two versions of a document.')
  .action(async (slug: string, shaA: string, shaB: string) => {
    const d = await (await store()).docDiff(slug, shaA, shaB);
    process.stdout.write(d || '(no diff)\n');
  });

// ---- board -------------------------------------------------------------------

program
  .command('status')
  .description('Show a project board summary.')
  .action(async () => {
    const ws = await workspace();
    const key = await projectKey();
    await ws.assertProjectAccess(key, process.env.NEXPLAN_AGENT || 'user');
    const s = await ws.summary(key);
    if (program.opts().json) return printJson(s);
    out(`project: ${key}\n`);
    out(`work items: ${s.totalWorkItems}\n`);
    for (const [k, v] of Object.entries(s.workItems)) out(`  ${k}: ${v}\n`);
    out(`bugs: ${s.totalBugs}\n`);
    for (const [k, v] of Object.entries(s.bugs)) out(`  ${k}: ${v}\n`);
    out(`docs: ${s.docs}\n`);
    out('\nrecent activity:\n');
    for (const r of s.recent) out(`  ${formatDate(r.at)}  ${r.author}  ${r.action}\n`);
  });

// ---- projects & users ---------------------------------------------------------

const projectCmd = program.command('project').description('Project management.');

projectCmd
  .command('list')
  .alias('ls')
  .description('List projects in the workspace.')
  .action(async () => {
    const projects = await (await workspace()).listProjects();
    if (program.opts().json) return printJson(projects);
    const def = await (await workspace()).getDefaultProjectKey();
    for (const p of projects) out(`${p.key}  ${p.name}${p.key === def ? '  (default)' : ''}  ${p.members.length ? `[${p.members.join(',')}]` : ''}  ${p.description}\n`);
  });

projectCmd
  .command('new <key>')
  .description('Create a new project.')
  .option('--name <name>', 'Display name.')
  .option('--description <text>', 'Description.')
  .option('--members <ids>', 'Comma-separated user ids.')
  .action(async (key: string, opts: Record<string, string>) => {
    await requireAdmin();
    const p = await (await workspace()).createProject({ key, name: opts.name, description: opts.description, members: split(opts.members) });
    if (program.opts().json) return printJson(p);
    out(`created project ${p.key} — ${p.name}\n`);
  });

projectCmd
  .command('use <key>')
  .description('Set the default project.')
  .action(async (key: string) => {
    await requireAdmin();
    await (await workspace()).setDefaultProject(key);
    out(`default project → ${key}\n`);
  });

projectCmd
  .command('show <key>')
  .description('Show a project.')
  .action(async (key: string) => {
    const p = await (await workspace()).getProject(key);
    if (!p) throw new Error(`project not found: ${key}`);
    if (program.opts().json) return printJson(p);
    out(`${p.key} — ${p.name}\n`);
    out(`description: ${p.description || '-'}\n`);
    out(`members: ${p.members.join(', ') || '-'}\n`);
    out(`created: ${p.createdAt}\nupdated: ${p.updatedAt}\n`);
  });

projectCmd
  .command('rm <key>')
  .description('Delete a project (cannot delete the default).')
  .action(async (key: string) => {
    await requireAdmin();
    await (await workspace()).deleteProject(key);
    out(`deleted project ${key}\n`);
  });

const userCmd = program.command('user').description('User management.');

userCmd
  .command('list')
  .alias('ls')
  .description('List registered users.')
  .action(async () => {
    const users = await (await workspace()).listUsers();
    if (program.opts().json) return printJson(users);
    for (const u of users) out(`${u.id}  ${u.name}  ${u.kind}  ${u.role}\n`);
  });

userCmd
  .command('add <id>')
  .description('Register a user (human or agent).')
  .option('--name <name>', 'Display name.')
  .option('--kind <kind>', 'human | agent.')
  .option('--role <role>', 'admin | member | viewer.', 'member')
  .option('--password <password>', 'Optional login password (humans).')
  .action(async (id: string, opts: Record<string, string>) => {
    await requireAdmin();
    const u = await (await workspace()).createUser({ id, name: opts.name, kind: opts.kind as never, role: opts.role as never, password: opts.password });
    if (program.opts().json) return printJson(u);
    out(`added user ${u.id} (${u.role})${u.passwordHash ? ' with a password' : ''}\n`);
  });

userCmd
  .command('password <id> [password]')
  .description('Set or reset a user login password.')
  .action(async (id: string, password: string | undefined) => {
    await requireAdmin();
    await (await workspace()).setUserPassword(id, password || '');
    out(`password set for ${id}\n`);
  });

userCmd
  .command('role <id> <role>')
  .description('Set a user role (admin | member | viewer).')
  .action(async (id: string, role: string) => {
    await requireAdmin();
    const u = await (await workspace()).updateUser(id, { role: role as never });
    if (program.opts().json) return printJson(u);
    out(`${u.id} → ${u.role}\n`);
  });

userCmd
  .command('rm <id>')
  .description('Remove a user.')
  .action(async (id: string) => {
    await requireAdmin();
    await (await workspace()).deleteUser(id);
    out(`removed user ${id}\n`);
  });

const configCmd = program.command('config').description('Workspace configuration.');

configCmd
  .command('set-enforce-permissions <true|false>')
  .description('Toggle strict permissions (registered users only, viewer is read-only).')
  .action(async (v: string) => {
    await requireAdmin();
    const bool = /^(true|1|yes)$/i.test(v);
    await (await workspace()).setEnforcePermissions(bool);
    out(`enforcePermissions=${bool}\n`);
  });

// ---- agent config broadcast ----------------------------------------------------

const agentCmd = program.command('agent').description('Agent config helpers.');

agentCmd
  .command('config <user-id>')
  .description('Print an MCP config snippet scoped to a user (agent) + project, reflecting its role/membership.')
  .action(async (id: string) => {
    const ws = await workspace();
    const proj = program.opts().project || (await ws.getDefaultProjectKey());
    const user = await ws.getUser(id);
    const project = await ws.getProject(proj);
    const role = user?.role || 'member';
    const member = project?.members?.includes(id);
    const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
    const config = {
      mcpServers: {
        nexplan: {
          command: 'node',
          args: [serverPath],
          env: {
            NEXPLAN_BOARD: root(),
            NEXPLAN_PROJECT: proj,
            NEXPLAN_AGENT: id,
          },
        },
      },
    };
    if (program.opts().json) return printJson(config);
    out(`${id} → role=${role}, project=${proj}${project ? `, member=${member ? 'yes' : 'no'}` : `, project "${proj}" not found`}\n\n`);
    out('Add this to your agent\'s MCP server config:\n');
    out(JSON.stringify(config, null, 2) + '\n');
    out(`\nAccess note: the agent acts as "${id}" (${role}). Grant access by adding ${id} to project "${proj}" members, or grant the admin role.\n`);
  });

program
  .command('web')
  .description('Start the NexPlan web dashboard.')
  .option('--port <n>', 'Port (default 3344).', '3344')
  .action(async (opts: Record<string, string>) => {
    const { startWebServer } = await import('../web/server.js');
    await startWebServer({ port: Number(opts.port), root: root() });
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`[nexplan] ${(err as Error).message}\n`);
  process.exit(1);
});

function split(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}
