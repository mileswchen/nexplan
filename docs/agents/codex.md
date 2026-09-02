# Codex / Codex CLI + NexPlan

Codex CLI reads MCP servers from `~/.codex/config.toml`. Add a `[mcp_servers.nexplan]`
block pointing at the NexPlan MCP server.

## `~/.codex/config.toml`

```toml
[mcp_servers.nexplan]
command = "node"
args = ["/abs/path/to/nexplan/dist/mcp/server.js"]
env = { NEXPLAN_BOARD = "/abs/path/to/your-project/.nexplan", NEXPLAN_PROJECT = "default" }
```

Set `NEXPLAN_AGENT = "codex"` in the same `env` table (or pass `author: "codex"` on
write tools) so your changes are attributed.

## Fallback via shell

Codex can also shell out to the CLI:

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan claim WI-5 --assignee codex
nexplan docs new "数据模型" --type architecture --body "..." 
nexplan bug add "空指针" --severity critical --evidence "TypeError"
```
