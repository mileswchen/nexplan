# 把 Coding Agent 接入 NexPlan（MCP）

NexPlan 通过 **Model Context Protocol** server（stdio）暴露完整的 backlog / 缺陷 /
文档能力。Claude Code、Codex、OpenCode、dsh 都能消费 MCP server，所以一个 server
就能服务所有 Agent。

## MCP server

```
command: node
args:    ["<绝对路径>/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /绝对路径/到/你的/.nexplan   # 必填 —— 数据所在
  NEXPLAN_AGENT:  claude-code                   # 可选 —— 默认作者归属
```

> 如果你全局安装了 CLI，也可以把 command 指向包的可执行文件。无论哪种方式，都要设置
> `NEXPLAN_BOARD`，让每个 Agent 共享同一个看板。

## 给 Agent 命名

每个写工具都接受可选的 `author` 参数。把它设成你的 Agent 名，好让 git 历史和界面正确
归属变更：

```json
{ "items": [{ "title": "...", "type": "feature" }], "author": "claude-code" }
```

省略时使用 `NEXPLAN_AGENT`（或 `agent`）。

## 20 个工具

| 工具 | 用途 |
|---|---|
| `nexplan_backlog_add` | 把任务 / 分解子任务录入 backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | 读取 backlog（带过滤）|
| `nexplan_backlog_claim` | 认领：指派 + `in_progress` |
| `nexplan_backlog_complete` | 标记完成；可选自动关闭关联缺陷 |
| `nexplan_backlog_update` | 编辑任意字段（含状态）|
| `nexplan_backlog_decompose` | 把父项拆成子 backlog 项 |
| `nexplan_backlog_note` | 追加进度 / 上下文备注 |
| `nexplan_docs_list` / `nexplan_docs_get` | 读取设计 / 决策文档 |
| `nexplan_docs_create` | 记录设计 / 决策 / ADR 文档 |
| `nexplan_docs_update` | 更新文档 → 新版本 |
| `nexplan_docs_history` / `nexplan_docs_diff` | 版本历史 / 差异 |
| `nexplan_bug_add` | 上报自动发现的缺陷（附证据）|
| `nexplan_bug_list` / `nexplan_bug_get` / `nexplan_bug_update` | 跟踪缺陷 |
| `nexplan_status` | 看板汇总 + 近期活动 |
| `nexplan_agent_next` | 建议下一个要处理的事项 |

## 各 Agent 配置

- [Claude Code](agents/claude-code.zh-CN.md)
- [Codex / Codex CLI](agents/codex.zh-CN.md)
- [OpenCode](agents/opencode.zh-CN.md)
- [dsh（DeepSeek Harness）](agents/dsh.zh-CN.md)

不支持 MCP 的 Agent 仍可通过 `nexplan` CLI（shell 调用）驱动同一个看板。
推荐流程见 [WORKFLOW.md](WORKFLOW.md)。
