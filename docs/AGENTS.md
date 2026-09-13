# Connecting coding agents to NexPlan (MCP)

NexPlan exposes the full backlog / bug / doc surface as a **Model Context Protocol**
server over **stdio**. Claude Code, Codex, OpenCode, and dsh all consume MCP servers,
so one server serves every agent.

## The MCP server

```
command: node
args:    ["<abs path>/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:   /abs/path/to/your/.nexplan   # REQUIRED — where the data lives
  NEXPLAN_PROJECT: default                      # optional — active project key
  NEXPLAN_AGENT:   claude-code                   # optional — default author attribution
```

> If you installed the CLI globally, you can also point the command at the package
> binary. Either way, set `NEXPLAN_BOARD` so every agent shares one workspace.
> Most tools accept an optional `project` argument that overrides `NEXPLAN_PROJECT`.

## Naming the agent

Each tool that writes accepts an optional `author` argument. Set it to your agent
name so the git history and UI attribute the change correctly:

```json
{ "items": [{ "title": "...", "type": "feature" }], "author": "claude-code" }
```

If omitted, `NEXPLAN_AGENT` (or `agent`) is used.

## Scoping an agent & access control

Register your agent once (admin operation), then grant access by adding it to a
project's members or by giving it the `admin` role:

```bash
nexplan user add claude-code --kind agent --role member
nexplan project new backend --members claude-code
nexplan agent config claude-code --project backend   # print a ready-to-paste MCP config
```

`nexplan agent config` emits an MCP snippet scoped to the agent + project (with
`NEXPLAN_PROJECT` and `NEXPLAN_AGENT` set) plus its role/membership status.

Agents never need a password — web-login passwords are for human dashboard users only;
agents are authorized by **id + project membership** (unchanged for MCP/CLI). Every
workspace also auto-bootstraps a default `admin` (initial password `admin`, forced to
change on first login), so enabling strict mode
(`nexplan config set-enforce-permissions true`) can never lock out management.

## The 36 tools

Most tools accept an optional `project` argument (defaults to `NEXPLAN_PROJECT` or the
workspace default).

| Tool | Purpose |
|---|---|
| `nexplan_backlog_add` | Enter a task / decomposed subtask into the backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | Read the backlog (filters) |
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
| `nexplan_agent_next` | Suggest the next thing to pick up |
| `nexplan_project_list` / `nexplan_project_create` / `nexplan_project_set_default` | Manage projects |
| `nexplan_user_list` / `nexplan_user_add` / `nexplan_user_update` | Manage users (roles) |

## Per-agent config files

Each is available in English and 简体中文.

| Agent | English | 简体中文 |
|---|---|---|
| Claude Code | [claude-code.md](agents/claude-code.md) | [claude-code.zh-CN.md](agents/claude-code.zh-CN.md) |
| Codex / Codex CLI | [codex.md](agents/codex.md) | [codex.zh-CN.md](agents/codex.zh-CN.md) |
| OpenCode | [opencode.md](agents/opencode.md) | [opencode.zh-CN.md](agents/opencode.zh-CN.md) |
| dsh (DeepSeek Harness) | [dsh.md](agents/dsh.md) | [dsh.zh-CN.md](agents/dsh.zh-CN.md) |

> 中文版跨 Agent 概览见 [AGENTS.zh-CN.md](AGENTS.zh-CN.md)。

Every agent that lacks MCP support can still drive the exact same board through the
`nexplan` CLI (shell out). See [WORKFLOW.md](WORKFLOW.md) for the recommended loop.

For the full human-facing docs, see the [User Guide](guides/UserGuide.en.md) /
[使用指南](guides/UserGuide.zh-CN.md) and the [command cheat sheet](CheatSheet.md).
