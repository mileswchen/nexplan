import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';

/**
 * Performance guards, expressed as *file-read counts* rather than timings.
 *
 * The design leans on two properties that are invisible in behavioural tests and
 * easy to destroy in a refactor: "newest N" reads only N run files (ids are
 * monotonic, so the hot directory is scanned newest-id-first and the loop stops
 * early), and the per-case latest-result lookup stops once every case is
 * resolved. Without a guard, a change that turns either into a full scan stays
 * green while costing ~1s per call at 20k runs (measured).
 */

let dir: string;
let store: Store;
let readFileCalls = 0;
const originalReadFile = fsp.readFile;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nexplan-perf-'));
  // autoCommit off: same code paths, far fewer git invocations while seeding.
  store = new Store({ root: dir, agentName: 'perf', autoCommit: false });
  await store.init();
  readFileCalls = 0;
  // `store.ts` imports `{ promises } from 'node:fs'`, which is the same object as
  // this one, so wrapping the property intercepts its reads too.
  (fsp as unknown as { readFile: unknown }).readFile = (...args: unknown[]) => {
    readFileCalls++;
    return (originalReadFile as (...a: unknown[]) => unknown)(...args);
  };
});

afterEach(async () => {
  (fsp as unknown as { readFile: unknown }).readFile = originalReadFile;
  await rm(dir, { recursive: true, force: true });
});

describe('hot-path read guards', () => {
  it('reads only the requested number of run files for "newest N"', async () => {
    const tc = await store.createTestCase({ title: 'Perf', status: 'active' });
    for (let i = 0; i < 20; i++) await store.recordTestRun({ caseId: tc.id, result: 'pass' });

    readFileCalls = 0;
    const newest = await store.listTestRuns({ limit: 3, includeArchived: false });
    expect(newest).toHaveLength(3);
    // Three files, not twenty: the loop stops as soon as the limit is met.
    expect(readFileCalls).toBeLessThanOrEqual(5);

    readFileCalls = 0;
    await store.listTestRuns({ includeArchived: false });
    // A deliberately unfiltered query still scans everything — that is the contract.
    expect(readFileCalls).toBeGreaterThanOrEqual(20);
  });

  it('stops the latest-result scan once every case is resolved', async () => {
    const cases = [];
    for (let i = 0; i < 3; i++) cases.push(await store.createTestCase({ title: `Case ${i}`, status: 'active' }));
    // 15 runs, cycling cases: the newest 3 files already cover all of them.
    for (let i = 0; i < 15; i++) {
      await store.recordTestRun({ caseId: cases[i % 3].id, result: i % 5 === 0 ? 'fail' : 'pass' });
    }

    readFileCalls = 0;
    const decorated = await store.listTestCases();
    expect(decorated).toHaveLength(3);
    expect(decorated.every((c) => c.lastResult !== null)).toBe(true);
    // 3 case files are read, plus a handful of run files — not all 15.
    expect(readFileCalls).toBeLessThanOrEqual(10);
  });

  it('does not scan the hot directory when the archive gate is closed', async () => {
    const tc = await store.createTestCase({ title: 'Gate', status: 'active' });
    await store.recordTestRun({ caseId: tc.id, result: 'pass' });

    readFileCalls = 0;
    const result = await store.archiveIfNeeded();
    expect(result).toBeNull();
    // Counters are read, but nothing under testruns/ is opened or listed.
    expect(readFileCalls).toBeLessThanOrEqual(2);
  });
});
