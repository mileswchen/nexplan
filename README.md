# NexPlan

**NexPlan** is a git-backed project management hub for coding agents. It is a single
tool that **dsh, Claude Code, Codex, OpenCode** and other MCP-capable agents can all
load, so every agent in your workflow talks to the same backlog, bug tracker, and
versioned documentation.

Everything lives in one **git repository** of plain files — so you get a free audit
trail, diffs, conflict-safe parallel work, and real version history for documents.

## What it does

| Capability | How it works |
|---|---|
| **Manually enter backlog** | Web kanban board / `nexplan add` CLI / MCP `nexplan_backlog_add` |
| **Agent enters decomposed tasks into backlog** | MCP `nexplan_backlog_decompose` / `nexplan_backlog_add` |
| **Agent claims an item; status updates automatically when done** | `nexplan_backlog_claim` → `nexplan_backlog_complete` |
| **Design & decision docs (versioned)** | MCP `nexplan_docs_create/update/history/diff`; every update creates a git version |
| **Manually entered bugs + agent-discovered bugs** | `nexplan_bug_add/list/update`; auto-`fixed` when the linked item completes |
| **Test cases + execution records** | `nexplan_test_case_add/list/update`, `nexplan_test_run_record` (batch), `nexplan_test_report`; a failing run files a bug, a passing run fixes/verifies the bugs it guards |
| **Multi-project management** | One workspace holds multiple projects, each with its own backlog / bugs / docs; select via `--project` / `?project=` / MCP `project` parameter |
| **Multi-user management** | User registry (humans + agents) with `admin / member / viewer` roles; `viewer` is read-only, can be strictly enforced |
| **Access control** | Project member-roster check (projects with a roster are limited to members + admins); with strict mode enabled, only `admin` can manage |

## Quick start

```bash
cd <your project>
# 1. Point the workspace at this project (defaults to ./.nexplan)
export NEXPLAN_BOARD="$PWD/.nexplan"

# 2. Build (or use the CLI via the package)
npm install   # first time
npm run build

# 3. Human interfaces
nexplan web                  # open the web dashboard on http://127.0.0.1:3344
nexplan add "Refactor auth module" --type refactor --priority P1 --tags auth
nexplan list --status backlog
nexplan status

# 4. Projects & users
nexplan project new api --name "API rewrite" --description Backend
nexplan --project api add "Order API" --priority P0
nexplan user add claude-code --kind agent --role member
nexplan user list

# 5. Agent interface (MCP) — see docs/AGENTS.md for per-agent config
```

> `NEXPLAN_AGENT` names the agent that authored writes (defaults to `user`). If you
> leave it unset when an agent writes, the `author` tool argument is used.
> `NEXPLAN_PROJECT` (or `--project`) selects the active project.

## Installing the CLI

```bash
npm install -g .        # then `nexplan` is on your PATH
# or run without installing:
node dist/cli/index.js list
```

## The three interfaces

- **CLI** (`nexplan …`) — humans and scripting.
- **MCP server** (`node dist/mcp/server.js`) — agents. Exposes 36 `nexplan_*` tools.
- **Web dashboard** (`nexplan web`) — humans: kanban board, bug tracker, doc viewer/history, and a projects/users admin panel.

All three share the same git-backed workspace + `Store`, so they are fully consistent.

## Where the data lives

```
<workspace>/                       (NEXPLAN_BOARD, a single git repo)
  workspace.json                   default project, project list, permission flags, test policy
  users/<id>.json                  user registry (role, kind)
  projects/<key>/                  one board per project
    project.json                   project meta (name, description, members)
    .counters.json                 id counters (never reuse an id after a delete)
    workitems/  WI-*.json          backlog tasks
    bugs/       BUG-*.json
    testcases/  TC-*.json          test cases
    testruns/   TR-*.json          execution records (one file per run)
      archive/<YYYY-MM>.jsonl      archived (cold) runs, one JSON per line
    docs/       <slug>.md          documents (markdown + frontmatter)
```

Every mutation is `git add` + `git commit` (scoped to the project subtree), so
`git log` is your full activity feed. Documents additionally embed a `version`
counter in frontmatter; document history and diffs come straight from git.

## Requirements

- Node ≥ 20 (tested on Node 24)
- git (for the audit/versioning layer)

## Development

```bash
npm run build        # tsc → dist/
npm test             # vitest: core store + MCP end-to-end
npm run dev:mcp      # run the MCP server from source
npm run dev:web      # run the web server from source
```

## CLI reference

Global options: `--root <path>` (workspace dir), `--project <key>`, `--json`.

```
nexplan add "<title>" [--type t] [--priority P] [--description d] [--tags a,b] [--assignee name] [--doc-link url] [--manual] [--json-input] [--project key]
nexplan list [--status s] [--priority p] [--assignee name] [--query q] [--limit n] [--project key]
nexplan get <id> [--project key]
nexplan claim <id> --assignee name [--project key]
nexplan update <id> [--status s] [--title t] [--priority p] [--doc-link url] ... [--project key]
nexplan done <id> [--note n] [--no-close-bugs] [--project key]
nexplan decompose <parentId> --child "subtask A" [--project key]
nexplan note <id> <body> [--project key]
nexplan rm <id> [--project key]   # delete a work item (creator or admin only)
nexplan bug add "<title>" [--severity s] [--evidence e] [--manual] [--project key]
nexplan bug list [--status s] [--severity s] [--query q] [--project key]
nexplan bug get <id> [--project key]
nexplan bug update <id> [--status s] [--severity s] [--assignee name] [--project key]
nexplan test list [--status s] [--type t] [--priority p] [--work-item WI-1] [--last-result r] [--query q] [--project key]
nexplan test add "<title>" [--type functional] [--priority P1] [--status active] [--work-item WI-1] [--step "action|expected"]... [--tag a,b] [--project key]
nexplan test get <TC-1> [--history n] [--project key]
nexplan test update <TC-1> [--status s] [--priority p] [--work-item WI-1] ... [--project key]
nexplan test rm <TC-1> [--force] [--project key]
nexplan test run <TC-1> --result pass|fail|blocked|skipped [--actual "..." ] [--evidence "..."] [--env ci] [--build v0.4.0] [--batch "regression"] [--no-bug] [--verify] [--project key]
nexplan test history [<TC-1>] [--result fail] [--build v] [--batch b] [--from d] [--to d] [--hot-only] [--project key]
nexplan test report [--batch b] [--build v] [--work-item WI-1] [--hot-only] [--project key]
nexplan test archive [--dry-run] [--before <iso>] [--keep n] | test archive <YYYY-MM> --restore | test archive --reindex | test archive-status   [--project key]
nexplan config set-test-policy <key> <value> [--project key]   # e.g. requirePassingOnComplete true, archive.hotMax 5000
nexplan docs list | docs show <slug> | docs new <title> | docs update <slug> | docs history <slug> | docs diff <slug> <shaA> <shaB> | docs comment <slug> <body>   [--project key]
nexplan status [--project key]
nexplan web [--port n] [--host h | --remote]   # --remote = 0.0.0.0, allow other machines (prints LAN URLs)

# Multi-project
nexplan project list
nexplan project new <key> [--name n] [--description d] [--members a,b]
nexplan project use <key>      # set default project
nexplan project show <key>
nexplan project rm <key>

# Multi-user
nexplan user list
nexplan user add <id> [--name n] [--kind human|agent] [--role admin|member|viewer] [--password pw]
nexplan user role <id> <admin|member|viewer>
nexplan user password <id> [<pw>]   # set/reset a login password
nexplan user rm <id>

# Workspace
nexplan config set-enforce-permissions <true|false>
nexplan agent config <user-id> [--project key]   # print an MCP config scoped to an agent + project
```

Add `--json` to any command for JSON output.

## Access control

Permissions are layered:

1. **Project member roster (always active)** — a project that lists `members` is
   restricted to those members + admins, for both reads and writes. An empty roster
   means the project stays open. Set members when creating a project
   (`nexplan project new api --members alice,claude-code`) or in the Web admin page.
2. **Strict mode (`nexplan config set-enforce-permissions true`)** — additionally
   requires registered users for writes and makes `admin` the only role allowed to
   manage the workspace (create/delete/update projects, users, config). A `viewer`
   is read-only.

   Every workspace auto-bootstraps a default **`admin`** user on init (and re-seeds
   one when strict mode is enabled), so enabling strict mode can never lock you out
   of workspace management — you always have an `admin` to operate as.

3. **Web login (human users)** — the web dashboard now authenticates humans with a
   password. The default `admin` has the initial password `admin` and is forced to
   change it on first login. Anonymous requests can **read** open projects but must
   **log in** to write or manage. Agent users have no password and are authorized by
   id + project membership (unchanged).

To scope an agent to a project with permissions, generate its MCP config:

```bash
nexplan user add claude-code --kind agent --role member
nexplan project new backend --members claude-code
nexplan agent config claude-code --project backend
```

`agent config` prints a ready-to-paste MCP config with `NEXPLAN_PROJECT` +
`NEXPLAN_AGENT` set, plus the agent's role/membership status. Grant access by adding
the agent to a project's members, or by giving it the `admin` role.

## Agent integration

See [`docs/AGENTS.md`](docs/AGENTS.md) (or the Chinese overview
[`docs/AGENTS.zh-CN.md`](docs/AGENTS.zh-CN.md)) for the shared MCP setup and
[`docs/WORKFLOW.md`](docs/WORKFLOW.md) for the suggested agent operating loop.

Per-agent configs live in [`docs/agents/`](docs/agents/) — each in **English and
简体中文**:

| Agent | English | 简体中文 |
|---|---|---|
| Claude Code | [`claude-code.md`](docs/agents/claude-code.md) | [`claude-code.zh-CN.md`](docs/agents/claude-code.zh-CN.md) |
| Codex / Codex CLI | [`codex.md`](docs/agents/codex.md) | [`codex.zh-CN.md`](docs/agents/codex.zh-CN.md) |
| OpenCode | [`opencode.md`](docs/agents/opencode.md) | [`opencode.zh-CN.md`](docs/agents/opencode.zh-CN.md) |
| dsh (DeepSeek Harness) | [`dsh.md`](docs/agents/dsh.md) | [`dsh.zh-CN.md`](docs/agents/dsh.zh-CN.md) |

## Documentation

| Guide | English | 简体中文 |
|---|---|---|
| **User Guide** | [`UserGuide.en.md`](docs/guides/UserGuide.en.md) | [`UserGuide.zh-CN.md`](docs/guides/UserGuide.zh-CN.md) |
| **Command Cheat Sheet** (bilingual) | [`docs/CheatSheet.md`](docs/CheatSheet.md) | — |

The guides cover: what NexPlan does, install, the board & enum reference, the full CLI
reference, MCP tools, the web dashboard, the agent workflow, git/versioning,
configuration, and a troubleshooting FAQ — in both English and Chinese.

## Quick start (fastest path)

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan add "Refactor auth module" --type refactor --priority P1 --manual
nexplan list --status backlog
nexplan claim WI-1 --assignee claude-code
nexplan done WI-1 --note "Done"
nexplan web
```
