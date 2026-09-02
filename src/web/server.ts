import express, { Request, Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Workspace } from '../core/workspace.js';
import { BugFilter, ListFilter } from '../core/types.js';

export interface WebServerOptions {
  port?: number;
  host?: string;
  root?: string; // workspace root
}

async function findPackageRoot(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      await fs.access(path.join(dir, 'package.json'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

export async function startWebServer(opts: WebServerOptions = {}): Promise<void> {
  const boardRoot = opts.root || process.env.NEXPLAN_BOARD || path.join(process.cwd(), '.nexplan');
  const workspace = new Workspace({
    root: boardRoot,
    agentName: process.env.NEXPLAN_AGENT || 'user',
    autoCommit: true,
  });
  await workspace.init();

  // The web dashboard acts as NEXPLAN_AGENT (or 'user') for permission checks.
  const webActor = () => process.env.NEXPLAN_AGENT || 'user';

  // Resolve the project store for a request. `?project=<key>` overrides
  // $NEXPLAN_PROJECT, which overrides the workspace default. Access is gated by
  // the project's member roster (and strict mode).
  async function storeFor(req: Request, write = false): Promise<Store> {
    const key = await workspace.resolveProject((req.query.project as string) || process.env.NEXPLAN_PROJECT);
    await workspace.assertProjectAccess(key, webActor(), { write });
    return workspace.getStore(key);
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const pkgRoot = await findPackageRoot();
  const publicDir = path.join(pkgRoot, 'public');
  app.use(express.static(publicDir));

  // ------------------------------------------------------------ workspace
  app.get('/api/workspace', async (_req, res, next) => {
    try {
      const cfg = await workspace.getConfig();
      const projects = await workspace.listProjects();
      const users = await workspace.listUsers();
      const current = await workspace.resolveProject();
      res.json({ ...cfg, currentProject: current, projects, users });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workspace/default-project', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      await workspace.setDefaultProject(req.body.key);
      res.json({ ok: true, defaultProject: req.body.key });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workspace/enforce-permissions', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      await workspace.setEnforcePermissions(Boolean(req.body.value));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ projects
  app.get('/api/projects', async (_req, res, next) => {
    try {
      res.json(await workspace.listProjects());
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/projects/stats', async (_req, res, next) => {
    try {
      res.json(await workspace.projectsStats());
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/projects', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      const { key, name, description, members } = req.body;
      res.status(201).json(await workspace.createProject({ key, name, description, members }));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/projects/:key', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      const { name, description, members } = req.body;
      res.json(await workspace.updateProject(req.params.key, { name, description, members }));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/projects/:key', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      await workspace.deleteProject(req.params.key);
      res.json({ ok: true, key: req.params.key });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ users
  app.get('/api/users', async (_req, res, next) => {
    try {
      res.json(await workspace.listUsers());
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/users', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      const { id, name, kind, role } = req.body;
      res.status(201).json(await workspace.createUser({ id, name, kind, role }));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/users/:id', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      const { name, kind, role } = req.body;
      res.json(await workspace.updateUser(req.params.id, { name, kind, role }));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/users/:id', async (req, res, next) => {
    try {
      await workspace.assertAdmin(webActor());
      await workspace.deleteUser(req.params.id);
      res.json({ ok: true, id: req.params.id });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ work items
  app.get('/api/board', async (req, res, next) => {
    try {
      const key = await workspace.resolveProject((req.query.project as string) || process.env.NEXPLAN_PROJECT);
      await workspace.assertProjectAccess(key, webActor());
      res.json(await workspace.summary(key));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/workitems', async (req, res, next) => {
    try {
      const store = await storeFor(req);
      const { status, type, priority, assignee, tags, query, limit } = req.query;
      const items = await store.listWorkItems({
        status: status ? String(status).split(',') : undefined,
        type: type ? String(type).split(',') : undefined,
        priority: priority ? String(priority).split(',') : undefined,
        assignee: assignee ? String(assignee) : undefined,
        tags: tags ? String(tags).split(',') : undefined,
        query: query ? String(query) : undefined,
        limit: limit ? Number(limit) : undefined,
      } as unknown as ListFilter);
      res.json(items);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/workitems/:id', async (req, res, next) => {
    try {
      const item = await (await storeFor(req)).getWorkItem(req.params.id);
      if (!item) return res.status(404).json({ error: 'work item not found' });
      res.json(item);
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems', async (req, res, next) => {
    try {
      const store = await storeFor(req, true);
      const items = Array.isArray(req.body) ? req.body : [req.body];
      const created = [];
      for (const it of items) created.push(await store.createWorkItem({ ...it, author: it.author ?? 'user' }));
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/workitems/:id', async (req, res, next) => {
    try {
      const { author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateWorkItem(req.params.id, patch, author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/claim', async (req, res, next) => {
    try {
      const { assignee, status, author } = req.body;
      res.json(await (await storeFor(req, true)).claimWorkItem(req.params.id, assignee || 'user', status ?? 'in_progress', author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/complete', async (req, res, next) => {
    try {
      const { note, closeLinkedBugs, author } = req.body;
      res.json(await (await storeFor(req, true)).completeWorkItem(req.params.id, { note, closeLinkedBugs, author: author ?? 'user' }));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/note', async (req, res, next) => {
    try {
      const { body, author } = req.body;
      res.json(await (await storeFor(req, true)).addWorkItemNote(req.params.id, body, author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/decompose', async (req, res, next) => {
    try {
      const { children, author } = req.body;
      res.json(await (await storeFor(req, true)).decomposeWorkItem(req.params.id, children ?? [], author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------------ bugs
  app.get('/api/bugs', async (req, res, next) => {
    try {
      const store = await storeFor(req);
      const { status, severity, assignee, query, limit } = req.query;
      const bugs = await store.listBugs({
        status: status ? String(status).split(',') : undefined,
        severity: severity ? String(severity).split(',') : undefined,
        assignee: assignee ? String(assignee) : undefined,
        query: query ? String(query) : undefined,
        limit: limit ? Number(limit) : undefined,
      } as unknown as BugFilter);
      res.json(bugs);
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/bugs', async (req, res, next) => {
    try {
      const b = await (await storeFor(req, true)).createBug({ ...req.body, author: req.body.author ?? 'user' });
      res.status(201).json(b);
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/bugs/:id', async (req, res, next) => {
    try {
      const { author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateBug(req.params.id, patch, author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------------ docs
  app.get('/api/docs', async (req, res, next) => {
    try {
      res.json(await (await storeFor(req)).listDocs());
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/docs/:slug', async (req, res, next) => {
    try {
      const doc = await (await storeFor(req)).getDoc(req.params.slug);
      if (!doc) return res.status(404).json({ error: 'doc not found' });
      res.json(doc);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/docs/:slug/history', async (req, res, next) => {
    try {
      res.json(await (await storeFor(req)).docHistory(req.params.slug));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/docs/:slug/diff', async (req, res, next) => {
    try {
      const { shaA, shaB } = req.query;
      res.json({ diff: await (await storeFor(req)).docDiff(req.params.slug, String(shaA), String(shaB)) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/docs', async (req, res, next) => {
    try {
      const { author, ...input } = req.body;
      res.status(201).json(await (await storeFor(req, true)).createDoc({ ...input, author: author ?? 'user' }));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/docs/:slug', async (req, res, next) => {
    try {
      const { author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateDoc(req.params.slug, patch, author ?? 'user'));
    } catch (e) {
      next(e);
    }
  });

  // fallthrough (SPA routing)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  const port = opts.port ?? Number(process.env.PORT ?? 3344);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const server = app.listen(port, host, () => {
    process.stdout.write(`\n  NexPlan dashboard → http://${host}:${port}\n`);
    process.stdout.write(`  workspace: ${boardRoot}\n\n`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Allow direct execution (`node dist/web/server.js`, `tsx src/web/server.ts`)
// without affecting the CLI's `web` command, which imports and calls
// `startWebServer` itself.
const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here)) {
  startWebServer().catch((err) => {
    process.stderr.write(`[nexplan] web server failed: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
