# Claude Code + NexPlan

Claude Code 从项目级 `.mcp.json`（推荐，随仓库提交）或用户配置中加载 MCP server。
把指向 NexPlan MCP server 的配置加进去即可。

## 项目级 `.mcp.json`

```json
{
  "mcpServers": {
    "nexplan": {
      "command": "node",
      "args": ["/绝对路径/到/nexplan/dist/mcp/server.js"],
      "env": {
        "NEXPLAN_BOARD": "/绝对路径/到/你的项目/.nexplan",
        "NEXPLAN_PROJECT": "default",
        "NEXPLAN_AGENT": "claude-code"
      }
    }
  }
}
```

然后在该项目文件夹里运行 `claude`，`nexplan_*` 工具就会出现。在写操作里加
`author: "claude-code"`，好让 git 历史里正确归属。

## 如果无法用 MCP

同样的看板也能通过 shell 访问，Claude Code 也可以这样驱动：

```bash
# 构建一次
cd /绝对路径/到/nexplan && npm install && npm run build

export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan add "修复登录 500" --type bug --priority P1 --manual
nexplan list --status backlog
nexplan done WI-3 --note "已修复"
```
