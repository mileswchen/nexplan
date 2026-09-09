import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Git } from './git.js';
import { Store } from './store.js';
import { NOW } from './frontmatter.js';
import { hashPassword, verifyPassword } from './auth.js';
import {
  Project,
  ProjectSummary,
  User,
  UserKind,
  UserRole,
} from './types.js';

export interface WorkspaceOptions {
  root: string;
  agentName?: string;
  autoCommit?: boolean;
}

export interface WorkspaceConfig {
  defaultProject: string;
  projects: string[]; // project keys, in creation order
  createdAt: string;
  enforcePermissions: boolean; // when true, writes require a non-viewer member
}

const DEFAULT_PROJECT_KEY = 'default';
const DEFAULT_USER_ROLES: UserRole[] = ['admin', 'member', 'viewer'];
const DEFAULT_ADMIN_ID = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

/**
 * A Workspace hosts multiple projects (each a per-project board backed by the
 * Store) and a registry of users (humans + agents) with roles.
 *
 * Layout under `root` (a single git repo):
 *   workspace.json       workspace metadata (default project, project list)
 *   users/<id>.json      user registry
 *   projects/<key>/      each project: project.json + workitems/bugs/docs
 */
export class Workspace {
  readonly root: string;
  agentName: string;
  private git: Git;
  private autoCommit: boolean;
  private stores = new Map<string, Store>();

  constructor(opts: WorkspaceOptions) {
    this.root = path.resolve(opts.root);
    this.agentName = opts.agentName ?? 'user';
    this.autoCommit = opts.autoCommit ?? true;
    this.git = new Git(this.root);
  }

  // ------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    const projectsDir = path.join(this.root, 'projects');
    const usersDir = path.join(this.root, 'users');
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.mkdir(usersDir, { recursive: true });
    await this.git.init({ atCwd: true });

    if (!(await this.exists(path.join(this.root, 'workspace.json')))) {
      const cfg: WorkspaceConfig = {
        defaultProject: DEFAULT_PROJECT_KEY,
        projects: [],
        createdAt: NOW(),
        enforcePermissions: false,
      };
      await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    }

    // Best-effort migration of a legacy single-board (data at the workspace
    // root, before projects existed) into projects/default.
    await this.migrateLegacy();

    await this.ensureDefaultProject();
    await this.ensureAdminExists();
    await this.commitMeta('workspace: init');
  }

  private async migrateLegacy(): Promise<void> {
    const projectsDir = path.join(this.root, 'projects');
    if (await this.exists(path.join(projectsDir, DEFAULT_PROJECT_KEY))) return;
    // Await each exists() — a Promise is truthy, so filter() with an async
    // predicate would never yield an empty list.
    const legacyDirs: string[] = [];
    for (const d of ['workitems', 'bugs', 'docs']) {
      if (await this.exists(path.join(this.root, d))) legacyDirs.push(d);
    }
    if (!legacyDirs.length) return;
    const dest = path.join(projectsDir, DEFAULT_PROJECT_KEY);
    await fs.mkdir(dest, { recursive: true });
    for (const d of legacyDirs) {
      const src = path.join(this.root, d);
      if (await this.exists(src)) await fs.rename(src, path.join(dest, d));
    }
    const legacyMeta = path.join(this.root, 'nexplan.json');
    if (await this.exists(legacyMeta)) await fs.rename(legacyMeta, path.join(dest, 'nexplan.json'));
    // Record the migrated project in its project.json and the workspace list.
    await this.writeJson(path.join(dest, 'project.json'), this.makeProject(DEFAULT_PROJECT_KEY, 'Default'));
    const cfg = await this.loadConfig();
    if (!cfg.projects.includes(DEFAULT_PROJECT_KEY)) cfg.projects.unshift(DEFAULT_PROJECT_KEY);
    cfg.defaultProject = DEFAULT_PROJECT_KEY;
    await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    await this.commitAll('workspace: migrate legacy board into projects/default');
  }

  private async ensureDefaultProject(): Promise<void> {
    const list = await this.listProjects();
    if (list.length) return;
    await this.createProject({ key: DEFAULT_PROJECT_KEY, name: 'Default' });
  }

  private makeProject(key: string, name: string, description = '', members: string[] = []): Project {
    const now = NOW();
    return { key, name, description, members, createdAt: now, updatedAt: now };
  }

  // ------------------------------------------------------------ git helpers

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
      return JSON.parse(await fs.readFile(p, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(p: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  /** Commit only the workspace metadata + user registry (not any project's data). */
  private async commitMeta(message: string): Promise<void> {
    if (!this.autoCommit) return;
    try {
      await this.git.run(['add', '-A', '--', 'workspace.json', 'users']);
      await this.git.commit(message);
    } catch (err) {
      console.warn(`[nexplan] workspace commit failed: ${(err as Error).message}`);
    }
  }

  /** Commit everything (used for one-time migrations). */
  private async commitAll(message: string): Promise<void> {
    if (!this.autoCommit) return;
    try {
      await this.git.addAll();
      await this.git.commit(message);
    } catch (err) {
      console.warn(`[nexplan] workspace commit failed: ${(err as Error).message}`);
    }
  }

  private async loadConfig(): Promise<WorkspaceConfig> {
    return (
      (await this.readJson<WorkspaceConfig>(path.join(this.root, 'workspace.json'))) ?? {
        defaultProject: DEFAULT_PROJECT_KEY,
        projects: [],
        createdAt: NOW(),
        enforcePermissions: false,
      }
    );
  }

  /** Public accessor for the workspace configuration. */
  async getConfig(): Promise<WorkspaceConfig> {
    return this.loadConfig();
  }

  private projectDir(key: string): string {
    return path.join(this.root, 'projects', key);
  }

  // ------------------------------------------------------------ projects

  async listProjects(): Promise<Project[]> {
    const cfg = await this.loadConfig();
    const out: Project[] = [];
    for (const key of cfg.projects) {
      const p = await this.getProject(key);
      if (p) out.push(p);
    }
    return out;
  }

  async getProject(key: string): Promise<Project | null> {
    const p = await this.readJson<Project>(path.join(this.projectDir(key), 'project.json'));
    return p ?? null;
  }

  async createProject(input: { key: string; name?: string; description?: string; members?: string[] }): Promise<Project> {
    const key = input.key.trim();
    if (!key || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key)) {
      throw new Error(`invalid project key: "${key}" (use [a-zA-Z0-9_-])`);
    }
    if (key === DEFAULT_PROJECT_KEY && (await this.rootHasBoard())) {
      throw new Error('project key "default" is reserved for the workspace root board');
    }
    if (await this.getProject(key)) throw new Error(`project already exists: ${key}`);
    const project = this.makeProject(
      key,
      input.name?.trim() || key,
      input.description?.trim() ?? '',
      input.members ?? [],
    );
    await this.writeJson(path.join(this.projectDir(key), 'project.json'), project);
    // Initialise the project's board (creates its git refs + subdirs).
    await this.getStore(key).init();
    // Register in the workspace config.
    const cfg = await this.loadConfig();
    if (!cfg.projects.includes(key)) cfg.projects.push(key);
    await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    await this.commitMeta(`project: create ${key}`);
    return project;
  }

  async updateProject(
    key: string,
    patch: { name?: string; description?: string; members?: string[] },
  ): Promise<Project> {
    const existing = await this.getProject(key);
    if (!existing) throw new Error(`project not found: ${key}`);
    const updated: Project = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      description: patch.description ?? existing.description,
      members: patch.members ?? existing.members,
      updatedAt: NOW(),
    };
    await this.writeJson(path.join(this.projectDir(key), 'project.json'), updated);
    await this.commitMeta(`project: update ${key}`);
    return updated;
  }

  async deleteProject(key: string): Promise<void> {
    if (key === DEFAULT_PROJECT_KEY) throw new Error('cannot delete the default project');
    const existing = await this.getProject(key);
    if (!existing) throw new Error(`project not found: ${key}`);
    this.stores.delete(key);
    await fs.rm(this.projectDir(key), { recursive: true, force: true });
    const cfg = await this.loadConfig();
    cfg.projects = cfg.projects.filter((k) => k !== key);
    if (cfg.defaultProject === key) cfg.defaultProject = cfg.projects[0] ?? DEFAULT_PROJECT_KEY;
    await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    await this.commitAll(`project: delete ${key}`);
  }

  async setDefaultProject(key: string): Promise<void> {
    if (!(await this.getProject(key))) throw new Error(`project not found: ${key}`);
    const cfg = await this.loadConfig();
    cfg.defaultProject = key;
    await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    await this.commitMeta(`workspace: default project → ${key}`);
  }

  async setEnforcePermissions(value: boolean): Promise<void> {
    if (value) await this.ensureAdminExists(); // never enable strict mode with no admin
    const cfg = await this.loadConfig();
    cfg.enforcePermissions = value;
    await this.writeJson(path.join(this.root, 'workspace.json'), cfg);
    await this.commitMeta(`workspace: enforcePermissions=${value}`);
  }

  async getDefaultProjectKey(): Promise<string> {
    const cfg = await this.loadConfig();
    if (cfg.defaultProject && (await this.getProject(cfg.defaultProject))) return cfg.defaultProject;
    return DEFAULT_PROJECT_KEY;
  }

  // ------------------------------------------------------------ stores

  /** Resolve a project for use; falls back to the workspace default. */
  async resolveProject(requested?: string): Promise<string> {
    if (requested) {
      if (!(await this.getProject(requested))) throw new Error(`project not found: ${requested}`);
      return requested;
    }
    return this.getDefaultProjectKey();
  }

  getStore(key: string): Store {
    let store = this.stores.get(key);
    if (!store) {
      store = new Store({
        root: this.projectDir(key),
        agentName: this.agentName,
        autoCommit: this.autoCommit,
      });
      this.stores.set(key, store);
    }
    return store;
  }

  async summary(projectKey?: string): Promise<ProjectSummary> {
    const key = await this.resolveProject(projectKey);
    const base = await this.getStore(key).boardSummary();
    return { ...base, projectKey: key };
  }

  // ------------------------------------------------------------ users

  async listUsers(): Promise<User[]> {
    const files = (await this.readDir(path.join(this.root, 'users'))).filter((f) => f.endsWith('.json'));
    const out: User[] = [];
    for (const f of files) {
      const u = await this.readJson<User>(path.join(this.root, 'users', f));
      if (u) out.push(u);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async getUser(id: string): Promise<User | null> {
    return (await this.readJson<User>(path.join(this.root, 'users', `${id}.json`))) ?? null;
  }

  async createUser(input: { id: string; name?: string; kind?: UserKind; role?: UserRole; password?: string }): Promise<User> {
    const id = input.id.trim();
    if (!id) throw new Error('user id required');
    if (await this.getUser(id)) throw new Error(`user already exists: ${id}`);
    const user: User = {
      id,
      name: input.name?.trim() || id,
      kind: input.kind ?? 'human',
      role: this.validRole(input.role) ?? 'member',
      createdAt: NOW(),
    };
    if (input.password) user.passwordHash = hashPassword(input.password);
    await this.writeUserFile(user);
    await this.commitMeta(`user: create ${id}`);
    return user;
  }

  /**
   * Guarantee the workspace always has at least one `admin` so that strict mode
   * (`enforcePermissions`) can never lock everyone out of management. Called on
   * init and whenever strict mode is enabled; only writes when it is actually
   * missing (and the default id is not already taken by a non-admin).
   */
  private async ensureAdminExists(): Promise<void> {
    const users = await this.listUsers();
    if (users.some((u) => u.role === 'admin')) return; // an admin already exists
    if (await this.getUser(DEFAULT_ADMIN_ID)) return; // id taken by a non-admin; leave it alone
    await this.writeUserFile({
      id: DEFAULT_ADMIN_ID,
      name: DEFAULT_ADMIN_ID,
      kind: 'human',
      role: 'admin',
      createdAt: NOW(),
      passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      mustChangePassword: true,
    });
  }

  private async writeUserFile(user: User): Promise<void> {
    await this.writeJson(path.join(this.root, 'users', `${user.id}.json`), user);
  }

  async updateUser(id: string, patch: { name?: string; kind?: UserKind; role?: UserRole; password?: string }): Promise<User> {
    const existing = await this.getUser(id);
    if (!existing) throw new Error(`user not found: ${id}`);
    const updated: User = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      kind: patch.kind ?? existing.kind,
      role: this.validRole(patch.role) ?? existing.role,
    };
    if (patch.password) {
      updated.passwordHash = hashPassword(patch.password);
      updated.mustChangePassword = false;
    }
    await this.writeUserFile(updated);
    await this.commitMeta(`user: update ${id}`);
    return updated;
  }

  /** Set (or reset) a user's password. Clears the must-change-on-login flag. */
  async setUserPassword(id: string, password: string): Promise<void> {
    const existing = await this.getUser(id);
    if (!existing) throw new Error(`user not found: ${id}`);
    if (!password) throw new Error('password required');
    await this.writeUserFile({ ...existing, passwordHash: hashPassword(password), mustChangePassword: false });
    await this.commitMeta(`user: set password ${id}`);
  }

  /** Verify a password for a user id. Unknown users and users without a hash fail. */
  async verifyUserPassword(id: string, password: string): Promise<boolean> {
    const user = await this.getUser(id);
    if (!user?.passwordHash) return false;
    return verifyPassword(password, user.passwordHash);
  }

  async deleteUser(id: string): Promise<void> {
    if (!(await this.getUser(id))) throw new Error(`user not found: ${id}`);
    await fs.rm(path.join(this.root, 'users', `${id}.json`), { force: true });
    await this.commitMeta(`user: delete ${id}`);
  }

  /** Resolve the effective role for an author. Unknown authors default to member. */
  async roleOf(author?: string): Promise<UserRole> {
    if (!author) return 'member';
    const user = await this.getUser(author);
    return user?.role ?? 'member';
  }

  /** Enforce write permission. A known `viewer` is read-only; everything else is allowed. */
  async assertCanWrite(author?: string): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg.enforcePermissions) return;
    const user = author ? await this.getUser(author) : null;
    if (!user && (author || this.agentName)) {
      throw new Error(`user not registered: ${author || this.agentName} (register with nexplan user add)`);
    }
    if (user?.role === 'viewer') throw new Error(`user ${user.id} is read-only (viewer)`);
  }

  /** Workspace management (projects, users, config) requires the `admin` role in
   * strict mode. When permissions are off, management is open to everyone. */
  async assertAdmin(author?: string): Promise<void> {
    const cfg = await this.loadConfig();
    if (!cfg.enforcePermissions) return;
    const role = await this.roleOf(author);
    if (role !== 'admin') {
      throw new Error(`admin role required to manage the workspace (current: ${role})`);
    }
  }

  /**
   * Project-level access control.
   *
   * - Roster gate (always active): a project that lists members restricts access
   *   to those members plus admins. Projects with an empty roster stay open.
   * - Strict gate (when `enforcePermissions`): the author must be a registered user
   *   who is an admin or a project member.
   * - Write gate (always active): `viewer` is read-only.
   */
  async assertProjectAccess(projectKey: string, author?: string, opts: { write?: boolean } = {}): Promise<void> {
    const cfg = await this.loadConfig();
    const role = await this.roleOf(author);
    const project = await this.getProject(projectKey);
    const members = project?.members ?? [];
    const isAdmin = role === 'admin';
    const isMember = author ? members.includes(author) : false;

    if (members.length > 0 && !isAdmin && !isMember) {
      throw new Error(`no access to project "${projectKey}": "${author || '?'}" is not a project member`);
    }
    if (cfg.enforcePermissions) {
      if (!author) {
        throw new Error('no author supplied for an enforced-permissions workspace');
      }
      const user = await this.getUser(author);
      if (!user) {
        throw new Error(`user not registered: ${author} (register with nexplan user add)`);
      }
      if (!isAdmin && !isMember) {
        throw new Error(`no access to project "${projectKey}": "${author}" is not a member`);
      }
    }
    if (opts.write && role === 'viewer') {
      throw new Error(`user ${author} is read-only (viewer)`);
    }
  }

  /** Per-project statistics for all projects (for admin dashboards). */
  async projectsStats(): Promise<Array<Project & { summary: ProjectSummary }>> {
    const projects = await this.listProjects();
    const out: Array<Project & { summary: ProjectSummary }> = [];
    for (const p of projects) {
      const summary = { ...(await this.getStore(p.key).boardSummary()), projectKey: p.key } as ProjectSummary;
      out.push({ ...p, summary });
    }
    return out;
  }

  private validRole(v?: string): UserRole | undefined {
    return v && DEFAULT_USER_ROLES.includes(v as UserRole) ? (v as UserRole) : undefined;
  }

  private async readDir(p: string): Promise<string[]> {
    try {
      return await fs.readdir(p);
    } catch {
      return [];
    }
  }

  private async rootHasBoard(): Promise<boolean> {
    for (const d of ['workitems', 'bugs', 'docs']) {
      if (await this.exists(path.join(this.root, d))) return true;
    }
    return false;
  }
}
