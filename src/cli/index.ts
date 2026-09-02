#!/usr/bin/env node
import { Command } from 'commander';
import { Store } from '../core/store.js';
import { getBoardRoot } from '../core/paths.js';
import { BugFilter, ListFilter } from '../core/types.js';
import { formatBug, formatBugFull, formatDoc, formatWorkItem, formatWorkItemFull } from './format.js';

async function openStore(): Promise<Store> {
  const store = new Store({ root: getBoardRoot(), agentName: process.env.NEXPLAN_AGENT || 'user', autoCommit: true });
  await store.init();
  return store;
}

const program = new Command();
program
  .name('nexplan')
  .description('NexPlan — git-backed project management hub for coding agents.')
  .version('0.1.0')
  .option('--root <path>', 'Board directory (default: $NEXPLAN_BOARD or ./.nexplan)')
  .option('--json', 'JSON output');

function root(): string {
  return program.opts().root || getBoardRoot();
}

function store(): Promise<Store> {
  const s = new Store({ root: root(), agentName: process.env.NEXPLAN_AGENT || 'user', autoCommit: true });
  return s.init().then(() => s);
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
    const s = await store();
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
    const w = await (await store()).claimWorkItem(id, opts.assignee, (opts.status as never) ?? 'in_progress');
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
    const w = await (await store()).updateWorkItem(id, patch);
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
    const res = await (await store()).completeWorkItem(id, {
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
    const res = await (await store()).decomposeWorkItem(parentId, children);
    if (program.opts().json) return printJson(res);
    process.stdout.write(formatWorkItem(res.parent) + '\n');
    for (const c of res.children) process.stdout.write('  → ' + formatWorkItem(c) + '\n');
  });

program
  .command('note <id> <body>')
  .description('Add a note to a work item.')
  .action(async (id: string, body: string) => {
    const w = await (await store()).addWorkItemNote(id, body);
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
    const b = await (await store()).createBug({
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
    const b = await (await store()).updateBug(id, patch);
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
    const d = await (await store()).createDoc({
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
    const d = await (await store()).updateDoc(slug, patch);
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
  .description('Show board summary.')
  .action(async () => {
    const s = await (await store()).boardSummary();
    if (program.opts().json) return printJson(s);
    process.stdout.write(`work items: ${s.totalWorkItems}\n`);
    for (const [k, v] of Object.entries(s.workItems)) process.stdout.write(`  ${k}: ${v}\n`);
    process.stdout.write(`bugs: ${s.totalBugs}\n`);
    for (const [k, v] of Object.entries(s.bugs)) process.stdout.write(`  ${k}: ${v}\n`);
    process.stdout.write(`docs: ${s.docs}\n`);
    process.stdout.write('\nrecent activity:\n');
    for (const r of s.recent) process.stdout.write(`  ${formatDate(r.at)}  ${r.author}  ${r.action}\n`);
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
