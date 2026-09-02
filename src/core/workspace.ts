import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Git } from './git.js';
import { Store } from './store.js';
import { NOW } from './frontmatter.js';
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
    await this.git.init();

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

  async createUser(input: { id: string; name?: string; kind?: UserKind; role?: UserRole }): Promise<User> {
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
    await this.writeJson(path.join(this.root, 'users', `${id}.json`), user);
    await this.commitMeta(`user: create ${id}`);
    return user;
  }

  async updateUser(id: string, patch: { name?: string; kind?: UserKind; role?: UserRole }): Promise<User> {
    const existing = await this.getUser(id);
    if (!existing) throw new Error(`user not found: ${id}`);
    const updated: User = {
      ...existing,
      name: patch.name?.trim() ?? existing.name,
      kind: patch.kind ?? existing.kind,
      role: this.validRole(patch.role) ?? existing.role,
    };
    await this.writeJson(path.join(this.root, 'users', `${id}.json`), updated);
    await this.commitMeta(`user: update ${id}`);
    return updated;
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
