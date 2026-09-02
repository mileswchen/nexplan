# Codex / Codex CLI + NexPlan

Codex CLI 从 `~/.codex/config.toml` 读取 MCP server。加一个 `[mcp_servers.nexplan]`
块，指向 NexPlan MCP server 即可。

## `~/.codex/config.toml`

```toml
[mcp_servers.nexplan]
command = "node"
args = ["/绝对路径/到/nexplan/dist/mcp/server.js"]
env = { NEXPLAN_BOARD = "/绝对路径/到/你的项目/.nexplan", NEXPLAN_PROJECT = "default" }
```

在同一张 `env` 表里设置 `NEXPLAN_AGENT = "codex"`（或在写工具里传 `author: "codex"`），
让你的变更被正确归属。

## 通过 shell 兜底

Codex 也可以 shell 调用 CLI：

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan claim WI-5 --assignee codex
nexplan docs new "数据模型" --type architecture --body "..."
nexplan bug add "空指针" --severity critical --evidence "TypeError"
```
