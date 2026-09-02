# Claude Code + NexPlan

Claude Code loads MCP servers from a project `.mcp.json` (recommended, committed to
the repo) or from your user config. Point it at the NexPlan MCP server.

## Project `.mcp.json`

```json
{
  "mcpServers": {
    "nexplan": {
      "command": "node",
      "args": ["/abs/path/to/nexplan/dist/mcp/server.js"],
      "env": {
        "NEXPLAN_BOARD": "/abs/path/to/your-project/.nexplan",
        "NEXPLAN_PROJECT": "default",
        "NEXPLAN_AGENT": "claude-code"
      }
    }
  }
}
```

Then run `claude` in that project folder and the `nexplan_*` tools appear. Add
`author: "claude-code"` to write calls so they're attributed in the git history.

## If MCP is unavailable

The same board is reachable from a shell, which Claude Code can also drive:

```bash
# build once
cd /abs/path/to/nexplan && npm install && npm run build

export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan add "修复登录 500" --type bug --priority P1 --manual
nexplan list --status backlog
nexplan done WI-3 --note "已修复"
```
