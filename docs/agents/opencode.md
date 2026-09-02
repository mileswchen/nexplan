# OpenCode + NexPlan

OpenCode loads MCP servers from `opencode.json` in the project (or
`~/.config/opencode/opencode.json`). Register NexPlan as a local MCP server.

## `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nexplan": {
      "type": "local",
      "command": ["node", "/abs/path/to/nexplan/dist/mcp/server.js"],
      "environment": {
        "NEXPLAN_BOARD": "/abs/path/to/your-project/.nexplan",
        "NEXPLAN_PROJECT": "default"
      },
      "enabled": true
    }
  }
}
```

Pass `author: "opencode"` on write tools for attribution.

## Fallback via shell

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan decompose WI-2 --child "接口层" --child "存储层"
nexplan done WI-4 --note "完成并测试"
```
