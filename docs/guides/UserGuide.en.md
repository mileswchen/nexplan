# NexPlan — User Guide (English)

NexPlan is a **git-backed project management hub** for coding agents and humans. It gives
every tool in your workflow — **dsh, Claude Code, Codex, OpenCode** and other
MCP-capable agents — one shared **backlog**, one **bug tracker**, and one **versioned
documentation** store.

Because everything is plain files in a git repository, you get an automatic audit
trail, diffs, conflict-safe parallel work, and real version history for free.

---

## 1. What NexPlan gives you

| Area | What you can do |
|---|---|
| **Backlog / work items** | Record tasks manually or let an agent enter decomposed subtasks; claim an item; mark it done (status updates automatically). |
| **Bugs** | Record a bug manually, or let an agent log a bug it discovered (with evidence). Completing the linked work item auto-closes the bug. |
| **Documents** | Store design/decision/ADR documents with **version management**. Agents can create and update them; every update is a new git version. |
| **Tests** | Keep **reusable test cases** (`TC-N`) and **immutable execution records** (`TR-N`). A failing run files a bug for you; a passing run advances the bugs the case guards — closing the loop work item → test case → execution → bug → verification. |

It is exposed through **three interfaces** that all share the same store:

1. **CLI** — `nexplan …` (humans, scripts).
2. **MCP server** — `node dist/mcp/server.js` (agents; 36 `nexplan_*` tools).
3. **Web dashboard** — `nexplan web` (humans; kanban board, bug tracker, doc viewer/history,
   projects/users admin panel). Humans authenticate with a password; anonymous visitors can
   only **read** open projects.

---

## 2. Requirements & install

- **Node.js ≥ 20** (tested on Node 24)
- **git** (for the audit/versioning layer)
- **npm**

```bash
cd nexplan
npm install
npm run build          # compiles TypeScript → dist/

# Make the `nexplan` command available on PATH (global):
npm install -g .       # or: npm link .

# Or run without installing:
node dist/cli/index.js status
```

---

## 3. The board: where your data lives

The **workspace** is a directory (a git repo) that holds one or more **projects**.
By default it is `./.nexplan` in the current working directory; set `NEXPLAN_BOARD` to
relocate it. Each project has its own backlog, bugs and docs.

```
<workspace>/
  workspace.json        default project, project list, permission flags
  users/<id>.json       user registry
  projects/<key>/
    project.json        project meta (name, description, members)
    .counters.json      id counters (ids are never reused after a delete)
    workitems/          WI-*.json       backlog tasks
    bugs/               BUG-*.json      bugs
    docs/               <slug>.md       documents (markdown + frontmatter)
    testcases/          TC-*.json       test cases (reusable test intent)
    testruns/           TR-*.json       execution records (one file per run)
    testruns/archive/   <YYYY-MM>.jsonl archived (cold) runs, one JSON per line
```

Execution records are **one file per run** (`testruns/TR-N.json`); older runs are moved
automatically into monthly bundles under `testruns/archive/`.

Every mutation runs `git add` + `git commit` (scoped to the project subtree), so
`git log` is your full activity feed, and documents get real version history.

### Statuses, types and priorities

- **Work item type**: `task`, `feature`, `refactor`, `chore`, `research`, `bug`, `docs`
- **Work item status**: `backlog` → `todo` → `in_progress` → `review` → `done` (plus `blocked`)
- **Priority**: `P0` … `P3` (P0 highest)
- **Bug severity**: `critical`, `major`, `minor`, `trivial`
- **Bug status**: `open` → `in_progress` → `fixed` → `verified` (plus `wontfix`, `reopened`)
- **Doc type**: `design`, `decision`, `adr`, `architecture`, `notes`
- **Doc status**: `draft`, `review`, `approved`, `superseded`

---

## 4. Quick start

```bash
cd /path/to/your/project
export NEXPLAN_BOARD="$PWD/.nexplan"

# Manual backlog entry
nexplan add "重构认证模块" --type refactor --priority P1 --tags auth,security --manual

# Read the board
nexplan list --status backlog
nexplan status

# Pick up an item
nexplan claim WI-1 --assignee claude-code

# Mark done (status → done)
nexplan done WI-1 --note "已实现并补测试"

# Open the web dashboard
nexplan web
```

---

## 5. CLI reference

Use `--json` anywhere for machine-readable JSON output. `--root <path>` overrides the
board directory for a single command.

### Work items (backlog)

| Command | Description |
|---|---|
| `nexplan add "<title>" [options]` | Add one work item. `--type`, `--priority`, `--description`, `--assignee`, `--tags a,b`, `--estimate n`, `--fixes-bug BUG-1,BUG-2`, `--doc-link url`, `--manual`, `--json-input` (read items from stdin as JSON). |
| `nexplan list` / `ls` | List work items. `--status`, `--type`, `--priority`, `--assignee`, `--tags`, `--query`, `--limit`. |
| `nexplan get <id>` | Full detail of one item (incl. notes, children, links). |
| `nexplan claim <id> --assignee <name>` | Take ownership: sets `assignee` and status to `in_progress`. Optional `--status`. |
| `nexplan update <id> [options]` | Edit fields: `--title`, `--description`, `--type`, `--priority`, `--status`, `--assignee`, `--tags`, `--estimate`, `--doc-link url` (leave empty to clear). |
| `nexplan done <id> [options]` (`complete`) | Mark done; `--note`, `--no-close-bugs`. Auto-closes bugs listed in `fixesBug`. |
| `nexplan decompose <parentId> --child "<title>" …` | Split a parent into child backlog items (linked to the parent). |
| `nexplan note <id> <body>` | Append a progress/context note. |
| `nexplan rm <id>` (`delete`) | Delete a work item. Only its creator or an admin can delete it. |

#### Examples

```bash
nexplan add "实现下单接口" --type feature --priority P0
nexplan decompose WI-2 --child "订单表结构" --child "下单 API"
nexplan claim WI-3 --assignee opencode
nexplan done WI-3 --note "完成并验证"
```

### Bugs

| Command | Description |
|---|---|
| `nexplan bug add "<title>" [options]` | Record a bug: `--description`, `--severity`, `--evidence` (stack/log), `--tags`, `--manual`. |
| `nexplan bug list` | List bugs: `--status`, `--severity`, `--assignee`, `--query`, `--limit`. |
| `nexplan bug get <id>` | Full bug detail. |
| `nexplan bug update <id> [options]` | `--status`, `--severity`, `--assignee`, `--work-item`. |

```bash
nexplan bug add "登录接口偶发 500" --severity major --evidence "500: internal error"
nexplan bug update BUG-1 --status in_progress --assignee codex
```

### Test cases & execution records

A **test case** (`TC-N`) is a reusable test intent: preconditions, steps with expected
results, type, priority, the work item it verifies, the bugs it guards, and an optional
automation locator. A **test run** (`TR-N`) is an immutable record of one execution:
result, actual result, evidence, environment, build, batch, duration, executor, timestamp.

```bash
nexplan test list [--status s] [--type t] [--priority p] [--work-item WI-1] [--bug BUG-1] [--tag t] [--automated] [--last-result pass|fail|blocked|skipped|notRun] [--query q] [--limit n] [--json]
nexplan test add "<title>" [--type functional] [--priority P1] [--status draft|active|deprecated] [--precondition "..."] [--step "action|expected"]... [--work-item WI-1] [--bug BUG-2]... [--tag a,b] [--automated] [--test-file "test/x.test.ts::name"] [--json-input]
nexplan test get <TC-1> [--history n]
nexplan test update <TC-1> [--title] [--description] [--type] [--priority] [--status] [--precondition] [--work-item] [--bug] [--tag] [--automated] [--test-file]
nexplan test rm <TC-1> [--force]
nexplan test run <TC-1> --result pass|fail|blocked|skipped [--actual "..."] [--evidence "..."] [--env local] [--build v0.4.0] [--batch "v0.4.0 regression"] [--duration 1200] [--no-bug] [--verify] [--executed-at <iso>]
nexplan test run --title "<new case title>" --result fail      # auto-creates the case
nexplan test history [<TC-1>] [--result fail] [--build v] [--batch b] [--from <iso>] [--to <iso>] [--hot-only] [--limit n]
nexplan test report [--batch b] [--build v] [--work-item WI-1] [--from] [--to] [--hot-only]
nexplan test archive [--dry-run] [--before <iso>] [--keep n]      # force archiving now
nexplan test archive <YYYY-MM> --restore                          # move a bundle back to the hot directory
nexplan test archive --reindex                                    # rebuild archive/index.json
nexplan test archive-status                                       # hot/archived counts, policy, bundles
nexplan config set-test-policy <key> <value> [--project key]     # keys: requirePassingOnComplete, allowForce, archive.auto, archive.hotDays, archive.hotMax, archive.hysteresisRatio, archive.minIntervalHours, archive.minRunsPerArchive, archive.budgetMs, archive.bundle
```

- **A failure files a bug for you** — `test run … --result fail` opens a bug automatically
  (disable per call with `--no-bug`). Filing is deduplicated: if the case already has an
  `open`/`reopened` bug, the new evidence is appended to it instead of opening a duplicate.
  The case's priority sets the bug's severity (`P0→critical`, `P1→major`, `P2→minor`,
  `P3→trivial`).
- **A pass advances the bugs the case guards** — `open`/`reopened` → `fixed`; with the
  explicit `--verify` flag it also moves `fixed` → `verified`. A **fail** on a
  `fixed`/`verified` bug moves it → `reopened` (a regression caught). `wontfix` bugs are
  never touched, and every automatic transition is written into the bug's notes.
- **`nexplan test report`** summarises whatever scope you give it (`--batch`, `--build`,
  `--work-item`, or the whole project): pass rate, cases that never ran, failing cases,
  flaky cases (the same case both passing and failing in scope), and work-item coverage
  (how many work items have cases at all).
- **The completion gate is off by default** — `nexplan done` always prints a verification
  summary (pass/fail/not-run counts) and adds a note when linked cases are failing. Switch
  it on with `nexplan config set-test-policy requirePassingOnComplete true` and completing
  an item whose linked active cases are failing or never run is refused, with a hint to pass
  `--force`; forcing the completion is recorded in the item's notes.
- **Archived runs are merged in by default** — queries read hot and archived runs together,
  so history stays complete; `--hot-only` restricts them to runs still on disk as individual
  files.

### Documents

| Command | Description |
|---|---|
| `nexplan docs list` / `ls` | List documents (slug, version, status, type, title). |
| `nexplan docs show <slug>` | Print the markdown body. |
| `nexplan docs new <title> [options]` | Create: `--type`, `--body`, `--status`, `--tags`, `--slug`. Version starts at 1. |
| `nexplan docs update <slug> [options]` | Update: `--content`, `--title`, `--type`, `--status`, `--tags`. **Bumps the version** and records a git commit. |
| `nexplan docs history <slug>` | Show version history (newest first). |
| `nexplan docs diff <slug> <shaA> <shaB>` | Diff two versions by commit sha (from `history`). |
| `nexplan docs comment <slug> <body>` | Add a comment to a doc (project member/admin only). |

```bash
nexplan docs new "下单设计" --type design --body "# 设计\n\n走队列"
nexplan docs update "下单设计" --content "# 设计\n\n改同步" --status approved
nexplan docs history "下单设计"
```

### Board

| Command | Description |
|---|---|
| `nexplan status` | Summary counts by status + recent activity. |
| `nexplan web [--port n] [--host h \| --remote]` | Start the web dashboard (default port 3344). Defaults to `127.0.0.1`; pass `--remote` (or `--host 0.0.0.0`) to let **other machines on your network** open it — the server prints the LAN URLs it is reachable at. |

### Multi-project

`--project <key>` (or `NEXPLAN_PROJECT`) selects the active project for any board
command; it defaults to the workspace's default project.

| Command | Description |
|---|---|
| `nexplan project list` | List projects. |
| `nexplan project new <key> [--name n] [--description d] [--members a,b]` | Create a project. |
| `nexplan project use <key>` | Set the workspace default project. |
| `nexplan project show <key>` | Show project details. |
| `nexplan project rm <key>` | Delete a project (not the default). |

### Multi-user

| Command | Description |
|---|---|
| `nexplan user list` | List registered users. |
| `nexplan user add <id> [--name n] [--kind human\|agent] [--role admin\|member\|viewer] [--password pw]` | Register a user. `--password` gives a human a web-login password (agents are authorized by id, they don't use one). |
| `nexplan user role <id> <admin\|member\|viewer>` | Change a user's role. |
| `nexplan user password <id> [<pw>]` | Set or reset a human's web-login password. |
| `nexplan user rm <id>` | Remove a user. |
| `nexplan config set-enforce-permissions <true\|false>` | Require registered users for writes; a `viewer` role is read-only. |

Roles: `admin` (everything), `member` (write work/bugs/docs), `viewer` (read-only).
With permissions **enforced**, writes require a registered non-viewer user.

```bash
nexplan project new backend --name "后端" --description "服务端"
nexplan --project backend add "实现下单 API" --priority P0
nexplan user add alice --kind human --role admin --password s3cret   # human → web login
nexplan user add claude-code --kind agent --role member              # agent → MCP/CLI, no password
nexplan user password alice new-s3cret                               # reset a password
nexplan user list
```

### Access control & per-agent config

Access control works in three layers:

1. **Project member roster (always active)** — a project that lists `members` is
   restricted to those members + admins (reads and writes). Empty roster = open.
2. **Strict mode** (`nexplan config set-enforce-permissions true`) — additionally
   requires registered users, makes `admin` the only role allowed to manage the
   workspace, and makes `viewer` read-only.

   Every workspace auto-bootstraps a default **`admin`** user on init (and re-seeds
   one when strict mode is enabled), so enabling strict mode can never lock you out
   of management — you always have an `admin` to operate as.
3. **Web login (human users)** — the web dashboard authenticates humans with a
   password. The default `admin` has the initial password `admin` and is forced to
   change it on first login. Anonymous requests can **read** open projects but must
   **log in** to write or manage. Agent users have no password — they are authorized
   by id + project membership (unchanged for CLI/MCP).

Scope an agent to a project and generate its MCP config:

```bash
nexplan user add claude-code --kind agent --role member
nexplan project new backend --members claude-code
nexplan agent config claude-code --project backend   # prints MCP config + access note
```

`agent config` emits a ready-to-paste MCP snippet (with `NEXPLAN_PROJECT` +
`NEXPLAN_AGENT`) so each agent is scoped and correctly attributed. Grant access by
adding the agent to a project's members or by giving it the `admin` role.

---

## 6. MCP server (for coding agents)

The MCP server exposes the same capabilities as the CLI to **any MCP-capable agent**
(Claude Code, Codex, OpenCode, dsh). This is the recommended integration for agents.

### Run it

```
command: node
args:    ["/abs/path/to/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /abs/path/to/your/.nexplan   # required — the board to use
  NEXPLAN_AGENT:  claude-code                   # optional — default author
```

Per-agent config examples: [`docs/agents/`](agents/) (claude-code, codex, opencode, dsh).
A cross-agent overview: [`docs/AGENTS.md`](AGENTS.md).

> If an agent can’t load MCP servers, it can drive the exact same board by shelling
> out to the `nexplan` CLI (Step 5).

### The 36 tools

Most tools accept an optional `project` argument (defaults to `$NEXPLAN_PROJECT` or
the workspace default).

| Tool | Purpose |
|---|---|
| `nexplan_backlog_add` | Enter a task / decomposed subtask into the backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | Read the backlog (filter/single) |
| `nexplan_backlog_claim` | Take an item: assign + `in_progress` |
| `nexplan_backlog_complete` | Mark done; optionally auto-close linked bugs |
| `nexplan_backlog_update` | Edit any field (incl. status) |
| `nexplan_backlog_decompose` | Split a parent item into child backlog items |
| `nexplan_backlog_note` | Append a progress/context note |
| `nexplan_backlog_delete` | Delete an item (its creator or an admin only) |
| `nexplan_docs_list` / `nexplan_docs_get` | Read design/decision docs |
| `nexplan_docs_create` | Record a design/decision/ADR document |
| `nexplan_docs_update` | Update a doc → new version |
| `nexplan_docs_history` / `nexplan_docs_diff` | Version history / diff |
| `nexplan_docs_comment` | Comment on a doc (project member/admin only) |
| `nexplan_bug_add` | Report a bug you discovered (with evidence) |
| `nexplan_bug_list` / `nexplan_bug_get` / `nexplan_bug_update` | Track bugs |
| `nexplan_test_case_add` | Create reusable test cases (link them to a work item) |
| `nexplan_test_case_list` / `nexplan_test_case_get` | Read test cases with latest result + run history |
| `nexplan_test_case_update` / `nexplan_test_case_delete` | Edit / delete a test case |
| `nexplan_test_run_record` | Record executions (one call may carry a whole suite); files a bug on failure, advances guarded bugs on pass |
| `nexplan_test_run_list` | Read execution records (hot + archived) |
| `nexplan_test_report` | Pass rate, not-run, failing and flaky cases |
| `nexplan_status` | Board summary + recent activity |
| `nexplan_agent_next` | Suggest the next item to pick up |
| `nexplan_project_list` / `nexplan_project_create` / `nexplan_project_set_default` | Manage projects |
| `nexplan_user_list` / `nexplan_user_add` / `nexplan_user_update` | Manage users (roles) |

Every write tool accepts an **`author`** argument and, where relevant, a
**`project`** argument. Set `author` to your agent name so the git history and
dashboard attribute the change correctly. If omitted, `NEXPLAN_AGENT` (or `agent`)
is used; if a project is omitted, `NEXPLAN_PROJECT` (or the default) is used.

```jsonc
// Example tool call: add a decomposed subtask
{ "items": [{ "title": "订单表结构", "type": "task", "priority": "P0" }], "author": "claude-code" }
```

---

## 7. Web dashboard

Run `nexplan web`, then open `http://127.0.0.1:3344`. By default the dashboard
listens on `127.0.0.1` only — run `nexplan web --remote` (or `--host 0.0.0.0`) to let
other machines on your LAN open it; startup then prints the LAN URLs (change the
default `admin` password before exposing it!). The UI is fully bilingual —
use the language switcher in the top-right corner (**English / 中文**). Your choice is
remembered; on the first visit the browser language is detected automatically.

Human users **log in** via the **Log in** button in the top-right corner
(ID + password). Every workspace guarantees a default **`admin`** user with the
initial password `admin`; it is forced to **change the password on first login**
(a “Change password” dialog appears right after login). Once logged in, the header
shows `name (role)` and a **Log out** button. Anonymous visitors can **read** open
projects, but every write and management action requires a login — API errors are
surfaced as a toast.

The dashboard has these tabs:

- **Board** — a kanban by status (`待办 / 待开始 / 进行中 / 评审中 / 完成 / 阻塞`). Click a
  card to open detail: view description, notes, change status, **claim/start**,
  **mark done**, and add notes. Use the search box, priority and assignee filters, and
  the **+ 新建待办** button to add items manually. A card whose work item has linked test
  cases carries a **test badge** (e.g. `✅ 2/3` = 2 of 3 cases passing, `❌` when one is
  failing) so you can see verification state right on the board.
- **Bugs** — searchable bug list with severity/status badges; **+ 录入缺陷** to report
  one; inline “标记已修”; click a bug to edit severity/status.
- **Tests** — the test-case list, each case with its **latest result**; filter by status,
  last result and priority, or search. Select a case for detail: preconditions, the
  **steps** table (action / expected), its linked work item and guarded bugs, and its
  **execution history**. **New run** opens the **Record execution** dialog (result, actual
  result, evidence, environment, build, batch, duration) and **📊 Report** opens the report
  dialog (pass rate, not-run, failing and flaky cases). **+ New test case** creates one.
- **Docs** — a document list on the left; select one to view its content (rendered
  from **Markdown**: headings, lists, tables, code blocks, images, links… and
  **Mermaid** ` ```mermaid ` diagrams rendered in the browser), metadata and
  **version history** on the right, plus a **comments** thread (project
  members/admins can comment). **编辑（生成新版本）** opens an inline editor with a
  live preview; **新建文档** creates one.
- **Admin** — project statistics and management (see below).

The project selector in the header switches the active project. The **管理 (Admin)**
tab adds a **project statistics** panel (work-item/bug/doc counts per project, click a
card to open it) plus project and user management (create/delete projects, set the
default, set roles, add users — the add-user form has an optional password field for
humans — and a strict-permissions toggle).

The dashboard refreshes automatically every 15 seconds and after each action. Web
login sessions last 7 days (a signed `nexplan_session` cookie).

---

## 8. Recommended agent workflow

1. **Orient** — `nexplan_status`, `nexplan_backlog_list`, `nexplan_agent_next`.
2. **Claim** — `nexplan_backlog_claim` before starting; decompose first if it’s big
   (`nexplan_backlog_decompose`).
3. **Document** — capture the *why* in a versioned doc (`nexplan_docs_create` / `update`).
4. **Log bugs** — anything you hit during development goes to `nexplan_bug_add` with
   `evidence`; link the fixing item via `fixesBug`.
5. **Verify** — create a test case **once** with `nexplan_test_case_add` (linked to the
   work item), then report **every** run with `nexplan_test_run_record` — one call can
   carry a whole suite's runs as an array. Recording the real results (not just prose in a
   note) is what makes the board's verification data trustworthy.
6. **Finish** — `nexplan_backlog_complete` (sets `done`, records a note, auto-closes
   linked bugs).

See [`docs/WORKFLOW.md`](WORKFLOW.md) for the full loop.

---

## 9. Git & versioning

- Every mutation is committed, so `git log` in the board directory is your audit trail.
- Documents carry a `version` counter in frontmatter; `docs history` and `docs diff` read
  directly from git, so you can always answer “what did the design look like before?”.

```bash
git -C "$NEXPLAN_BOARD" log --oneline     # full activity feed
nexplan docs history "下单设计"            # version list for one doc
```

---

## 10. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NEXPLAN_BOARD` | `./.nexplan` | Workspace (data) directory. Sets the same path in every agent config so they share one workspace. |
| `NEXPLAN_PROJECT` | workspace default | Active project key for board operations. |
| `NEXPLAN_AGENT` | `user` (CLI) / `agent` (MCP) | Default author attribution for writes. |
| `PORT` / `HOST` | `3344` / `127.0.0.1` | Web dashboard bind. |

CLI/JSON: `--root <path>`, `--project <key>` and `--json` modify behaviour for one invocation.

Web login sessions last 7 days; the cookie-signing secret is generated into
`<board>/.web-secret` on first start — keep it out of version control.

---

## 11. Troubleshooting / FAQ

**“`nexplan: command not found`”** — the CLI isn’t on PATH. Run `npm install -g .`
(or `node dist/cli/index.js …`). See [2. Requirements & install](#2-requirements--install).

**MCP server exits immediately with an init error** — the board directory isn’t
writable or git isn’t available. Check `NEXPLAN_BOARD` points to a writable path.

**I changed a doc but the version didn’t bump** — `docs update` bumps the version and
commits. `docs new` starts at version 1.

**I can’t add or edit anything in the web dashboard** — you are not logged in.
Anonymous visitors may read open projects, but every write and management action
requires a login (top-right **Log in**).

**What is the admin password?** — every workspace guarantees a default `admin` user
with the initial password `admin`, forced to change on first login. Reset it any time
with `nexplan user password admin <new-password>`.

**How do I give a human a web-login password?** — `nexplan user add <id> --kind human
--password <pw>` (or later: `nexplan user password <id> <pw>`). Agent users never need
a password — they are authorized by id + project membership.

**Agents see different boards** — make sure every agent config sets the **same**
`NEXPLAN_BOARD`.

**Where did the item/bug/doc go** — everything is a file under `<board>/`; if git is
active you can roll back with `git -C "$NEXPLAN_BOARD" checkout …`.
