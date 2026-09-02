import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommitInfo {
  sha: string;
  author: string;
  date: string; // ISO
  message: string;
}

export class Git {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd: this.cwd });
      return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const msg = e?.stderr || e?.message || String(err);
      throw new Error(`git ${args.join(' ')} failed: ${msg}`);
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<boolean> {
    // Returns true if a new repo was created, false if one already exists.
    if (await this.isRepo()) return false;
    await this.run(['init', '-q']);
    // Ensure we have an author identity so commits never fail on a fresh machine.
    if (!(await this.hasConfig('user.name'))) await this.run(['config', 'user.name', 'NexPlan']);
    if (!(await this.hasConfig('user.email'))) await this.run(['config', 'user.email', 'nexplan@local']);
    return true;
  }

  private async hasConfig(key: string): Promise<boolean> {
    try {
      const { stdout } = await this.run(['config', '--get', key]);
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async add(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const safe = paths.filter((p) => typeof p === 'string' && p.trim().length > 0);
    if (!safe.length) return;
    await this.run(['add', '--', ...safe]);
  }

  /** Add all changes in the repo (for the audit commit after file writes). */
  async addAll(): Promise<void> {
    await this.run(['add', '-A']);
  }

  async commit(message: string): Promise<GitCommitInfo | null> {
    await this.run(['commit', '-q', '-m', message]);
    const sha = await this.latestSha();
    return { sha, author: await this.currentAuthor(), date: new Date().toISOString(), message };
  }

  async latestSha(): Promise<string> {
    try {
      const { stdout } = await this.run(['rev-parse', 'HEAD']);
      return stdout;
    } catch {
      return '';
    }
  }

  async currentAuthor(): Promise<string> {
    try {
      const { stdout } = await this.run(['config', 'user.name']);
      return stdout || 'NexPlan';
    } catch {
      return 'NexPlan';
    }
  }

  async isClean(): Promise<boolean> {
    const { stdout } = await this.run(['status', '--porcelain']);
    return stdout.length === 0;
  }

  /** Commit history for a path (for doc version history). */
  async logForPath(path: string, limit = 50): Promise<GitCommitInfo[]> {
    try {
      const { stdout } = await this.run([
        'log',
        `--format=%H%x1f%an%x1f%aI%x1f%s`,
        `-n`,
        String(limit),
        '--',
        path,
      ]);
      const rows = stdout.split('\n').filter(Boolean);
      return rows.map((row) => {
        const [sha, author, date, ...rest] = row.split('\x1f');
        return { sha, author, date: new Date(date).toISOString(), message: rest.join('\x1f') };
      });
    } catch {
      return [];
    }
  }

  /** Recent commits across the whole repo (for the board activity feed). */
  async logAll(limit = 20): Promise<GitCommitInfo[]> {
    try {
      const { stdout } = await this.run([
        'log',
        `--format=%H%x1f%an%x1f%aI%x1f%s`,
        `-n`,
        String(limit),
      ]);
      const rows = stdout.split('\n').filter(Boolean);
      return rows.map((row) => {
        const [sha, author, date, ...rest] = row.split('\x1f');
        return { sha, author, date: new Date(date).toISOString(), message: rest.join('\x1f') };
      });
    } catch {
      return [];
    }
  }

  /** Full content of a path at a commit (or working tree if sha omitted). */
  async showFile(path: string, sha?: string): Promise<string | null> {
    try {
      const args = sha ? ['show', `${sha}:${path}`] : ['show', `HEAD:${path}`];
      const { stdout } = await this.run(args);
      return stdout;
    } catch {
      return null;
    }
  }

  /** Diff of one path between two commits (or a commit and the working tree). */
  async diffFile(path: string, shaA?: string, shaB?: string): Promise<string> {
    try {
      let from: string;
      let to: string;
      if (shaA && shaB) {
        from = shaA;
        to = shaB;
      } else if (shaA) {
        from = shaA;
        to = 'HEAD';
      } else {
        from = 'HEAD';
        to = '';
      }
      const args = ['diff', from, to ? to : '', '--', path].filter((s) => s !== '');
      const { stdout } = await this.run(args);
      return stdout;
    } catch {
      return '';
    }
  }
}
