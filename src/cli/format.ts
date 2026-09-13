import { WorkItem, Bug, Doc, TestCaseWithStatus, TestRun, TestReport } from '../core/types.js';

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
  if (w.docLink) parts.push(c.cyan('🔗'));
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
  out.push(`  doc link:    ${w.docLink ?? '-'}`);
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

// ---- test cases & runs -------------------------------------------------------

const resultColor = (r: string | null): string => {
  switch (r) {
    case 'pass':
      return c.green(r);
    case 'fail':
      return c.red(r);
    case 'blocked':
      return c.yellow(r);
    case 'skipped':
      return c.dim(r);
    default:
      return c.dim('not-run');
  }
};

export function formatTestCase(tc: TestCaseWithStatus): string {
  const parts = [
    c.bold(tc.id),
    prioColor(tc.priority),
    statusColor(tc.status),
    c.dim(`[${tc.type}]`),
    tc.title,
  ];
  parts.push(resultColor(tc.lastResult));
  if (tc.lastRunAt) parts.push(c.dim(date(tc.lastRunAt).slice(0, 16)));
  if (tc.workItem) parts.push(c.cyan(`→ ${tc.workItem}`));
  if (tc.automated) parts.push(c.dim('auto'));
  const tags = tc.tags?.length ? ` ${tc.tags.map((t) => c.dim(`#${t}`)).join(' ')}` : '';
  return parts.join('  ') + tags;
}

export function formatTestCaseFull(tc: TestCaseWithStatus): string {
  const out: string[] = [];
  out.push(c.bold(tc.title));
  out.push('');
  out.push(`  id:            ${tc.id}`);
  out.push(`  type:          ${tc.type}`);
  out.push(`  priority:      ${tc.priority}`);
  out.push(`  status:        ${tc.status}`);
  out.push(`  work item:     ${tc.workItem ?? '-'}`);
  out.push(`  guards bugs:   ${tc.bugs.join(', ') || '-'}`);
  out.push(`  automated:     ${tc.automated ? 'yes' : 'no'}${tc.testFile ? ` (${tc.testFile})` : ''}`);
  out.push(`  tags:          ${tc.tags.join(', ') || '-'}`);
  out.push(`  last result:   ${tc.lastResult ?? 'not-run'}${tc.lastRunAt ? `  ${date(tc.lastRunAt)}` : ''}${tc.lastBuild ? `  build ${tc.lastBuild}` : ''}`);
  out.push(`  created:       ${date(tc.createdAt)} by ${tc.createdBy}`);
  if (tc.description) out.push('', '  ' + tc.description);
  if (tc.preconditions) out.push('', `  preconditions: ${tc.preconditions}`);
  if (tc.steps?.length) {
    out.push('', '  steps:');
    tc.steps.forEach((s, i) => {
      out.push(`    ${i + 1}. ${s.action}`);
      out.push(`       expected: ${s.expected}`);
    });
  }
  if (tc.notes?.length) {
    out.push('', '  notes:');
    for (const n of tc.notes) out.push(`    ${date(n.at)} ${n.author}: ${n.body}`);
  }
  return out.join('\n');
}

export function formatTestRun(run: TestRun): string {
  const parts = [
    c.bold(run.id),
    c.bold(run.caseId),
    resultColor(run.result),
    run.caseTitle,
  ];
  if (run.build) parts.push(c.dim(`build ${run.build}`));
  if (run.environment) parts.push(c.dim(run.environment));
  if (run.batch) parts.push(c.dim(`batch ${run.batch}`));
  parts.push(c.magenta(run.executedBy));
  parts.push(c.dim(date(run.executedAt).slice(0, 16)));
  if (run.bugIds?.length) parts.push(c.red(run.bugIds.join(',')));
  return parts.join('  ');
}

export function formatTestReport(report: TestReport): string {
  const out: string[] = [];
  const scope = [
    `project ${report.scope.project}`,
    report.scope.batch && `batch "${report.scope.batch}"`,
    report.scope.build && `build ${report.scope.build}`,
    report.scope.workItem && `work item ${report.scope.workItem}`,
    (report.scope.from || report.scope.to) && `${report.scope.from ?? '…'} → ${report.scope.to ?? '…'}`,
  ]
    .filter(Boolean)
    .join(', ');
  out.push(c.bold('test report'), c.dim(scope), '');
  const t = report.totals;
  out.push(`  cases:     ${t.cases}   runs: ${t.runs}`);
  out.push(
    `  results:   ${c.green(`pass ${t.pass}`)}  ${c.red(`fail ${t.fail}`)}  ${c.yellow(`blocked ${t.blocked}`)}  ${c.dim(`skipped ${t.skipped}`)}  ${c.dim(`notRun ${t.notRun}`)}`,
  );
  out.push(`  pass rate: ${report.passRate === null ? '-' : `${report.passRate}%`}`);
  out.push(
    `  coverage:  ${report.coverage.itemsWithCases}/${report.coverage.itemsTotal} work items have cases`,
  );
  if (report.failures.length) {
    out.push('', c.red('  failing cases:'));
    for (const f of report.failures) out.push(`    ${f.caseId}  ${f.title}  (${f.runId}${f.build ? `, build ${f.build}` : ''})`);
  }
  if (report.notRunCases.length) {
    out.push('', '  not run:');
    for (const n of report.notRunCases) out.push(`    ${n.caseId}  ${n.title}`);
  }
  if (report.flaky.length) {
    out.push('', c.yellow('  flaky:'));
    for (const f of report.flaky) out.push(`    ${f.caseId}  ${f.title}  (pass ${f.pass} / fail ${f.fail})`);
  }
  if (report.coverage.itemsWithoutCasesTotal) {
    out.push(
      '',
      c.dim(
        `  ${report.coverage.itemsWithoutCasesTotal} work item(s) without test cases: ${report.coverage.itemsWithoutCases.join(', ')}${report.coverage.itemsWithoutCasesTotal > report.coverage.itemsWithoutCases.length ? ', …' : ''}`,
      ),
    );
  }
  return out.join('\n');
}

export function date(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 19).replace('T', ' ');
}
