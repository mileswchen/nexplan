# OpenCode + NexPlan

OpenCode 从项目里的 `opencode.json`（或 `~/.config/opencode/opencode.json`）加载 MCP
server。把 NexPlan 注册成 local MCP server。

## `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nexplan": {
      "type": "local",
      "command": ["node", "/绝对路径/到/nexplan/dist/mcp/server.js"],
      "environment": {
        "NEXPLAN_BOARD": "/绝对路径/到/你的项目/.nexplan"
      },
      "enabled": true
    }
  }
}
```

在写工具里传 `author: "opencode"` 以便归属。

## 通过 shell 兜底

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan decompose WI-2 --child "接口层" --child "存储层"
nexplan done WI-4 --note "完成并测试"
```
