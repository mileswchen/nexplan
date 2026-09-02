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
| **手动录入 backlog** | Web 看板 / `nexplan add` CLI / MCP `nexplan_backlog_add` |
| **Agent 把分解任务录入 backlog** | MCP `nexplan_backlog_decompose` / `nexplan_backlog_add` |
| **Agent 取 item，做完自动更新状态** | `nexplan_backlog_claim` → `nexplan_backlog_complete` |
| **设计与决策文档（版本管理）** | MCP `nexplan_docs_create/update/history/diff`；每个更新产生 git 版本 |
| **手动录入 bug + Agent 自动发现的 bug** | `nexplan_bug_add/list/update`；完成关联 item 时自动 `fixed` |

## Quick start

```bash
cd <your project>
# 1. Reset the board to this project (defaults to ./.nexplan)
export NEXPLAN_BOARD="$PWD/.nexplan"

# 2. Build (or use the CLI via the package)
npm install   # first time
npm run build

# 3. Human interfaces
nexplan web                  # open the web dashboard on http://127.0.0.1:3344
nexplan add "重构认证模块" --type refactor --priority P1 --tags auth
nexplan list --status backlog
nexplan status

# 4. Agent interface (MCP) — see docs/AGENTS.md for per-agent config
```

> `NEXPLAN_AGENT` names the agent that authored writes (defaults to `user`). If you
> leave it unset when an agent writes, the `author` tool argument is used.

## Installing the CLI

```bash
npm install -g .        # then `nexplan` is on your PATH
# or run without installing:
node dist/cli/index.js list
```

## The three interfaces

- **CLI** (`nexplan …`) — humans and scripting.
- **MCP server** (`node dist/mcp/server.js`) — agents. Exposes 20 `nexplan_*` tools.
- **Web dashboard** (`nexplan web`) — humans: kanban board, bug tracker, doc viewer/history.

All three share the same git-backed `Store`, so they are fully consistent.

## Where the data lives

```
<board>/
  nexplan.json        project meta
  workitems/          WI-*.json  (backlog tasks)
  bugs/               BUG-*.json
  docs/               <slug>.md  (markdown + frontmatter metadata)
```

Every mutation is `git add` + `git commit`, so `git log` is your full activity feed.
Documents additionally embed a `version` counter in frontmatter; document history and
diffs come straight from git.

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

```
nexplan add "<title>" [--type t] [--priority P] [--description d] [--tags a,b] [--assignee name] [--manual] [--json-input]
nexplan list [--status s] [--priority p] [--assignee name] [--query q] [--limit n]
nexplan get <id>
nexplan claim <id> --assignee name
nexplan update <id> [--status s] [--title t] [--priority p] ...
nexplan done <id> [--note n] [--no-close-bugs]
nexplan decompose <parentId> --child "subtask A" --child "subtask B"
nexplan note <id> <body>
nexplan bug add "<title>" [--severity s] [--evidence e] [--manual]
nexplan bug list [--status s] [--severity s] [--query q]
nexplan bug get <id>
nexplan bug update <id> [--status s] [--severity s] [--assignee name]
nexplan docs list | docs show <slug> | docs new <title> | docs update <slug> [--content c] | docs history <slug> | docs diff <slug> <shaA> <shaB>
nexplan status
nexplan web [--port n]
```

Add `--json` to any command for JSON output.

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
nexplan add "重构认证模块" --type refactor --priority P1 --manual
nexplan list --status backlog
nexplan claim WI-1 --assignee claude-code
nexplan done WI-1 --note "完成"
nexplan web
```
