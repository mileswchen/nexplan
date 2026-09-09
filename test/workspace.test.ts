import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/core/workspace.js';
import { Git } from '../src/core/git.js';

let dir: string;
let ws: Workspace;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-ws-'));
  ws = new Workspace({ root: dir, agentName: 'test-agent', autoCommit: true });
  await ws.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('init', () => {
  it('creates the workspace git repo, users dir, and a default project', async () => {
    const projects = await ws.listProjects();
    expect(projects.map((p) => p.key)).toContain('default');
    expect(await ws.getDefaultProjectKey()).toBe('default');
    const users = await ws.listUsers();
    expect(users.map((u) => u.id)).toEqual(['admin']);
    expect(users[0].role).toBe('admin');
    // default project has a working board
    const item = await ws.getStore('default').createWorkItem({ title: 'Init' });
    expect(item.id).toBe('WI-1');
  });
});

describe('projects', () => {
  it('creates and lists projects', async () => {
    const p = await ws.createProject({ key: 'api', name: 'API 重写', description: 'Backend' });
    expect(p.key).toBe('api');
    expect(p.name).toBe('API 重写');
    const projects = await ws.listProjects();
    expect(projects.map((x) => x.key).sort()).toEqual(['api', 'default']);
  });

  it('rejects duplicate or invalid project keys', async () => {
    await ws.createProject({ key: 'api' });
    await expect(ws.createProject({ key: 'api' })).rejects.toThrow(/exists/);
    await expect(ws.createProject({ key: 'bad key!' })).rejects.toThrow(/invalid/);
  });

  it('isolates per-project boards', async () => {
    await ws.createProject({ key: 'alpha' });
    await ws.createProject({ key: 'beta' });
    const a = ws.getStore('alpha');
    const b = ws.getStore('beta');
    const ia = await a.createWorkItem({ title: 'Alpha task' });
    const ib = await b.createWorkItem({ title: 'Beta task' });
    expect(ia.id).toBe('WI-1');
    expect(ib.id).toBe('WI-1'); // ids are per-project
    expect((await a.listWorkItems()).map((w) => w.title)).toEqual(['Alpha task']);
    expect((await b.listWorkItems()).map((w) => w.title)).toEqual(['Beta task']);
  });

  it('switches and resolves the default project', async () => {
    await ws.createProject({ key: 'focus' });
    await ws.setDefaultProject('focus');
    expect(await ws.getDefaultProjectKey()).toBe('focus');
    expect(await ws.resolveProject()).toBe('focus');
    expect(await ws.resolveProject('default')).toBe('default');
    await expect(ws.resolveProject('nope')).rejects.toThrow(/not found/);
  });

  it('deletes a project', async () => {
    await ws.createProject({ key: 'rmme' });
    await ws.deleteProject('rmme');
    const keys = (await ws.listProjects()).map((p) => p.key);
    expect(keys).not.toContain('rmme');
  });
});

describe('users', () => {
  it('registers users with roles and kudos attribution', async () => {
    const u = await ws.createUser({ id: 'claude-code', name: 'Claude Code', kind: 'agent', role: 'member' });
    expect(u.id).toBe('claude-code');
    expect(u.kind).toBe('agent');
    await ws.createUser({ id: 'xiaomo', role: 'admin' });
    expect(await ws.roleOf('claude-code')).toBe('member');
    expect(await ws.roleOf('xiaomo')).toBe('admin');
    expect(await ws.roleOf('unknown')).toBe('member');
    const users = await ws.listUsers();
    expect(users.map((x) => x.id)).toEqual(['admin', 'claude-code', 'xiaomo']);
  });

  it('updates and deletes users', async () => {
    await ws.createUser({ id: 'opencode' });
    const updated = await ws.updateUser('opencode', { role: 'viewer', name: 'OpenCode' });
    expect(updated.role).toBe('viewer');
    await ws.deleteUser('opencode');
    expect(await ws.getUser('opencode')).toBeNull();
  });

  it('enforces viewer read-only when permissions are enabled', async () => {
    await ws.createUser({ id: 'viewer1', role: 'viewer' });
    await ws.setEnforcePermissions(true);
    await expect(ws.assertCanWrite('viewer1')).rejects.toThrow(/read-only/);
    // unregistered author is rejected once enforcement is on
    await expect(ws.assertCanWrite('ghost')).rejects.toThrow(/not registered/);
  });

  it('restricts a project that has an explicit member roster', async () => {
    await ws.createUser({ id: 'alice' }); // member
    await ws.createUser({ id: 'boss', role: 'admin' });
    await ws.createProject({ key: 'restricted', members: ['alice'] });
    await expect(ws.assertProjectAccess('restricted', 'alice')).resolves.toBeUndefined();
    await expect(ws.assertProjectAccess('restricted', 'bob')).rejects.toThrow(/not a project member/);
    await expect(ws.assertProjectAccess('restricted', 'boss')).resolves.toBeUndefined(); // admin bypass
    // An empty-roster project stays open to everyone.
    await ws.createProject({ key: 'open' });
    await expect(ws.assertProjectAccess('open', 'anyone')).resolves.toBeUndefined();
  });

  it('requires admin role for management when permissions are enforced', async () => {
    await ws.createUser({ id: 'alice' });
    await ws.createUser({ id: 'boss', role: 'admin' });
    await ws.setEnforcePermissions(true);
    await expect(ws.assertAdmin('alice')).rejects.toThrow(/admin role/);
    await expect(ws.assertAdmin('boss')).resolves.toBeUndefined();
  });

  it('never locks out management: strict mode re-seeds an admin if none exists', async () => {
    // Simulate the old lockout state: no admin users at all.
    for (const a of (await ws.listUsers()).filter((u) => u.role === 'admin')) await ws.deleteUser(a.id);
    await ws.setEnforcePermissions(true);
    const admin = (await ws.listUsers()).find((u) => u.role === 'admin');
    expect(admin).toBeTruthy();
    expect(admin?.id).toBe('admin');
    await expect(ws.assertAdmin('admin')).resolves.toBeUndefined();
  });

  it('hashes and verifies passwords for humans; agents have none', async () => {
    const u = await ws.createUser({ id: 'xiaomo', kind: 'human', role: 'admin', password: 'secret' });
    expect(u.passwordHash).toBeTruthy();
    expect(u.passwordHash).not.toContain('secret');
    expect(await ws.verifyUserPassword('xiaomo', 'secret')).toBe(true);
    expect(await ws.verifyUserPassword('xiaomo', 'wrong')).toBe(false);
    expect(await ws.verifyUserPassword('ghost', 'secret')).toBe(false);
    // agent users have no password and cannot log in
    const agent = await ws.createUser({ id: 'codex', kind: 'agent' });
    expect(agent.passwordHash).toBeUndefined();
    expect(await ws.verifyUserPassword('codex', 'anything')).toBe(false);
    // setUserPassword resets it and clears mustChangePassword
    await ws.setUserPassword('xiaomo', 'newsecret');
    expect(await ws.verifyUserPassword('xiaomo', 'newsecret')).toBe(true);
    expect(await ws.verifyUserPassword('xiaomo', 'secret')).toBe(false);
    expect((await ws.getUser('xiaomo'))?.mustChangePassword ?? false).toBe(false);
  });

  it('leaves management open when permissions are off', async () => {
    await expect(ws.assertAdmin('nobody')).resolves.toBeUndefined();
  });

  it('lets a viewer read but not write a project', async () => {
    await ws.createUser({ id: 'viewer1', role: 'viewer' });
    await ws.createProject({ key: 'p1' });
    await expect(ws.assertProjectAccess('p1', 'viewer1')).resolves.toBeUndefined();
    await expect(ws.assertProjectAccess('p1', 'viewer1', { write: true })).rejects.toThrow(/read-only/);
  });

  it('reports per-project stats', async () => {
    await ws.createProject({ key: 'a' });
    await ws.createProject({ key: 'b' });
    await ws.getStore('a').createWorkItem({ title: 'x' });
    await ws.getStore('b').createBug({ title: 'bug' });
    const stats = await ws.projectsStats();
    const a = stats.find((s) => s.key === 'a');
    const b = stats.find((s) => s.key === 'b');
    expect(a?.summary.totalWorkItems).toBe(1);
    expect(b?.summary.totalBugs).toBe(1);
    expect(a?.summary.projectKey).toBe('a');
  });

  it('restricts deleting a work item to its creator or an admin', async () => {
    await ws.createUser({ id: 'alice' }); // member
    await ws.createUser({ id: 'boss', role: 'admin' });
    const store = ws.getStore('default');
    // A non-creator, non-admin member cannot delete.
    const item = await store.createWorkItem({ title: 'X', author: 'alice' });
    await expect(ws.deleteWorkItem('default', item.id, 'bob')).rejects.toThrow(/creator|admin/);
    // The creator can delete their own item.
    await expect(ws.deleteWorkItem('default', item.id, 'alice')).resolves.toBeDefined();
    expect(await store.getWorkItem(item.id)).toBeNull();
    // An admin can delete regardless of who created the item.
    const item2 = await store.createWorkItem({ title: 'Y', author: 'alice' });
    await expect(ws.deleteWorkItem('default', item2.id, 'boss')).resolves.toBeDefined();
    expect(await store.getWorkItem(item2.id)).toBeNull();
    // Deleting an unknown id throws.
    await expect(ws.deleteWorkItem('default', 'WI-404', 'boss')).rejects.toThrow(/not found/);
  });
});

describe('legacy migration', () => {
  it('moves a legacy single-board into projects/default', async () => {
    // Simulate an old board created at the workspace root before projects existed.
    const legacyDir = await mkdtemp(path.join(tmpdir(), 'nexplan-legacy-'));
    await mkdir(path.join(legacyDir, 'workitems'), { recursive: true });
    await writeFile(
      path.join(legacyDir, 'workitems', 'WI-1.json'),
      JSON.stringify({ id: 'WI-1', title: 'Legacy', status: 'backlog' }),
    );
    const ws2 = new Workspace({ root: legacyDir, autoCommit: true });
    await ws2.init();
    const projects = await ws2.listProjects();
    expect(projects.map((p) => p.key)).toEqual(['default']);
    const item = await ws2.getStore('default').getWorkItem('WI-1');
    expect(item?.title).toBe('Legacy');
    await rm(legacyDir, { recursive: true, force: true });
  });
});

describe('git repo ownership', () => {
  it('creates its own repo when the board lives inside a git repo that ignores it', async () => {
    const host = await mkdtemp(path.join(tmpdir(), 'nexplan-host-'));
    try {
      const hostGit = new Git(host);
      await hostGit.init({ atCwd: true });
      await hostGit.run(['config', 'user.name', 'Host']);
      await hostGit.run(['config', 'user.email', 'host@local']);
      await writeFile(path.join(host, '.gitignore'), 'board/\n');

      // Board directory sits inside the host repo at an ignored path.
      const board = path.join(host, 'board');
      const w = new Workspace({ root: board, agentName: 'test-agent', autoCommit: true });
      await w.init();

      // The board is its own repo (top-level == board), not the host repo.
      // (git reports the real path, so compare against realpath to tolerate
      // /var → /private/var symlinks on macOS.)
      const { stdout: top } = await new Git(board).run(['rev-parse', '--show-toplevel']);
      expect(top.trim()).toBe(realpathSync(board));

      // Writes commit cleanly inside the board repo…
      await w.getStore('default').createWorkItem({ title: 'inside-host' });
      const { stdout: log } = await new Git(board).run(['log', '--oneline']);
      expect(log.trim().length).toBeGreaterThan(0);

      // …and never leak into the host repo.
      const { stdout: status } = await hostGit.run(['status', '--porcelain']);
      expect(status).not.toMatch(/board/);
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });
});
