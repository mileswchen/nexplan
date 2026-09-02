import { WorkItem, Bug, Doc } from '../core/types.js';

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const statusColor = (s: string): string => {
  switch (s) {
    case 'backlog':
    case 'todo':
      return c.dim(s);
    case 'in_progress':
      return c.yellow(s);
    case 'review':
      return c.cyan(s);
    case 'done':
    case 'fixed':
    case 'verified':
      return c.green(s);
    case 'blocked':
    case 'critical':
      return c.red(s);
    case 'open':
    case 'wontfix':
      return c.red(s);
    default:
      return s;
  }
};

const prioColor = (p: string): string => {
  if (p === 'P0') return c.red(p);
  if (p === 'P1') return c.yellow(p);
  if (p === 'P2') return c.cyan(p);
  return c.dim(p);
};

export function formatWorkItem(w: WorkItem): string {
  const parts: string[] = [];
  parts.push(c.bold(w.id));
  parts.push(prioColor(w.priority));
  parts.push(statusColor(w.status));
  parts.push(c.dim(`[${w.type}]`));
  parts.push(w.title);
  if (w.assignee) parts.push(c.magenta(`@${w.assignee}`));
  const tags = w.tags?.length ? ` ${w.tags.map((t) => c.dim(`#${t}`)).join(' ')}` : '';
  return parts.join('  ') + tags;
}

export function formatWorkItemFull(w: WorkItem): string {
  const out: string[] = [];
  out.push(c.bold(w.title));
  out.push('');
  out.push(`  id:          ${w.id}`);
  out.push(`  type:        ${w.type}`);
  out.push(`  priority:    ${w.priority}`);
  out.push(`  status:      ${w.status}`);
  out.push(`  assignee:    ${w.assignee ?? '-'}`);
  out.push(`  source:      ${w.source}`);
  out.push(`  parent:      ${w.parent ?? '-'}`);
  out.push(`  children:    ${w.children.join(', ') || '-'}`);
  out.push(`  fixes bug:   ${w.fixesBug.join(', ') || '-'}`);
  out.push(`  estimate:    ${w.estimate ?? '-'}`);
  out.push(`  tags:        ${w.tags.join(', ') || '-'}`);
  out.push(`  created:     ${date(w.createdAt)} by ${w.createdBy}`);
  out.push(`  updated:     ${date(w.updatedAt)}`);
  if (w.completedAt) out.push(`  completed:   ${date(w.completedAt)}`);
  if (w.description) out.push('', '  ' + w.description);
  if (w.notes?.length) {
    out.push('', '  notes:');
    for (const n of w.notes) out.push(`    ${date(n.at)} ${n.author}: ${n.body}`);
  }
  return out.join('\n');
}

export function formatBug(b: Bug): string {
  const parts = [c.bold(b.id), statusColor(b.severity), statusColor(b.status), b.title];
  if (b.foundByAgent) parts.push(c.magenta(`by ${b.foundByAgent}`));
  return parts.join('  ');
}

export function formatBugFull(b: Bug): string {
  const out: string[] = [];
  out.push(c.bold(b.title));
  out.push('');
  out.push(`  id:          ${b.id}`);
  out.push(`  severity:    ${b.severity}`);
  out.push(`  status:      ${b.status}`);
  out.push(`  found by:    ${b.foundBy}${b.foundByAgent ? ` (${b.foundByAgent})` : ''}`);
  out.push(`  assignee:    ${b.assignee ?? '-'}`);
  out.push(`  work item:   ${b.workItem ?? '-'}`);
  out.push(`  tags:        ${b.tags.join(', ') || '-'}`);
  out.push(`  created:     ${date(b.createdAt)} by ${b.createdBy}`);
  out.push(`  updated:     ${date(b.updatedAt)}`);
  if (b.evidence) out.push('', '  evidence:', '    ' + b.evidence);
  if (b.description) out.push('', '  ' + b.description);
  if (b.notes?.length) {
    out.push('', '  notes:');
    for (const n of b.notes) out.push(`    ${date(n.at)} ${n.author}: ${n.body}`);
  }
  return out.join('\n');
}

export function formatDoc(d: Doc): string {
  return `${c.bold(d.slug)}  ${c.dim(`v${d.meta.version}`)}  ${d.meta.status}  ${c.dim(`[${d.meta.type}]`)}  ${d.meta.title}`;
}

export function date(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 19).replace('T', ' ');
}
