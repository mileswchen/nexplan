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

It is exposed through **three interfaces** that all share the same store:

1. **CLI** — `nexplan …` (humans, scripts).
2. **MCP server** — `node dist/mcp/server.js` (agents; 20 `nexplan_*` tools).
3. **Web dashboard** — `nexplan web` (humans; kanban board, bug tracker, doc viewer).

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

The **board** is a directory (a git repo) that holds everything. By default it is
`./.nexplan` in the current working directory; set `NEXPLAN_BOARD` to relocate it.

```
<board>/
  nexplan.json        project metadata
  workitems/          WI-*.json       backlog tasks
  bugs/               BUG-*.json      bugs
  docs/               <slug>.md       documents (markdown + frontmatter)
```

Every mutation runs `git add` + `git commit`, so `git log` is your full activity
feed, and documents get real version history.

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
| `nexplan add "<title>" [options]` | Add one work item. `--type`, `--priority`, `--description`, `--assignee`, `--tags a,b`, `--estimate n`, `--fixes-bug BUG-1,BUG-2`, `--manual`, `--json-input` (read items from stdin as JSON). |
| `nexplan list` / `ls` | List work items. `--status`, `--type`, `--priority`, `--assignee`, `--tags`, `--query`, `--limit`. |
| `nexplan get <id>` | Full detail of one item (incl. notes, children, links). |
| `nexplan claim <id> --assignee <name>` | Take ownership: sets `assignee` and status to `in_progress`. Optional `--status`. |
| `nexplan update <id> [options]` | Edit fields: `--title`, `--description`, `--type`, `--priority`, `--status`, `--assignee`, `--tags`, `--estimate`. |
| `nexplan done <id> [options]` (`complete`) | Mark done; `--note`, `--no-close-bugs`. Auto-closes bugs listed in `fixesBug`. |
| `nexplan decompose <parentId> --child "<title>" …` | Split a parent into child backlog items (linked to the parent). |
| `nexplan note <id> <body>` | Append a progress/context note. |

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

### Documents

| Command | Description |
|---|---|
| `nexplan docs list` / `ls` | List documents (slug, version, status, type, title). |
| `nexplan docs show <slug>` | Print the markdown body. |
| `nexplan docs new <title> [options]` | Create: `--type`, `--body`, `--status`, `--tags`, `--slug`. Version starts at 1. |
| `nexplan docs update <slug> [options]` | Update: `--content`, `--title`, `--type`, `--status`, `--tags`. **Bumps the version** and records a git commit. |
| `nexplan docs history <slug>` | Show version history (newest first). |
| `nexplan docs diff <slug> <shaA> <shaB>` | Diff two versions by commit sha (from `history`). |

```bash
nexplan docs new "下单设计" --type design --body "# 设计\n\n走队列"
nexplan docs update "下单设计" --content "# 设计\n\n改同步" --status approved
nexplan docs history "下单设计"
```

### Board

| Command | Description |
|---|---|
| `nexplan status` | Summary counts by status + recent activity. |
| `nexplan web [--port n]` | Start the web dashboard (default port 3344). |

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

### The 20 tools

| Tool | Purpose |
|---|---|
| `nexplan_backlog_add` | Enter a task / decomposed subtask into the backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | Read the backlog (filter/single) |
| `nexplan_backlog_claim` | Take an item: assign + `in_progress` |
| `nexplan_backlog_complete` | Mark done; optionally auto-close linked bugs |
| `nexplan_backlog_update` | Edit any field (incl. status) |
| `nexplan_backlog_decompose` | Split a parent item into child backlog items |
| `nexplan_backlog_note` | Append a progress/context note |
| `nexplan_docs_list` / `nexplan_docs_get` | Read design/decision docs |
| `nexplan_docs_create` | Record a design/decision/ADR document |
| `nexplan_docs_update` | Update a doc → new version |
| `nexplan_docs_history` / `nexplan_docs_diff` | Version history / diff |
| `nexplan_bug_add` | Report a bug you discovered (with evidence) |
| `nexplan_bug_list` / `nexplan_bug_get` / `nexplan_bug_update` | Track bugs |
| `nexplan_status` | Board summary + recent activity |
| `nexplan_agent_next` | Suggest the next item to pick up |

Every write tool accepts an **`author`** argument — set it to your agent name so the
git history and dashboard attribute the change correctly. If omitted, `NEXPLAN_AGENT`
(or `agent`) is used.

```jsonc
// Example tool call: add a decomposed subtask
{ "items": [{ "title": "订单表结构", "type": "task", "priority": "P0" }], "author": "claude-code" }
```

---

## 7. Web dashboard

Run `nexplan web`, then open `http://127.0.0.1:3344`. It has three tabs:

- **Board** — a kanban by status (`待办 / 待开始 / 进行中 / 评审中 / 完成 / 阻塞`). Click a
  card to open detail: view description, notes, change status, **claim/start**,
  **mark done**, and add notes. Use the search box, priority and assignee filters, and
  the **+ 新建待办** button to add items manually.
- **Bugs** — searchable bug list with severity/status badges; **+ 录入缺陷** to report
  one; inline “标记已修”; click a bug to edit severity/status.
- **Docs** — a document list on the left; select one to view its content, metadata and
  **version history** on the right. **编辑（生成新版本）** updates it as a new version;
  **新建文档** creates one.

The dashboard refreshes automatically every 15 seconds and after each action.

---

## 8. Recommended agent workflow

1. **Orient** — `nexplan_status`, `nexplan_backlog_list`, `nexplan_agent_next`.
2. **Claim** — `nexplan_backlog_claim` before starting; decompose first if it’s big
   (`nexplan_backlog_decompose`).
3. **Document** — capture the *why* in a versioned doc (`nexplan_docs_create` / `update`).
4. **Log bugs** — anything you hit during development goes to `nexplan_bug_add` with
   `evidence`; link the fixing item via `fixesBug`.
5. **Finish** — `nexplan_backlog_complete` (sets `done`, records a note, auto-closes
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
| `NEXPLAN_BOARD` | `./.nexplan` | Board (data) directory. Set the same path in every agent config so they share one board. |
| `NEXPLAN_AGENT` | `user` (CLI) / `agent` (MCP) | Default author attribution for writes. |
| `PORT` / `HOST` | `3344` / `127.0.0.1` | Web dashboard bind. |

CLI/JSON: `--root <path>` and `--json` modify behaviour for one invocation.

---

## 11. Troubleshooting / FAQ

**“`nexplan: command not found`”** — the CLI isn’t on PATH. Run `npm install -g .`
(or `node dist/cli/index.js …`). See [2. Requirements & install](#2-requirements--install).

**MCP server exits immediately with an init error** — the board directory isn’t
writable or git isn’t available. Check `NEXPLAN_BOARD` points to a writable path.

**I changed a doc but the version didn’t bump** — `docs update` bumps the version and
commits. `docs new` starts at version 1.

**Agents see different boards** — make sure every agent config sets the **same**
`NEXPLAN_BOARD`.

**Where did the item/bug/doc go** — everything is a file under `<board>/`; if git is
active you can roll back with `git -C "$NEXPLAN_BOARD" checkout …`.
