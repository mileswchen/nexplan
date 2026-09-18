import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const cliEntry = path.join(repoRoot, 'src', 'cli', 'index.ts');

let dir: string;

/** The CLI colours its output unconditionally; strip ANSI so assertions stay readable. */
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Run the real CLI (from source, via tsx) against a scratch workspace. */
function cli(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NEXPLAN_BOARD: dir, NEXPLAN_AGENT: 'cli-test' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: strip(stdout), stderr: strip(stderr) });
      else reject(new Error(`cli exited ${code}\nstdout: ${strip(stdout)}\nstderr: ${strip(stderr)}`));
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-cli-'));
});
afterEach(async () => {
  // Retries cover the ENOTEMPTY race when a git child process is still
  // finishing a write inside .git/ while the temp dir is being removed.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('cli: batch run reporting', () => {
  it('records a whole suite from stdin in one commit, filing bugs for failures', async () => {
    await cli(['test', 'add', 'Login locks', '--status', 'active']);
    const batch = JSON.stringify([
      { caseId: 'TC-1', result: 'pass', build: 'v1' },
      { caseTitle: 'Ad-hoc checkout', result: 'fail', actual: 'returned 500', build: 'v1' },
      { caseTitle: 'Never seen before', result: 'blocked', build: 'v1' },
    ]);
    const { stdout } = await cli(['test', 'run', '--json-input', '--batch', 'ci-batch', '--env', 'ci'], batch);
    expect(stdout).toMatch(/recorded 3 run\(s\): pass 1, fail 1, blocked 1/);
    expect(stdout).toMatch(/filed BUG-1/);

    // One commit for the whole batch, and it names the id range plus the counts.
    const { stdout: log } = await cli(['--json', 'test', 'history', '--limit', '10']);
    const runs = JSON.parse(log) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.batch === 'ci-batch' && r.environment === 'ci')).toBe(true);
    expect(runs.map((r) => r.result).sort()).toEqual(['blocked', 'fail', 'pass']);

    const { stdout: casesRaw } = await cli(['--json', 'test', 'list']);
    const cases = JSON.parse(casesRaw) as Array<Record<string, unknown>>;
    // Two cases were auto-created from caseTitle, one reused by id.
    expect(cases.map((c) => c.id).sort()).toEqual(['TC-1', 'TC-2', 'TC-3']);
    const byId = new Map(cases.map((c) => [c.id, c]));
    expect(byId.get('TC-2')?.lastResult).toBe('fail');
    expect(byId.get('TC-3')?.lastResult).toBe('blocked');

    const { stdout: bugsRaw } = await cli(['--json', 'bug', 'list']);
    const bugs = JSON.parse(bugsRaw) as Array<Record<string, unknown>>;
    expect(bugs).toHaveLength(1);
    expect(bugs[0].testCase).toBe('TC-2');

    const { stdout: commits } = await cli(['--json', 'test', 'report', '--batch', 'ci-batch']);
    const report = JSON.parse(commits) as { totals: Record<string, number> };
    expect(report.totals).toMatchObject({ runs: 3, pass: 1, fail: 1, blocked: 1 });
  }, 90_000);

  it('keeps the single-run form working and rejects a missing --result', async () => {
    await cli(['test', 'add', 'Single', '--status', 'active']);
    const ok = await cli(['test', 'run', 'TC-1', '--result', 'pass', '--no-bug']);
    expect(ok.stdout).toMatch(/TR-1/);
    await expect(cli(['test', 'run', 'TC-1'])).rejects.toThrow(/--result must be one of/);
  }, 90_000);
});

describe('cli: work item hierarchy', () => {
  it('shows the decomposition tree, breadcrumbs and moves over the CLI', async () => {
    await cli(['add', 'Ship v4', '--type', 'feature']);
    await cli(['decompose', 'WI-1', '--child', 'API', '--child', 'Docs']);
    await cli(['add', 'Schema', '--parent', 'WI-2']);
    await cli(['update', 'WI-3', '--status', 'done']);

    // `list --tree` renders the attachment with connectors and progress.
    const { stdout: tree } = await cli(['list', '--tree']);
    expect(tree).toMatch(/WI-1.*Ship v4.*↳ 1\/2 done/);
    expect(tree).toMatch(/├─ WI-2.*API.*↳ 0\/1 done/);
    expect(tree).toMatch(/│  └─ WI-4.*Schema/);
    expect(tree).toMatch(/└─ WI-3.*Docs/);

    // `tree <id>` prints one subtree, plus where it hangs.
    const { stdout: sub } = await cli(['tree', 'WI-4']);
    expect(sub).toMatch(/in: WI-1 › WI-2 › WI-4\s+\(level 3\/3\)/);
    expect(sub).toMatch(/WI-4.*Schema/);

    // `get` shows the parent chain and the subtask block.
    const { stdout: full } = await cli(['get', 'WI-2']);
    expect(full).toMatch(/in: WI-1 › WI-2/);
    expect(full).toMatch(/subtasks:\nWI-4\s+P2\s+backlog\s+\[task\]\s+Schema/);

    // Filters: subtasks of one item, and one absolute depth.
    const { stdout: kids } = await cli(['list', '--parent', 'WI-2']);
    expect(kids).toMatch(/WI-4/);
    expect(kids).not.toMatch(/WI-1/);
    const { stdout: lvl3 } = await cli(['list', '--depth', '3']);
    expect(lvl3.trim().split('\n')).toHaveLength(1);

    // The cap is enforced: WI-4 is a level-3 item.
    await expect(cli(['decompose', 'WI-4', '--child', 'Nope'])).rejects.toThrow(/level 3/);

    // move re-attaches, and refuses cycles.
    const { stdout: moved } = await cli(['move', 'WI-3', '--parent', 'WI-2']);
    expect(moved).toMatch(/moved WI-3 → WI-2/);
    await expect(cli(['move', 'WI-2', '--parent', 'WI-3'])).rejects.toThrow(/cycle/);
    const { stdout: promoted } = await cli(['move', 'WI-3']);
    expect(promoted).toMatch(/moved WI-3 → top level/);

    // JSON output exposes the node metadata agents consume.
    const { stdout: json } = await cli(['--json', 'tree', 'WI-1']);
    const node = JSON.parse(json) as Record<string, unknown>;
    expect(node.depth).toBe(1);
    // WI-3 was promoted to the top level above, so WI-1 keeps WI-2 → WI-4.
    expect(node.subtree).toEqual({ total: 2, done: 0, open: 2 });
    expect((node.childNodes as unknown[]).length).toBe(1);
    const { stdout: roots } = await cli(['--json', 'tree']);
    const forest = JSON.parse(roots) as Array<Record<string, unknown>>;
    expect(forest.map((n) => n.id).sort()).toEqual(['WI-1', 'WI-3']);
  });
});

describe('cli: project key and name editing', () => {
  it('renames a project key and edits its display name', async () => {
    await cli(['project', 'new', 'old', '--name', 'Old name']);
    await cli(['add', 'Keep me', '--project', 'old']);

    const { stdout: renamed } = await cli(['project', 'rename', 'old', 'new']);
    expect(renamed).toMatch(/renamed project old → new/);

    // The data moved with the key.
    const { stdout: items } = await cli(['--project', 'new', '--json', 'list']);
    expect((JSON.parse(items) as Array<{ title: string }>).map((i) => i.title)).toEqual(['Keep me']);
    const { stdout: keys } = await cli(['--json', 'project', 'list']);
    expect((JSON.parse(keys) as Array<{ key: string }>).map((p) => p.key)).toEqual(['default', 'new']);

    // `project update --key` renames and edits the display fields in one call.
    const { stdout: updated } = await cli(['project', 'update', 'new', '--name', 'Backend', '--key', 'backend']);
    expect(updated).toMatch(/updated project backend — Backend \(renamed from new\)/);
    const { stdout: shown } = await cli(['project', 'show', 'backend']);
    expect(shown).toMatch(/backend — Backend/);

    // The old key is gone; the new one resolves.
    await expect(cli(['project', 'show', 'new'])).rejects.toThrow(/not found/);
    await expect(cli(['project', 'rename', 'backend', 'bad key'])).rejects.toThrow(/invalid project key/);
  });
});
