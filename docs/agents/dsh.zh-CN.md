# dsh（DeepSeek Harness）+ NexPlan

dsh 是一个 Agent 运行框架，其 Agent 自带各自工具集。**最稳健、可移植的接入方式**
是让 dsh Agent 通过 shell 调用 `nexplan` CLI（dsh Agent 可以跑 bash）。如果你的
dsh 运行时能通过 stdio 加载 MCP server，也可以改用 MCP server —— 工具名与行为完全一致。

## 方案 A —— 用 shell 调用 CLI（任何环境都可用）

先构建一次，再把看板指向你的项目：

```bash
cd /绝对路径/到/nexplan && npm install && npm run build
export NEXPLAN_BOARD="$PWD/.nexplan"
export NEXPLAN_AGENT="dsh"
```

然后 dsh Agent 就能直接操作看板，例如：

```bash
# 把一个分解任务录入 backlog
nexplan add "实现 OAuth 回调" --type feature --priority P1 --assignee dsh

# 认领下一条、完成，并发布一个决策文档
nexplan claim WI-2 --assignee dsh
nexplan done WI-2 --note "完成并补测试"
nexplan docs new "oauth-flow" --type decision --body "# 决策\n\n使用 PKCE。"
nexplan bug add "刷新 token 过期" --severity major --evidence "ExpiredTokenError"
```

通过 `NEXPLAN_BOARD` 把看板路径传给 Agent，让每个会话共享同一个看板。

## 方案 B —— MCP server

如果你的 dsh 配置支持通过 stdio 注册外部 MCP server，请注册：

```
command: node
args:    ["/绝对路径/到/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /绝对路径/到/你的项目/.nexplan
  NEXPLAN_PROJECT: default
  NEXPLAN_AGENT:  dsh
```

随后 20 个 `nexplan_*` 工具就会出现在 dsh 的工具列表里。

## dsh 的习惯做法

1. 用 `nexplan add` 录入父特性。
2. 用 `nexplan decompose <id> --child …` 拆分。
3. 用 `nexplan agent-next`（CLI：`nexplan list --status backlog --priority P0`
   或一个小包装）找下一条。
4. 用 `nexplan docs new|update` 记录设计 / 决策文档。
5. 开发中发现的缺陷用 `nexplan bug add` 记录。
