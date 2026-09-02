# Connecting coding agents to NexPlan (MCP)

NexPlan exposes the full backlog / bug / doc surface as a **Model Context Protocol**
server over **stdio**. Claude Code, Codex, OpenCode, and dsh all consume MCP servers,
so one server serves every agent.

## The MCP server

```
command: node
args:    ["<abs path>/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /abs/path/to/your/.nexplan   # REQUIRED — where the data lives
  NEXPLAN_AGENT:  claude-code                   # optional — default author attribution
```

> If you installed the CLI globally, you can also point the command at the package
> binary. Either way, set `NEXPLAN_BOARD` so every agent shares one board.

## Naming the agent

Each tool that writes accepts an optional `author` argument. Set it to your agent
name so the git history and UI attribute the change correctly:

```json
{ "items": [{ "title": "...", "type": "feature" }], "author": "claude-code" }
```

If omitted, `NEXPLAN_AGENT` (or `agent`) is used.

## The 20 tools

| Tool | Purpose |
|---|---|
| `nexplan_backlog_add` | Enter a task / decomposed subtask into the backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | Read the backlog (filters) |
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
| `nexplan_agent_next` | Suggest the next thing to pick up |

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
