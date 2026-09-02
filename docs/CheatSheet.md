# NexPlan — Command Cheat Sheet / 命令速查表

单页速查。任何命令加 `--json` 输出 JSON；`--root <path>` 覆盖工作区目录；
`--project <key>` 选择项目。
Add `--json` for JSON output; `--root <path>` overrides the workspace; `--project <key>` selects a project.

## 安装 / Install

```bash
npm install && npm run build      # compile → dist/
npm install -g .                  # put `nexplan` on PATH (or `npm link .`)
node dist/cli/index.js …          # run without installing
```

## 环境变量 / Environment

| 变量 | 默认 | 含义 |
|---|---|---|
| `NEXPLAN_BOARD` | `./.nexplan` | 工作区目录（所有 Agent 一致）|
| `NEXPLAN_PROJECT` | 工作区默认 | 活动项目 key |
| `NEXPLAN_AGENT` | `user`/`agent` | 默认作者 |
| `PORT` / `HOST` | `3344` / `127.0.0.1` | Web 绑定 |

## 快速开始 / Quick start

```bash
export NEXPLAN_BOARD="$PWD/.nexplan"
nexplan add "重构认证" --type refactor --priority P1 --manual   # 录入 backlog
nexplan list --status backlog                                    # 查看
nexplan claim WI-1 --assignee claude-code                        # 认领
nexplan done WI-1 --note "完成"                                  # 标记完成
nexplan project new api --name "API"                             # 新建项目
nexplan --project api add "订单接口" --priority P0               # 在 api 项目录入
nexplan user add claude-code --kind agent --role member          # 注册用户
nexplan web                                                      # 打开看板
```

## 工作项 / Work items

| 命令 | 说明 |
|---|---|
| `nexplan add "<t>" [--type t] [--priority P] [--description d] [--assignee n] [--tags a,b] [--estimate n] [--fixes-bug B1,B2] [--manual]` | 新增工作项 |
| `nexplan list [--status s] [--type t] [--priority p] [--assignee n] [--tags a,b] [--query q] [--limit n]` | 列出 |
| `nexplan get <id>` | 详情 |
| `nexplan claim <id> --assignee <n>` | 认领（→ in_progress）|
| `nexplan update <id> [--status s] [--title t] [--priority p] …` | 编辑 |
| `nexplan done <id> [--note n] [--no-close-bugs]` | 完成（→ done，自动关 bug）|
| `nexplan decompose <parentId> --child "<c>" …` | 拆分 |
| `nexplan note <id> <body>` | 加备注 |

## 缺陷 / Bugs

| 命令 | 说明 |
|---|---|
| `nexplan bug add "<t>" [--severity s] [--evidence e] [--tags a,b] [--manual]` | 录入缺陷 |
| `nexplan bug list [--status s] [--severity s] [--assignee n] [--query q]` | 列出 |
| `nexplan bug get <id>` | 详情 |
| `nexplan bug update <id> [--status s] [--severity s] [--assignee n] [--work-item id]` | 更新 |

## 文档 / Docs

| 命令 | 说明 |
|---|---|
| `nexplan docs list` | 列出 |
| `nexplan docs show <slug>` | 查看正文 |
| `nexplan docs new "<t>" [--type t] [--body d] [--status s] [--tags a,b]` | 新建（v1）|
| `nexplan docs update <slug> [--content c] [--status s] [--title t] …` | 更新（版本+1）|
| `nexplan docs history <slug>` | 版本历史 |
| `nexplan docs diff <slug> <shaA> <shaB>` | 对比两个版本 |

## 看板 / Board

```
nexplan status           # 汇总 + 近期活动
nexplan web [--port n]   # Web 看板（默认 3344）
```

## 项目与用户 / Projects & users

| 命令 | 说明 |
|---|---|
| `nexplan project list` / `new <key> [--name n] [--members a,b]` / `use <key>` / `show <key>` / `rm <key>` | 项目管理 |
| `nexplan user list` / `add <id> [--kind human\|agent] [--role r]` / `role <id> <admin\|member\|viewer>` / `rm <id>` | 用户与角色 |
| `nexplan config set-enforce-permissions <true\|false>` | 仅限已注册用户写入；`admin` 才能管理；`viewer` 只读 |
| `nexplan agent config <id> [--project key]` | 打印限定到 Agent+项目的 MCP 配置 |

**访问控制**：有 `members` 名单的项目仅限成员 + admin 访问；空名单=公开。严格模式开启后，
管理需 `admin` 角色。授权示例：`nexplan user add alice --role member; nexplan project new api --members alice; nexplan agent config alice --project api`。

## MCP（给 Agent）/ For agents

```
command: node
args:    ["/abs/path/nexplan/dist/mcp/server.js"]
env:     { NEXPLAN_BOARD: "...", NEXPLAN_PROJECT: "<key>", NEXPLAN_AGENT: "<agent>" }
```

26 个 `nexplan_*` 工具：`backlog_add/list/get/claim/update/complete/decompose/note`、
`docs_list/get/create/update/history/diff`、`bug_add/list/get/update`、`status`、`agent_next`、
`project_list/create/set_default`、`user_list/add/update`。多数工具接受可选 `project` 与 `author` 参数。

## 状态枚举 / Enums

- 工作项：`backlog todo in_progress review done blocked`
- 类型：`task feature refactor chore research bug docs`
- 优先级：`P0 P1 P2 P3`
- 缺陷级别：`critical major minor trivial`
- 缺陷状态：`open in_progress fixed verified wontfix reopened`
- 文档类型：`design decision adr architecture notes`
- 文档状态：`draft review approved superseded`
