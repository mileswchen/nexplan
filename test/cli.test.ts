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
  await rm(dir, { recursive: true, force: true });
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
