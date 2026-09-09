# NexPlan — 使用指南（简体中文）

NexPlan 是一个**基于 git 的项目管理中枢**，面向编码 Agent 与人类。它让工作流中的
每一个工具 —— **dsh、Claude Code、Codex、OpenCode** 以及其它支持 MCP 的 Agent ——
共享同一条 **backlog（待办）**、同一个 **缺陷跟踪**、同一套 **带版本管理的文档**。

因为所有数据都是 git 仓库里的普通文件，所以审计日志、diff、冲突安全的并行协作，
以及真正的文档版本历史，全部免费获得。

---

## 1. NexPlan 能做什么

| 领域 | 能力 |
|---|---|
| **backlog / 工作项** | 手动记录任务，或让 Agent 录入分解后的子任务；认领一条 item；标记完成（状态自动更新）。 |
| **缺陷** | 手动录入 bug，或让 Agent 记录它自动发现的 bug（附证据）。完成关联的工作项时自动关闭该 bug。 |
| **文档** | 存储设计 / 决策 / ADR 文档，具备**版本管理**。Agent 可创建和更新；每次更新都是一个新的 git 版本。 |

它通过**三种接口**暴露，全部共享同一套存储：

1. **CLI** —— `nexplan …`（人类、脚本）。
2. **MCP server** —— `node dist/mcp/server.js`（Agent；28 个 `nexplan_*` 工具）。
3. **Web 看板** —— `nexplan web`（人类；看板、缺陷、文档查看/历史、项目与用户管理后台）。
   人类用户用密码登录；未登录访客只能**读**公开项目。

---

## 2. 环境要求与安装

- **Node.js ≥ 20**（在 Node 24 上验证）
- **git**（审计 / 版本层）
- **npm**

```bash
cd nexplan
npm install
npm run build          # 编译 TypeScript → dist/

# 让 `nexplan` 命令在 PATH 上可用（全局安装）：
npm install -g .       # 或使用：npm link .

# 或不安装，直接运行：
node dist/cli/index.js status
```

---

## 3. 工作区：你的数据放在哪里

**工作区**是一个目录（一个 git 仓库），存放一个或多个**项目**。默认是当前工作目录下的
`./.nexplan`；设置 `NEXPLAN_BOARD` 可改变位置。每个项目有自己的 backlog、缺陷与文档。

```
<workspace>/
  workspace.json        默认项目、项目列表、权限开关
  users/<id>.json       用户注册表
  projects/<key>/
    project.json        项目元信息（名称、描述、成员）
    workitems/          WI-*.json      待办任务
    bugs/               BUG-*.json     缺陷
    docs/               <slug>.md      文档（markdown + frontmatter）
```

每次变更都会执行 `git add` + `git commit`（限定在项目子树内），所以 `git log` 就是
完整的活动日志，文档也获得真正的版本历史。

### 状态、类型与优先级

- **工作项类型**：`task`、`feature`、`refactor`、`chore`、`research`、`bug`、`docs`
- **工作项状态**：`backlog` → `todo` → `in_progress` → `review` → `done`（另有 `blocked`）
- **优先级**：`P0` … `P3`（P0 最高）
- **缺陷级别**：`critical`、`major`、`minor`、`trivial`
- **缺陷状态**：`open` → `in_progress` → `fixed` → `verified`（另有 `wontfix`、`reopened`）
- **文档类型**：`design`、`decision`、`adr`、`architecture`、`notes`
- **文档状态**：`draft`、`review`、`approved`、`superseded`

---

## 4. 快速开始

```bash
cd /path/to/your/project
export NEXPLAN_BOARD="$PWD/.nexplan"

# 手动录入 backlog
nexplan add "重构认证模块" --type refactor --priority P1 --tags auth,security --manual

# 查看看板
nexplan list --status backlog
nexplan status

# 认领一条 item
nexplan claim WI-1 --assignee claude-code

# 标记完成（状态 → done）
nexplan done WI-1 --note "已实现并补测试"

# 打开 Web 看板
nexplan web
```

---

## 5. CLI 参考

任何命令都可加 `--json` 输出结构化 JSON。`--root <path>` 可覆盖本次命令使用的看板目录。

### 工作项（backlog）

| 命令 | 说明 |
|---|---|
| `nexplan add "<标题>" [选项]` | 新增一个工作项。`--type`、`--priority`、`--description`、`--assignee`、`--tags a,b`、`--estimate n`、`--fixes-bug BUG-1,BUG-2`、`--doc-link url`、`--manual`、`--json-input`（从 stdin 读 JSON 数组批量新增）。 |
| `nexplan list` / `ls` | 列出工作项。`--status`、`--type`、`--priority`、`--assignee`、`--tags`、`--query`、`--limit`。 |
| `nexplan get <id>` | 单条完整详情（含备注、子项、关联）。 |
| `nexplan claim <id> --assignee <名字>` | 认领：设置 `assignee` 并把状态置为 `in_progress`。可选 `--status`。 |
| `nexplan update <id> [选项]` | 编辑字段：`--title`、`--description`、`--type`、`--priority`、`--status`、`--assignee`、`--tags`、`--estimate`、`--doc-link url`（留空清除）。 |
| `nexplan done <id> [选项]`（`complete`） | 标记完成；`--note`、`--no-close-bugs`。自动关闭 `fixesBug` 中的缺陷。 |
| `nexplan decompose <父ID> --child "<标题>" …` | 把父项拆分成子 backlog 项（与父项关联）。 |
| `nexplan note <id> <内容>` | 追加进度 / 上下文备注。 |
| `nexplan rm <id>`（`delete`） | 删除工作项。仅创建者或管理员可删除。 |

#### 示例

```bash
nexplan add "实现下单接口" --type feature --priority P0
nexplan decompose WI-2 --child "订单表结构" --child "下单 API"
nexplan claim WI-3 --assignee opencode
nexplan done WI-3 --note "完成并验证"
```

### 缺陷

| 命令 | 说明 |
|---|---|
| `nexplan bug add "<标题>" [选项]` | 记录缺陷：`--description`、`--severity`、`--evidence`（堆栈/日志）、`--tags`、`--manual`。 |
| `nexplan bug list` | 列出缺陷：`--status`、`--severity`、`--assignee`、`--query`、`--limit`。 |
| `nexplan bug get <id>` | 缺陷完整详情。 |
| `nexplan bug update <id> [选项]` | `--status`、`--severity`、`--assignee`、`--work-item`。 |

```bash
nexplan bug add "登录接口偶发 500" --severity major --evidence "500: internal error"
nexplan bug update BUG-1 --status in_progress --assignee codex
```

### 文档

| 命令 | 说明 |
|---|---|
| `nexplan docs list` / `ls` | 列出文档（slug、版本、状态、类型、标题）。 |
| `nexplan docs show <slug>` | 打印 markdown 正文。 |
| `nexplan docs new <标题> [选项]` | 创建：`--type`、`--body`、`--status`、`--tags`、`--slug`。版本从 1 开始。 |
| `nexplan docs update <slug> [选项]` | 更新：`--content`、`--title`、`--type`、`--status`、`--tags`。**版本号递增**并产生一次 git 提交。 |
| `nexplan docs history <slug>` | 显示版本历史（新的在前）。 |
| `nexplan docs diff <slug> <shaA> <shaB>` | 对比两个版本（sha 来自 `history`）。 |
| `nexplan docs comment <slug> <内容>` | 给文档加评论（仅项目成员 / 管理员）。 |

```bash
nexplan docs new "下单设计" --type design --body "# 设计\n\n走队列"
nexplan docs update "下单设计" --content "# 设计\n\n改同步" --status approved
nexplan docs history "下单设计"
```

### 看板

| 命令 | 说明 |
|---|---|
| `nexplan status` | 按状态汇总 + 近期活动。 |
| `nexplan web [--port n] [--host h \| --remote]` | 启动 Web 看板（默认端口 3344）。默认只监听 `127.0.0.1`；加 `--remote`（或 `--host 0.0.0.0`）可让**局域网其他机器**访问——启动时会打印可达的 LAN 地址。 |

### 多项目

任意看板命令可通过 `--project <key>`（或 `NEXPLAN_PROJECT`）选择活动项目；默认取工作区默认项目。

| 命令 | 说明 |
|---|---|
| `nexplan project list` | 列出项目。 |
| `nexplan project new <key> [--name n] [--description d] [--members a,b]` | 创建项目。 |
| `nexplan project use <key>` | 设置为默认项目。 |
| `nexplan project show <key>` | 显示项目详情。 |
| `nexplan project rm <key>` | 删除项目（不能删默认项目）。 |

### 多用户

| 命令 | 说明 |
|---|---|
| `nexplan user list` | 列出用户。 |
| `nexplan user add <id> [--name n] [--kind human\|agent] [--role admin\|member\|viewer] [--password pw]` | 注册用户。`--password` 给人类用户一个 Web 登录密码（Agent 按 id 鉴权，不需要密码）。 |
| `nexplan user role <id> <admin\|member\|viewer>` | 改角色。 |
| `nexplan user password <id> [<pw>]` | 设置 / 重置人类用户的 Web 登录密码。 |
| `nexplan user rm <id>` | 删除用户。 |
| `nexplan config set-enforce-permissions <true\|false>` | 开启后仅限已注册用户写入；`viewer` 只读。 |

角色：`admin`（全部）、`member`（可写工作项/缺陷/文档）、`viewer`（只读）。
开启**权限校验**后，写入需要已注册的非 `viewer` 用户。

```bash
nexplan project new backend --name "后端" --description "服务端"
nexplan --project backend add "实现下单 API" --priority P0
nexplan user add alice --kind human --role admin --password s3cret   # 人类用户 → Web 登录
nexplan user add claude-code --kind agent --role member              # Agent → MCP/CLI，无密码
nexplan user password alice new-s3cret                               # 重置密码
nexplan user list
```

### 访问控制与 Agent 配置广播

访问控制分三层：

1. **项目成员名单（始终生效）** —— 列出了 `members` 的项目仅限成员 + admin 访问（读写都算）；
   名单为空 = 公开。
2. **严格模式**（`nexplan config set-enforce-permissions true`）—— 额外要求已注册用户，
   并让 `admin` 成为唯一能管理工作区的角色；`viewer` 只读。

   每个工作区在初始化时都会自动引导出一个默认 **`admin`** 用户（开启严格模式时若缺失也会
   补建），所以开启严格模式永远不会把自己锁在管理工作区之外——始终有一个 `admin` 可用。
3. **Web 登录（人类用户）** —— Web 看板用密码认证人类。默认 `admin` 的初始密码是
   `admin`，首次登录会被强制改密。匿名请求可以**读**公开项目，但写入与管理必须先
   **登录**。Agent 用户没有密码——仍按 id + 项目成员鉴权（CLI/MCP 不变）。

把 Agent 限定到某个项目并生成它的 MCP 配置：

```bash
nexplan user add claude-code --kind agent --role member
nexplan project new backend --members claude-code
nexplan agent config claude-code --project backend   # 打印 MCP 配置 + 权限说明
```

`agent config` 会输出一段可直接粘贴的 MCP 配置（带 `NEXPLAN_PROJECT` + `NEXPLAN_AGENT`），
让每个 Agent 都被正确限定与归属。授权方式：把该 Agent 加入项目成员，或授予 `admin` 角色。

---

## 6. MCP server（给 Coding Agent 用）

MCP server 把与 CLI 相同的能力暴露给**任何支持 MCP 的 Agent**
（Claude Code、Codex、OpenCode、dsh）。这是 Agent 接入的推荐方式。

### 运行它

```
command: node
args:    ["/abs/path/to/nexplan/dist/mcp/server.js"]
env:
  NEXPLAN_BOARD:  /abs/path/to/your/.nexplan   # 必填 —— 要使用的看板
  NEXPLAN_AGENT:  claude-code                   # 可选 —— 默认作者
```

各 Agent 配置示例见 [`docs/agents/`](agents/)（claude-code、codex、opencode、dsh）。
跨 Agent 概览见 [`docs/AGENTS.md`](AGENTS.md)。

> 如果某个 Agent 无法加载 MCP server，它也可以直接 shell 调用 `nexplan` CLI（第 5 节）。

### 28 个工具

多数工具都接受可选的 `project` 参数（默认取 `$NEXPLAN_PROJECT` 或工作区默认项目）。

| 工具 | 用途 |
|---|---|
| `nexplan_backlog_add` | 把任务 / 分解子任务录入 backlog |
| `nexplan_backlog_list` / `nexplan_backlog_get` | 读取 backlog（列表 / 单条） |
| `nexplan_backlog_claim` | 认领一条 item：指派 + `in_progress` |
| `nexplan_backlog_complete` | 标记完成；可选自动关闭关联缺陷 |
| `nexplan_backlog_update` | 编辑任意字段（含状态） |
| `nexplan_backlog_decompose` | 把父项拆成子 backlog 项 |
| `nexplan_backlog_note` | 追加进度 / 上下文备注 |
| `nexplan_backlog_delete` | 删除条目（仅创建者或管理员） |
| `nexplan_docs_list` / `nexplan_docs_get` | 读取设计 / 决策文档 |
| `nexplan_docs_create` | 记录设计 / 决策 / ADR 文档 |
| `nexplan_docs_update` | 更新文档 → 新版本 |
| `nexplan_docs_history` / `nexplan_docs_diff` | 版本历史 / diff |
| `nexplan_docs_comment` | 评论文档（仅项目成员 / 管理员）|
| `nexplan_bug_add` | 上报自动发现的缺陷（附证据） |
| `nexplan_bug_list` / `nexplan_bug_get` / `nexplan_bug_update` | 跟踪缺陷 |
| `nexplan_status` | 看板汇总 + 近期活动 |
| `nexplan_agent_next` | 建议下一个要处理的事项 |
| `nexplan_project_list` / `nexplan_project_create` / `nexplan_project_set_default` | 项目管理 |
| `nexplan_user_list` / `nexplan_user_add` / `nexplan_user_update` | 用户与角色管理 |

每个写工具都接受一个 **`author`** 参数，涉及项目时还接受 **`project`** 参数。设置
`author` 为你的 Agent 名，便于 git 历史和看板正确归属；省略时用 `NEXPLAN_AGENT`
（或 `agent`），省略项目时用 `NEXPLAN_PROJECT`（或默认）。

```jsonc
// 示例工具调用：在 api 项目录入一个分解子任务
{ "items": [{ "title": "订单表结构", "type": "task", "priority": "P0" }], "author": "claude-code", "project": "api" }
```

---

## 7. Web 看板

运行 `nexplan web`，然后打开 `http://127.0.0.1:3344`。默认只监听 `127.0.0.1`——
运行 `nexplan web --remote`（或 `--host 0.0.0.0`）可让局域网其他机器访问，启动时会打印
LAN 地址（对外暴露前请先改掉默认 `admin` 密码！）。界面**中英双语**——用右上角的
语言切换器（**English / 中文**）切换；选择会被记住，首次访问按浏览器语言自动检测。

人类用户通过右上角 **登录** 按钮登录（ID + 密码）。每个工作区都保证有一个默认的
**`admin`** 用户，初始密码是 `admin`，首次登录会被**强制修改密码**（登录后立刻弹出
“修改密码”对话框）。登录后顶栏会显示 `名字（角色）` 和 **退出** 按钮。匿名访客只能
**读**公开项目，所有写入与管理操作都需要登录——API 出错会以 toast 提示。

它有如下标签页：

- **待办板** —— 按状态分列的看板（`待办 / 待开始 / 进行中 / 评审中 / 完成 / 阻塞`）。点卡片进入
  详情：查看描述、备注，改状态，**开始 / 认领**、**标记完成**、添加备注。用搜索框、优先级和
  负责人筛选，或点 **+ 新建待办** 手动新增。
- **缺陷** —— 可搜索的缺陷列表，带级别 / 状态徽标；**+ 录入缺陷** 上报；行内“标记已修”；
  点击某项可编辑级别 / 状态。
- **文档** —— 左侧文档列表；选中后在右侧查看正文（支持 **Markdown 渲染**：标题、列表、表格、
  代码块、图片、链接…以及 **Mermaid** ` ```mermaid ` 架构图，浏览器内实时渲染）、元信息与
  **版本历史**，底部还有**评论**线程（项目成员/管理员可评论）。**编辑（生成新版本）** 打开带实时
  预览的内联编辑器；**新建文档** 创建文档。
- **管理** —— 项目统计与项目管理（见下）。

顶部栏的**项目切换器**可切换活动项目。**管理**标签页新增**项目统计**面板（各项目的
待办/缺陷/文档数量，点卡片直接进入），以及项目与用户管理（新建/删除项目、设默认、改角色、
加用户——加用户表单里有给人类用户填的“密码（可选）”字段、严格权限开关）。

看板每 15 秒自动刷新，并在每次操作后刷新。Web 登录会话有效期为 7 天
（签名 `nexplan_session` cookie）。

---

## 8. 推荐的 Agent 工作流

1. **了解全局** —— `nexplan_status`、`nexplan_backlog_list`、`nexplan_agent_next`。
2. **认领** —— 开始前先 `nexplan_backlog_claim`；如果任务较大先拆分
   （`nexplan_backlog_decompose`）。
3. **记录文档** —— 把 *为什么* 记进带版本的文档（`nexplan_docs_create` / `update`）。
4. **上报缺陷** —— 开发中遇到的问题都走 `nexplan_bug_add`（带 `evidence`），并用
   `fixesBug` 关联修复它的工作项。
5. **收尾** —— `nexplan_backlog_complete`（置 `done`、记备注、自动关闭关联缺陷）。

完整流程见 [`docs/WORKFLOW.md`](WORKFLOW.md)。

---

## 9. Git 与版本管理

- 每次变更都会提交，所以看板目录里的 `git log` 就是你的审计日志。
- 文档在 frontmatter 中带 `version` 计数；`docs history` 与 `docs diff` 直接读取 git，
  因此总能回答“之前的设计长什么样？”。

```bash
git -C "$NEXPLAN_BOARD" log --oneline     # 完整活动日志
nexplan docs history "下单设计"            # 单篇文档的版本列表
```

---

## 10. 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `NEXPLAN_BOARD` | `./.nexplan` | 工作区（数据）目录。请在所有 Agent 配置里设为同一路径，让它们共享一个工作区。 |
| `NEXPLAN_PROJECT` | 工作区默认 | 看板操作的活动项目 key。 |
| `NEXPLAN_AGENT` | `user`（CLI）/ `agent`（MCP） | 写入时的默认作者归属。 |
| `PORT` / `HOST` | `3344` / `127.0.0.1` | Web 看板的绑定地址。 |

CLI / JSON：`--root <path>`、`--project <key>` 与 `--json` 只改变单次调用的行为。

Web 登录会话有效期 7 天；签名 cookie 用的密钥在首次启动时生成到
`<board>/.web-secret` —— 不要把它提交进版本库。

---

## 11. 问题排查 / FAQ

**「`nexplan: command not found`」** —— CLI 不在 PATH 上。运行 `npm install -g .`
（或 `node dist/cli/index.js …`）。见 [2. 环境要求与安装](#2-环境要求与安装)。

**MCP server 启动即报错退出** —— 看板目录不可写，或缺少 git。检查 `NEXPLAN_BOARD` 是否指向
可写路径。

**我改了文档但版本没变** —— `docs update` 才会递增版本并提交；`docs new` 从版本 1 开始。

**我在 Web 看板里无法新增或编辑** —— 你没有登录。匿名访客只能读公开项目，所有写入与
管理操作都需要先登录（右上角 **登录**）。

**admin 的密码是什么？** —— 每个工作区都保证有一个默认 `admin` 用户，初始密码 `admin`，
首次登录强制改密。随时可用 `nexplan user password admin <新密码>` 重置。

**怎么给人类用户设置 Web 登录密码？** —— `nexplan user add <id> --kind human
--password <pw>`（或之后 `nexplan user password <id> <pw>`）。Agent 用户永远不需要密码——
按 id + 项目成员鉴权。

**不同 Agent 看到的不是同一个看板** —— 请确保每个 Agent 配置里的 `NEXPLAN_BOARD` 一致。

**item / bug / 文档去哪了** —— 一切都是 `<board>/` 下的文件；若 git 处于活动状态，可用
`git -C "$NEXPLAN_BOARD" checkout …` 回滚。
