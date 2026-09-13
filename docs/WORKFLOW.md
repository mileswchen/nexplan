# Recommended agent workflow

NexPlan is designed around a simple, repeatable loop for a coding agent. Use the MCP
tools (or the equivalents via the CLI).

## 1. Orient

```
nexplan_status            # board summary + recent activity
nexplan_backlog_list      { "status": ["backlog","todo"], "priority": "P0" }
nexplan_agent_next        { "assignee": "<agent>" }   # suggests next work
nexplan_bug_list          { "status": ["open","in_progress"] }
```

## 2. Pick up work

**Claim** an item before starting — it records ownership and moves it to `in_progress`:

```
nexplan_backlog_claim     { "id": "WI-3", "assignee": "<agent>" }
```

If the task is too big, decompose it first, then claim the children:

```
nexplan_backlog_decompose { "parentId": "WI-3", "children": [ { "title": "..." }, ... ] }
```

## 3. Capture design/decision docs as you go

Record the *why* in a versioned document, not just the code:

```
nexplan_docs_create       { "title": "API 设计", "type": "design", "body": "..." }
nexplan_docs_update       { "slug": "api-design", "content": "...v2...", "status": "approved" }
nexplan_docs_history / diff  # see how it evolved
```

Every `docs_update` creates a new version (git commit + frontmatter `version` bump),
so you can always answer "what did the design look like before?".

## 4. Log bugs you discover

Anything you hit during development — a failing test, a crash, a lint error — goes
through NexPlan, not a side channel:

```
nexplan_bug_add           { "title": "...", "severity": "critical", "evidence": "<stack/log>" }
```

If a work item will fix a bug, link it with `fixesBug`:

```
nexplan_backlog_add       { "items": [ { "title": "修复空指针", "fixesBug": ["BUG-1"] } ] }
```

## 5. Record what you tested

When you finish a change, say **what you actually ran**. Record one execution per case —
the whole suite in a single call:

```
nexplan_test_run_record {
  "runs": [
    { "caseId": "TC-1", "result": "pass", "build": "v0.4.0", "env": "ci" },
    { "caseTitle": "Order: out-of-stock message", "result": "fail", "build": "v0.4.0",
      "actual": "returned 500", "evidence": "logs/order.log:42" }
  ],
  "batch": "v0.4.0 regression",
  "author": "claude-code"
}
```

What happens automatically:

- the failure **files a bug** (deduplicated: a second failure on the same case appends
  evidence instead of opening a duplicate) — pass `createBugOnFailure: false` to skip;
- a `pass` moves the bugs this case guards from `open`/`reopened` → `fixed`, and
  `fixed` → `verified` when you pass `verifyBugs: true`;
- a `fail` on a `fixed`/`verified` bug **reopens** it (regression caught);
- `nexplan_test_report` then gives you the pass rate, the cases that never ran and the
  flaky ones.

Describe the test intent once with `nexplan_test_case_add` (link it with `workItem`),
then reuse that case id for every later run.

## 6. Finish and update the board

```
nexplan_backlog_complete  { "id": "WI-3", "note": "完成并补测试" }
```

`backlog_complete` sets the item to `done`, records a completion note, and **auto-closes
any linked bugs** (→ `fixed`) unless you pass `closeLinkedBugs: false`. It also returns a
`verification` summary (how the linked test cases last executed). If the project turns on
`requirePassingOnComplete`, completing with failing or never-run cases is refused unless
you pass `force: true` (which is recorded in the item's notes).

## 7. Communicate

Use `nexplan_backlog_note` to leave progress comments that the humans (and other
agents) can read in the dashboard.

## Conventions

- **Statuses**: `backlog → todo → in_progress → review → done` (plus `blocked`).
- **Bug statuses**: `open → in_progress → fixed → verified` (plus `wontfix`, `reopened`).
- **Test results**: `pass | fail | blocked | skipped`, written once and never edited.
- **Author attribution**: every tool accepts `author`; set it to your agent name so the
  git history and dashboard show who did what.
- **Board location**: set `NEXPLAN_BOARD` identically in every agent config so they all
  share one board.
