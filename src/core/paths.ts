import path from 'node:path';

/** Resolve the NexPlan board root (the git-backed data directory). */
export function getBoardRoot(): string {
  return process.env.NEXPLAN_BOARD || path.join(process.cwd(), '.nexplan');
}
