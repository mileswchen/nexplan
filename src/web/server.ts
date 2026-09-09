import express, { Request, Response, NextFunction } from 'express';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { Workspace } from '../core/workspace.js';
import { generateSecret } from '../core/auth.js';
import { BugFilter, ListFilter, User } from '../core/types.js';

export interface WebServerOptions {
  port?: number;
  host?: string; // bind host; set to '0.0.0.0' (or a LAN IP) to allow other machines in
  root?: string; // workspace root
}

/** Non-internal IPv4 addresses of this machine (for remote-access hints). */
function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
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

  // The web dashboard is authenticated per-request via a signed session cookie for
  // human users. Human users log in with a password; agent identity (MCP/CLI) is
  // unaffected. Anonymous requests may read open projects but cannot write/manage.
  const COOKIE = 'nexplan_session';
  const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

  const secretFile = path.join(boardRoot, '.web-secret');
  const secret = await (async () => {
    try {
      return (await fs.readFile(secretFile, 'utf8')).trim();
    } catch {
      const s = generateSecret();
      await fs.writeFile(secretFile, s, 'utf8');
      // Never let the signing secret pollute the board's own audit history.
      const ignoreFile = path.join(boardRoot, '.gitignore');
      try {
        await fs.writeFile(ignoreFile, '.web-secret\n', { flag: 'wx' });
      } catch {
        /* ignore file already exists */
      }
      return s;
    }
  })();

  const sign = (data: string) => createHmac('sha256', secret).update(data).digest('hex');
  const makeToken = (userId: string) => {
    const body = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL * 1000 })).toString('base64url');
    return `${body}.${sign(body)}`;
  };
  const parseToken = (token: string): string | null => {
    const [body, sig] = token.split('.');
    if (!body || !sig || sign(body) !== sig) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (!data.uid || data.exp < Date.now()) return null;
      return data.uid;
    } catch {
      return null;
    }
  };
  const readCookie = (req: Request): string | null => {
    const h = req.headers.cookie;
    if (!h) return null;
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const setSession = (res: Response, userId: string) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(userId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
  };
  const clearSession = (res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  };
  const publicUser = (u?: User | null) =>
    u ? { id: u.id, name: u.name, kind: u.kind, role: u.role, mustChangePassword: !!u.mustChangePassword } : null;
  const httpError = (status: number, message: string) => {
    const e = new Error(message) as Error & { status: number };
    e.status = status;
    return e;
  };

  // Resolve the logged-in human user (if any) for this request.
  const webUser = (req: Request): User | null => (req as Request & { webUser?: User | null }).webUser ?? null;
  const requireLogin = (req: Request): User => {
    const u = webUser(req);
    if (!u) throw httpError(401, 'please log in');
    return u;
  };
  const me = (req: Request): string => requireLogin(req).id;

  // Resolve the project store for a request. `?project=<key>` overrides
  // $NEXPLAN_PROJECT, which overrides the workspace default. Access is gated by
  // the project's member roster (and strict mode). Writes require a login.
  async function storeFor(req: Request, write = false): Promise<Store> {
    const user = webUser(req);
    if (write && !user) throw httpError(401, 'please log in');
    const key = await workspace.resolveProject((req.query.project as string) || process.env.NEXPLAN_PROJECT);
    await workspace.assertProjectAccess(key, user?.id, { write });
    return workspace.getStore(key);
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const pkgRoot = await findPackageRoot();
  const publicDir = path.join(pkgRoot, 'public');
  app.use(express.static(publicDir));

  // Resolve the logged-in human user for each request (web-only login).
  app.use(async (req, _res, next) => {
    try {
      const token = readCookie(req);
      const uid = token ? parseToken(token) : null;
      (req as Request & { webUser?: User | null }).webUser = uid ? await workspace.getUser(uid) : null;
      next();
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ auth (web login)
  app.get('/api/auth/me', async (req, res) => {
    res.json({ user: publicUser(webUser(req)) });
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const { id, password } = req.body || {};
      const user = await workspace.getUser(String(id || '').trim());
      if (!user || !(await workspace.verifyUserPassword(user.id, String(password || '')))) {
        return res.status(401).json({ error: 'invalid credentials' });
      }
      setSession(res, user.id);
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (req, res, next) => {
    try {
      const user = requireLogin(req);
      const { password } = req.body || {};
      if (!password || String(password).length < 4) {
        return res.status(400).json({ error: 'password must be at least 4 characters' });
      }
      await workspace.setUserPassword(user.id, String(password));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ workspace
  app.get('/api/workspace', async (_req, res, next) => {
    try {
      const cfg = await workspace.getConfig();
      const projects = await workspace.listProjects();
      const users = (await workspace.listUsers()).map((u) => publicUser(u));
      const current = await workspace.resolveProject();
      res.json({ ...cfg, currentProject: current, projects, users });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workspace/default-project', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
      await workspace.setDefaultProject(req.body.key);
      res.json({ ok: true, defaultProject: req.body.key });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workspace/enforce-permissions', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
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
      await workspace.assertAdmin(requireLogin(req).id);
      const { key, name, description, members } = req.body;
      res.status(201).json(await workspace.createProject({ key, name, description, members }));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/projects/:key', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
      const { name, description, members } = req.body;
      res.json(await workspace.updateProject(req.params.key, { name, description, members }));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/projects/:key', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
      await workspace.deleteProject(req.params.key);
      res.json({ ok: true, key: req.params.key });
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------ users
  app.get('/api/users', async (_req, res, next) => {
    try {
      res.json((await workspace.listUsers()).map((u) => publicUser(u)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/users', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
      const { id, name, kind, role, password } = req.body;
      res.status(201).json(publicUser(await workspace.createUser({ id, name, kind, role, password })));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/users/:id', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
      const { name, kind, role, password } = req.body;
      res.json(publicUser(await workspace.updateUser(req.params.id, { name, kind, role, password })));
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/users/:id', async (req, res, next) => {
    try {
      await workspace.assertAdmin(requireLogin(req).id);
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
      await workspace.assertProjectAccess(key, webUser(req)?.id);
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
      for (const it of items) created.push(await store.createWorkItem({ ...it, author: me(req) }));
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/workitems/:id', async (req, res, next) => {
    try {
      const { author: _author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateWorkItem(req.params.id, patch, me(req)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/claim', async (req, res, next) => {
    try {
      const { assignee, status } = req.body;
      res.json(await (await storeFor(req, true)).claimWorkItem(req.params.id, assignee || me(req), status ?? 'in_progress', me(req)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/complete', async (req, res, next) => {
    try {
      const { note, closeLinkedBugs } = req.body;
      res.json(await (await storeFor(req, true)).completeWorkItem(req.params.id, { note, closeLinkedBugs, author: me(req) }));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/note', async (req, res, next) => {
    try {
      const { body } = req.body;
      res.json(await (await storeFor(req, true)).addWorkItemNote(req.params.id, body, me(req)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/workitems/:id/decompose', async (req, res, next) => {
    try {
      const { children } = req.body;
      res.json(await (await storeFor(req, true)).decomposeWorkItem(req.params.id, children ?? [], me(req)));
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
      const b = await (await storeFor(req, true)).createBug({ ...req.body, author: me(req) });
      res.status(201).json(b);
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/bugs/:id', async (req, res, next) => {
    try {
      const { author: _author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateBug(req.params.id, patch, me(req)));
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
      const { author: _author, ...input } = req.body;
      res.status(201).json(await (await storeFor(req, true)).createDoc({ ...input, author: me(req) }));
    } catch (e) {
      next(e);
    }
  });

  app.patch('/api/docs/:slug', async (req, res, next) => {
    try {
      const { author: _author, ...patch } = req.body;
      res.json(await (await storeFor(req, true)).updateDoc(req.params.slug, patch, me(req)));
    } catch (e) {
      next(e);
    }
  });

  // fallthrough (SPA routing)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  const port = opts.port ?? Number(process.env.PORT ?? 3344);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const remote = !['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
  const server = app.listen(port, host, () => {
    process.stdout.write(`\n  NexPlan dashboard → http://127.0.0.1:${port}\n`);
    if (remote) {
      // Bound to all interfaces (or a LAN IP): print every address other
      // machines on the network can use to open the dashboard.
      for (const ip of lanIPv4Addresses()) {
        process.stdout.write(`  LAN access        → http://${ip}:${port}\n`);
      }
      process.stdout.write(`  (bound to ${host} — anyone on your network can reach the login page;\n`);
      process.stdout.write(`   change the default admin password: nexplan user password admin <pw>)\n`);
    }
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
