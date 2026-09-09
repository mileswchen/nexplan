# dsh (DeepSeek Harness) + NexPlan

dsh is a harness whose agents have their own tool set. The **most robust and portable
integration** is to drive NexPlan through the `nexplan` CLI from a shell (dsh agents
can run bash). If your dsh runtime can load MCP servers via stdio, you can use the
MCP server instead — the tool names and behaviors are identical.

## Option A — use the CLI from a shell (works everywhere)

Build once, then point the board at your project:

```bash
cd /abs/path/to/nexplan && npm install && npm run build
export NEXPLAN_BOARD="$PWD/.nexplan"
export NEXPLAN_AGENT="dsh"
```

Then a dsh agent can operate the board directly, for example:

```bash
# enter a decomposed task as backlog
nexplan add "实现 OAuth 回调" --type feature --priority P1 --assignee dsh

# pick up the next item, done, and publish a decision doc
nexplan claim WI-2 --assignee dsh
nexplan done WI-2 --note "完成并补测试"
nexplan docs new "oauth-flow" --type decision --body "# 决策\n\n使用 PKCE。"
nexplan bug add "刷新 token 过期" --severity major --evidence "ExpiredTokenError"
```

Give the agent the board path via `NEXPLAN_BOARD` so every session shares one board.

## Option B — MCP server

If your dsh setup supports registering an external MCP server over stdio, register:

```
command: node
args:    ["/abs/path/to/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /abs/path/to/your-project/.nexplan
  NEXPLAN_PROJECT: default
  NEXPLAN_AGENT:  dsh
```

The 27 `nexplan_*` tools then appear in dsh's tool list.

## Recommended habit for dsh

1. Enter the parent feature with `nexplan add`.
2. Decompose it with `nexplan decompose <id> --child …`.
3. `nexplan agent-next` (via CLI: `nexplan list --status backlog --priority P0`
   or a small wrapper) to find the next item.
4. Record design/decision docs with `nexplan docs new|update`.
5. Log any defect found during dev with `nexplan bug add`.
