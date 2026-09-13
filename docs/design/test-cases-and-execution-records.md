# 设计方案：测试用例（TestCase）与测试执行记录（TestRun）

> 状态：**待评审（Draft for review）** — 尚未编写任何实现代码。
> 目标版本：`0.3.0 → 0.4.0`（纯增量，向后兼容）。
> 评审重点：第 12 节「开放问题 / 待拍板决策」。

---

## 0. 摘要（TL;DR）

在现有 `workitems / bugs / docs` 三类数据之外，新增两个一等实体：

| 实体 | 文件 | 语义 |
|---|---|---|
| **TestCase 测试用例** `TC-N` | `testcases/TC-N.json` | 可复用的测试意图：前置条件、步骤+期望、类型、优先级、关联工作项/缺陷、自动化定位 |
| **TestRun 测试执行记录** `TR-N` | `testruns/TR-N.json` | 一次执行的**不可变快照**：结果、实际结果、证据、环境、构建、批次、执行人、耗时 |

**存储后端：文件是唯一事实源（JSON / Markdown + git），不引入数据库** —— workitem、bug、用例、执行记录、文档、用户、项目配置一律是 git 仓库里的明文文件，每次写入即一次 commit。执行记录采用**「热数据一执行一文件 + 冷数据按月归档」**解决无界增长（归档完整规格：**§13**；为什么不用 SQLite 的实测依据：**§3.6**）。

由此形成 PM 闭环（也是本方案的核心价值）：

```
工作项 WI ──(被测/被验证)──> 测试用例 TC ──(每次执行)──> 执行记录 TR ──(失败)──> 缺陷 BUG ──(通过)──> fixed / verified
```

三端同时提供：**CLI**、**MCP（8 个新工具，28 → 36）**、**Web（新增 Tests 标签页）**，全部沿用同一 `Store` 与 git 审计层，零破坏性改动。

---

## 1. 问题与目标

### 1.1 现状

- 工作项的 `done` 只是一次状态翻转，**没有任何验证证据**可追溯。
- 缺陷 `fixed → verified` 全靠人工记忆；回归是否真的跑过、跑的哪个构建，无从查证。
- Agent 跑完 `vitest / pytest / playwright` 的结果无处置放，只能塞进 `note` 文本里，**无法统计、无法回归对比**。
- 缺少覆盖率视角：某个工作项到底有没有用例、用例最近一次是过还是挂，看板上看不见。

### 1.2 目标（可验证）

| 编号 | 目标 |
|---|---|
| G1 | 用例可独立增删改查，可关联 WI/BUG，按项目隔离，复用现有三道权限门 |
| G2 | 执行记录可写入、**不可篡改**（历史快照），可按用例/批次/构建/结果/工作项查询 |
| G3 | 失败可（可选自动）转缺陷，并与既有 bug 生命周期（`fixed`/`verified`/`reopened`）打通 |
| G4 | 工作项完成时可看到验证摘要；可选开启「用例门禁」 |
| G5 | 报告：批次/构建/工作项维度的通过率、未执行清单、失败清单、flaky 用例 |
| G6 | CLI / MCP / Web 三端齐备，全部写入 git 审计历史 |

### 1.3 非目标（明确不做）

- ❌ **不自己执行测试**（不内嵌 vitest/playwright runner）——只做「记录 + 追溯」。
- ❌ 不做测试环境管理、设备农场、并发调度、CI 编排。
- ❌ 不做二进制附件存储（截图/视频只存路径或 URL 字符串）。
- ❌ 不做完整 TMS 能力：评审流、测试计划/里程碑、跨项目共享用例库、测试集（Test Suite）实体。
- ❌ 不修改现有 workitem/bug/doc 既有字段语义（只做**新增可选字段**）。
- ❌ 不引入新的运行时依赖（P0 阶段）。

---

## 2. 领域模型

### 2.1 状态机

```
TestCase.status : draft ──> active ──> deprecated
                 （draft 不参与门禁；deprecated 保留历史、不再计入 notRun）

TestRun.result  : pass | fail | blocked | skipped      （写入后不可变）

Bug 生命周期    : 沿用现有 open → fixed → verified / wontfix / reopened（不变）
```

### 2.2 关系图

```
WI-1 ──workItem──> TC-3 ──caseId──> TR-7 ──bugIds──> BUG-9
                    │                                  ▲
                    └──────────── bugs[]（守护的缺陷）──┘
```

- `TestCase.workItem`：该用例**验证/守护**的工作项（可为空 = 通用回归用例）。
- `TestCase.bugs`：该用例守护的缺陷（回归用例）。
- `TestRun.caseId`：指向用例；同时快照 `caseTitle`/`workItem`，保证用例后续被改名/删除后，历史仍可读。
- `TestRun.bugIds`：本次执行创建或关联的缺陷。

### 2.3 类型草案（`src/core/types.ts` 增量）

```ts
export type TestCaseType =
  | 'functional' | 'regression' | 'integration' | 'e2e'
  | 'performance' | 'security' | 'usability' | 'other';

export type TestCaseStatus = 'draft' | 'active' | 'deprecated';
export type TestResult = 'pass' | 'fail' | 'blocked' | 'skipped';

export interface TestStep {
  action: string;    // 操作步骤
  expected: string;  // 期望结果
}

export interface TestCase {
  id: string;                 // TC-N（项目内自增）
  title: string;
  description: string;        // 测试目的/范围
  type: TestCaseType;         // 默认 functional
  priority: Priority;         // 复用 P0..P3，默认 P2
  status: TestCaseStatus;     // 默认 draft
  preconditions: string;      // 前置条件
  steps: TestStep[];          // 步骤表
  tags: string[];
  workItem: string | null;    // 关联工作项 WI-N
  bugs: string[];             // 守护/覆盖的缺陷 BUG-N
  automated: boolean;         // 是否已自动化
  testFile: string | null;    // 自动化定位，如 "test/store.test.ts::claims an item"
  createdBy: string; createdAt: string; updatedAt: string;
  notes: Note[];              // 复用现有 Note
}

export interface TestRun {
  id: string;                 // TR-N
  caseId: string;             // TC-N
  // ---- 快照字段（写入即冻结，用例后续改动不影响历史）----
  caseTitle: string;
  workItem: string | null;
  // ---- 结果 ----
  result: TestResult;
  actual: string;             // 实际结果
  evidence: string;           // 日志 / 堆栈 / 报错 / 产物路径
  environment: string;        // local | staging | ci | 自定义
  build: string;              // 版本 / commit / 构建号
  batch: string;              // 批次标签，如 "v0.4.0 回归"
  durationMs: number | null;
  bugIds: string[];           // 本次执行产生/关联的缺陷
  executedBy: string;
  executedAt: string;
  notes: Note[];
}
```

### 2.4 筛选与报告类型

```ts
export interface TestCaseFilter {
  status?: TestCaseStatus | TestCaseStatus[];
  type?: TestCaseType | TestCaseType[];
  priority?: Priority | Priority[];
  workItem?: string;          // 按工作项筛选覆盖
  bugs?: string;
  tags?: string[];
  automated?: boolean;
  lastResult?: TestResult;    // 按「最近一次结果」筛选（含 notRun）
  query?: string;
  limit?: number;
}

export interface TestRunFilter {
  caseId?: string;
  result?: TestResult | TestResult[];
  build?: string;
  batch?: string;
  environment?: string;
  workItem?: string;
  executedBy?: string;
  since?: string;             // ISO
  until?: string;             // ISO
  limit?: number;
}

export interface TestReport {
  scope: { project: string; batch?: string; build?: string; workItem?: string };
  totals: {
    cases: number;        // scope 内用例数
    runs: number;         // scope 内执行次数
    pass: number; fail: number; blocked: number; skipped: number;
    notRun: number;       // scope 内 active 且无执行记录的用例数
  };
  passRate: number;       // pass / (pass+fail) ，保留 1 位小数；无执行时为 null
  coverage: {
    itemsTotal: number;             // 项目内工作项数
    itemsWithCases: number;         // 至少有一条用例的工作项数
    itemsWithoutCases: string[];    // 无用例的工作项 id（截断 20 条 + 计数）
  };
  failures: Array<{ caseId: string; title: string; runId: string; build: string; executedAt: string }>;
  notRunCases: Array<{ caseId: string; title: string }>;
  flaky: Array<{ caseId: string; title: string; pass: number; fail: number }>;
}
```

---

## 3. 存储设计

### 3.1 目录布局（每个项目独立）

```
<workspace>/projects/<key>/
  project.json
  .counters.json               ← 新增：id 计数器（P0，见 §13.6）
  workitems/  WI-N.json
  bugs/       BUG-N.json
  docs/       <slug>.md
  testcases/  TC-N.json        ← 新增
  testruns/   TR-N.json        ← 新增：热数据，一次执行一个文件
    archive/                   ← 新增（P1）：冷数据月包
      2025-07.jsonl            ← 一行一条完整 TestRun JSON（§13.5）
      index.json               ← 可选派生索引（纯文本、可删可重建）
```

- 采用与 `workitems/`、`bugs/` 完全一致的「一实体一 JSON 文件」模式，复用现有 `nextId(prefix)`（正则 `/^(\w+)-(\d+)\.json$/` 天然支持 `TC` / `TR`）。
- 每个项目自增独立（与 WI/BUG 一致）；`nextId` 改为**优先读 `.counters.json`**（§13.6）。
- 需同步更新：`Store.init()` 的 `mkdir`、`Store.dirs`、`Workspace.migrateLegacy()` 的 legacy 目录列表、`Workspace.rootHasBoard()`。

> **存储后端：纯文件 + git（不引入数据库）**，与现有 5 类数据完全一致；执行记录用**归档**（热数据一文件 + 冷数据月包）解决无界增长。理由见 §3.6，归档规格见 §13。

### 3.2 为什么执行记录单独一个文件、而不是内嵌在用例里

| 方案 | 评价 |
|---|---|
| A. 执行记录内嵌 `TestCase.runs: []` | ❌ 文件无限膨胀；每次跑测试都重写整个用例；git diff 噪音极大；并行冲突 |
| B. 全部塞进 `notes` 文本 | ❌ 无法统计、无法查询，等于没做 |
| C. **`testruns/TR-N.json` 一执行一文件（采用）** | ✅ git 历史天然成为执行审计流；并发安全（mutex 串行）；热路径可按 id 早退读取（§3.3）；与现有模式一致。无界增长交给**归档**（§13） |
| D. 所有执行追加进单个大 JSONL | ❌ 每次 commit 都把整个文件存成新 blob（第 N 次为 O(N)，累计 O(N²)）。但**冻结的月包**没有这个问题 → 所以是「热数据小文件 + 冷数据月包」而非「一个文件到底」（§3.6 反面结论、§13.5） |

### 3.3 派生数据不落盘 + 热路径早退读取

- 用例的「最近一次结果」「执行次数」**不写入用例文件**：`listTestCases()` 按**热目录 id 倒序早退**读取（读到所有用例都有结果即停），必要时再补最新月包 —— 成本 O(用例数)，与执行记录总量无关（实测 2 万条下 3.4ms）。
- 「最新 N 条执行记录」同理按 id 倒序早退读取，只打开 N 个文件（实测 2.5ms，见 §3.6）。
- 好处：无缓存漂移、写入更少、git 更干净、没有「重算」逻辑，而且**列表与活动流不随历史量变慢**。
- 冷数据（已归档）由月包承担；`testruns/archive/index.json` 是**可选、可删、可重建**的纯文本索引，只用于把跨月查询收窄到相关月包（§13.5）。它进 git，所以不存在「派生物与事实源不一致」的风险面。

### 3.4 git 提交信息约定

```
testcase: create TC-1 <标题>
testcase: update TC-1 (author)
testcase: delete TC-1
test: run TR-7 TC-1 pass (agent)
test: run TR-8 TC-1 fail (agent) +BUG-9
```

`Store.recentActivity()` 需要：
- 新增 kind 判定 `testcase:` → `'testcase'`、`test:` → `'testrun'`（注意 `testcase:` 前缀判定要放在 `test:` 之前做显式区分，二者字符串不冲突）；
- id 正则从 `/(?:WI|BUG)-\d+/` 扩展为 `/(?:WI|BUG|TC|TR)-\d+/`；
- `BoardActivity.kind` 联合类型扩展 `'testcase' | 'testrun'`。

### 3.5 对 `Bug` 的新增可选字段（向后兼容）

```ts
export interface Bug {
  // ...现有字段不变
  testCase?: string | null;  // 由哪条用例发现
  testRun?: string | null;   // 由哪次执行发现
}
```

缺失即 `undefined`，旧数据零迁移；用于 Web 缺陷详情展示「来源：TC-3 / TR-7」与反向跳转。

### 3.6 存储后端：为什么是纯文件 + 归档（而非 SQLite）

现状实测（本仓库工作区 `.nexplan/`）：**全部数据是纯文件，全项目零数据库依赖**
（`dependencies` 仅 `@modelcontextprotocol/sdk` / `commander` / `express` / `zod`）。

| 数据 | 实际存储位置 | 格式 |
|---|---|---|
| 工作项 | `projects/<key>/workitems/WI-N.json` | JSON（一实体一文件） |
| 缺陷 | `projects/<key>/bugs/BUG-N.json` | JSON |
| 文档 | `projects/<key>/docs/<slug>.md`（+ `<slug>.comments.json`） | Markdown + frontmatter |
| **测试用例（本方案）** | `projects/<key>/testcases/TC-N.json` | JSON |
| **执行记录（本方案）** | `projects/<key>/testruns/TR-N.json` | JSON |
| 项目/用户/工作区配置 | `project.json` / `users/<id>.json` / `workspace.json` | JSON |

每次写入都是 `fs.writeFile` + `git add` + `git commit`（`Store.tx()` → `Store.commit()`），
文档历史/差异直接来自 `git log` / `git show` / `git diff`（`docHistory` / `docDiff`），
看板动态来自 `git log`。文件制是 NexPlan 的**产品定位本身**，不是实现偶然。

**维持文件制的理由**

1. **审计与版本化免费获得** —— 每次变更 = 一次可读 commit；`git log`/`git blame`/`git diff` 即活动流；SQLite 需要自建 `events` 表才能勉强等价，且不能 `git diff`。
2. **人类与 Agent 都能直读** —— Agent 用 `cat`/`grep` 就能看数据，无需跑服务、无需 SQL；离线可用、可手改、可脚本化。
3. **无 schema 迁移负担** —— 新增字段（如本方案给 `Bug` 加的 `testCase`）对旧数据天然兼容；SQLite 要写 migration。
4. **冲突语义清晰** —— 一实体一文件，不同实体并行修改几乎不冲突，人工合并可读。
5. **零依赖、零运维** —— 不引入 native 依赖（`better-sqlite3` 需编译）、无文件锁/WAL 调优、无 `node:sqlite` 版本约束（Node ≥ 20 才有早期形态）。

**文件制的真实代价（必须承认）**

| 代价 | 现状 | 本方案的影响 |
|---|---|---|
| 列表 = 全目录扫描 + 逐个 `JSON.parse` | `listWorkItems()` 已如此（约 1–3k 文件量级仍 <50ms 级） | 报告要扫 `testruns/`；**执行记录是唯一无界增长的数据**（每次执行 +1 文件） |
| 跨进程无锁 | `Mutex` 只在**进程内**（每个 `Store` 实例一个）；Web 服务 + MCP 服务 + CLI 同时写，可能撞 `index.lock` → commit 失败被 `console.warn` 吞掉（数据已写入，只是那一次没形成 commit） | 执行记录写入频繁，会放大该现象 |
| 无跨文件事务 | `tx()` 只保证「进程内串行 + 写后提交」 | 「记录执行 + 自动开单 + 推进缺陷」跨 3 个文件，中途失败会留下部分状态（可接受：都是加性写入，不会损坏） |
| 无索引查询 | 过滤在内存（`applyFilter`） | flaky / 通过率需全量读 `testruns/` |

**决策（已拍板）：维持 A（纯文件 + git），用「归档」解决无界增长，不引入 SQLite**

实测数据（本机 APFS / Node 24，单条记录约 600B 的 JSON；单次运行结果，仅作量级参考）：

| 执行记录数 | `readdir` | 全量扫描（读 + parse 全部） | 按 id **早退**取最新 20 条 | 取 50 个用例的最新结果 | `git add -A`+commit（增量） |
|---|---|---|---|---|---|
| 1 000 | 0.7ms | 46ms | 1.1ms | 2.5ms | 35ms |
| 5 000 | 2.4ms | **231ms** | 1.5ms | 2.7ms | 62ms |
| 20 000 | 9.9ms | **1 010ms** | 2.5ms | 3.4ms | 164ms |

归档格式（月包 JSONL，一行一条）同规模对照：

| 归档包 | 体积 | 全量遍历 + parse | 按用例过滤（字符串预筛） |
|---|---|---|---|
| 5 000 条 | 2.0MB | **9ms** | 7ms |
| 20 000 条 | 7.9MB | **30ms** | 23ms |

由此得到三条结论，也是「不引入 SQLite」的依据：

1. **热路径不需要索引**：`TR` 号在项目内单调递增，所以「最新 N 条」「每个用例的最新结果」都能按 id 倒序**只读需要的文件就早退** —— 2 万条记录下只要 2.5ms，且几乎与历史量无关。
2. **归档后冷数据的查询反而更快**：2 万条 30ms vs 小文件全扫描 1 010ms，**快约 34 倍**（顺序读一个大文件 + 切行 + parse，远便宜于 2 万次 `open`/`read`）。所以「归档记录要用单独方式查询」不是降级，而是升级。
3. **git 增量提交成本随工作区文件数线性增长**（20k → 164ms/次），归档把工作区文件数压回几千后自动回落。

**反面结论：不要把执行记录写进一个持续追加的大 JSONL**。每次 commit 都会把整个文件存成新 blob，第 N 次提交的 blob 是 O(N)，累计 O(N²)。正确做法是「热数据小文件（git 友好）＋ 冷数据冻结月包（查询友好、只写一次永不改）」。

**已否决**：SQLite 派生索引（曾记为方案 B）。它的收益（热路径快）已被结论 1 免费覆盖，冷数据查询也不是归档的对手（结论 2），却要额外付出新依赖、`engines` 门槛、`.gitignore` 忽略可靠性、派生一致性等成本。B 的规格已从本文档移除，归档规格见 **§13**。

### 3.7 归档对 Agent 用法的影响

**结论：MCP / CLI 的正常用法完全不变；只有 1 处真实变更，而且是「看得见、够得着」的。**

**不变**

- 8 个新工具与既有 28 个工具的**名称、参数、返回结构、错误语义全部不变**（只给查询类工具加了可选参数 `includeArchived` / `from` / `to` / `hotOnly`，默认值保持「能查到全部数据」的语义）。
- 磁盘上仍是 `testruns/TR-N.json`，**一次执行一个文件**，每次写入仍是一次 git commit。
- Agent 用 `cat` / `grep` 读热目录，以及用 MCP / CLI 查询，行为都不变。

**会变（唯一一处）**

| 变更 | 说明 | 缓解 |
|---|---|---|
| **绕过工具层、直接 `ls testruns/` 的 Agent 看不到已归档记录** | 今天是「所有执行记录都在 `testruns/` 目录里」；归档后一部分移入 `testruns/archive/*.jsonl` | 归档包**就在同一父目录下的 `archive/`**，纯文本、可 `grep` / `jq`；`archive/index.json` 提供一览；`test history` / `test report` 输出末尾显式提示「另有 N 条归档记录」；`--hot-only` 可明确只要热数据 |

**无需 Agent 关心的实现细节**：归档只在写入成功之后触发（§13.2 的 T1），不改变 `test run` 的返回值与调用延迟（受 `budgetMs` 约束）；`git log -- testruns/TR-7.json` 对已归档记录会显示「创建 + 归档删除」两次提交，内容仍可取：
`git show <归档提交>:projects/<key>/testruns/archive/2025-09.jsonl`。

> **为什么这一处变更可以接受**：归档包与热文件同属 `testruns/` 子树、同为纯文本、同样进 git，因此「Agent 直读文件」这一核心能力没有被削弱 —— 只是多了一层目录。相比之下，SQLite 方案会让裸 `grep` 彻底失效（§3.6）。

---

## 4. 核心行为规则

### R1 记录执行 `recordTestRun(input)`

1. 校验用例存在（或按 `caseTitle` 自动建用例，见 R8）。
2. 生成 `TR-N`，写入快照字段（`caseTitle` / `workItem`）与全部结果字段。
3. 副作用（同一事务内、一次 commit 完成）：
   - R2 失败自动开单（可选）
   - R3 缺陷状态推进
   - 追加运行 note 到用例（`"TR-7 pass (build v0.4.0, agent)"`）
4. 提交信息：`test: run TR-7 TC-1 pass (agent)`。
5. 返回：`{ run, createdBugs, updatedBugs, verification }`，让调用方（Agent）立刻知道产生了什么。

### R2 失败自动开单（去重）

触发：`result === 'fail'` 且 `createBugOnFailure === true`。

- **严重级别映射**：用例 `priority` → 缺陷 `severity`：`P0→critical`、`P1→major`、`P2→minor`、`P3→trivial`。
- **新缺陷**：标题 `[TC-1] <用例标题> 执行失败`；`evidence` = `actual` + `evidence` + `env/build`；`workItem` = 用例的 `workItem`；`tags` = 用例 tags + `['from-test']`；反向写入 `testCase` / `testRun`。
- **去重规则**：若该用例已存在 `status ∈ {open, reopened}` 的关联缺陷，则**不新建**，只把本次 `TR-N`、构建、证据追加为该缺陷的一条 note。避免 Agent 每跑一次就刷一条重复缺陷。
- 默认值策略（重要）：**核心 `Store` API 默认 `false`（显式）**，而 CLI/MCP/Web 三端各自把默认设为 `true` 并在 `--help` / schema description / UI 勾选框上写明，让「自动开单」这个副作用在每个界面都可见、可关（CLI `--no-bug`，MCP `createBugOnFailure: false`，Web 取消勾选）。

### R3 缺陷状态推进（pass / fail 双向）

| 场景 | 动作 | 默认 |
|---|---|---|
| pass，缺陷为 `open` / `reopened` | → `fixed`，note 记录 `TR-N/build/env` | ✅ 开启 |
| pass，缺陷为 `fixed` | → `verified` | ⚙️ 仅当 `verifyBugs: true` |
| fail，缺陷为 `fixed` / `verified`（回归失败） | → `reopened`，note 记录失败证据 | ✅ 开启 |
| pass/fail，缺陷为 `wontfix` | 不动 | — |

- 与现有「完成工作项自动关闭关联缺陷」的行为风格保持一致（都会写 note、都会 `closedAt`）。
- `verifyBugs` 默认关闭，是为了让「修复」与「验证」由两个不同角色/两个不同构建分别确认，避免自证。
- 所有自动流转都写入缺陷 `notes`，可审计、可解释。

### R4 工作项完成时的验证摘要与门禁

`completeWorkItem(id)` 新增返回值字段（**非破坏性**）：

```ts
verification: {
  cases: number; pass: number; fail: number; notRun: number;
  blocked: boolean;            // 是否因门禁被拦截
  failing: string[];           // 失败用例 id
  notRunCases: string[];       // 未执行用例 id
}
```

- **默认（P0）**：只读摘要 + 当 `fail > 0` 时自动追加一条 note（`tests: 1/3 failing — TC-5 …`），**从不阻塞**。
- **可选门禁（P2，默认关闭）**：`workspace.json` 增加

  ```jsonc
  "testPolicy": {
    "requirePassingOnComplete": false,  // true = 关联用例有失败/未执行时禁止 done
    "allowForce": true                  // 是否允许 --force / force:true 越过门禁
  }
  ```

  开启后：`completeWorkItem` 在 `fail>0` 或有 `notRun` 时抛错（提示 `--force`），并在绕过时写入 note 记录「强制完成」。用 `nexplan config set-test-policy requirePassingOnComplete true` 切换。
- 门禁只作用于 `status=active` 且 `workItem` 指向该工作项的用例。

### R5 报告与 flaky 判定

- scope 优先级：`batch` > `build` > `workItem` > 全项目。
- `notRun` 定义：scope 内 `status=active` 且在该 scope 内无执行记录的用例。
- **flaky**：同一 batch 内同一用例既有 `pass` 又有 `fail` → 列入 `flaky` 列表（这是「执行记录」沉淀下来后才可能有的洞察，是相对 notes 方案的关键增量价值）。

### R6 删除规则

| 对象 | 规则 |
|---|---|
| TestCase | 仅创建者或 admin 可删（复用现有 creator-or-admin 规则）；**若已存在执行记录，拒绝删除**（错误信息提示 `--force`）；`--force` 时连同其执行记录一并删除，并在提交信息中注明 |
| TestRun | **不可修改**；默认**不可删除**（审计不可变）。仅 admin 可 `--force` 删除（用于误录数据的纠错） |

### R7 权限（完整复用现有三道门，不新增机制）

- 读：`assertProjectAccess(project, actor)`（项目名册 + 严格模式）
- 写：`assertProjectAccess(project, actor, { write: true })`（额外禁止 `viewer`）
- 删：`assertCanDeleteWorkItem` **泛化为 `assertCanDeleteRecord(projectKey, author, createdBy)`**，保留旧方法名作为别名（避免破坏外部调用）
- Web：`storeFor(req, write)` 保持不变；写操作需登录

### R8 未建用例就先有执行结果（Agent 场景）

`recordTestRun` 支持 `caseId` 或 `caseTitle` 二选一：给 `caseTitle` 且无同名 active 用例时，**自动创建用例**（`source`/`createdBy` = 执行者，status `active`，type 默认 `functional`）再记录执行。
理由：Agent 跑完一套测试后一次性上报时，不必先建用例再跑；但避免了「只记录结果、丢掉可复用用例」的数据损失。默认开启，可用 `autoCreateCase: false` 关闭。

---

## 5. 接口设计

### 5.1 Core API（`Store` 新增方法）

```ts
createTestCase(input): Promise<TestCase>
listTestCases(filter?: TestCaseFilter, opts?: { withLastRun?: boolean }): Promise<TestCaseWithStatus[]>
getTestCase(id): Promise<TestCase | null>
updateTestCase(id, patch, author?): Promise<TestCase>
deleteTestCase(id, opts?: { force?: boolean }): Promise<{ deleted: TestCase; deletedRuns: number }>

recordTestRun(input, opts?): Promise<{
  run: TestRun;
  createdBugs: Bug[];
  updatedBugs: Bug[];
  testCase: TestCase;
}>
listTestRuns(filter?: TestRunFilter): Promise<TestRun[]>   // 默认合并热 + 冷
getTestRun(id): Promise<TestRun | null>                    // 热未命中时查月包
testCaseHistory(caseId, limit?): Promise<TestRun[]>        // 最新在前，合并热 + 冷
testReport(filter?): Promise<TestReport>
deleteTestRun(id, opts?: { force?: boolean }): Promise<TestRun>   // admin only（调用方校验）

// ---- 归档（P1，规格见 §13）----
archiveRuns(opts?: { before?: string; keep?: number; dryRun?: boolean }): Promise<ArchiveResult>
restoreArchive(month: string): Promise<{ restored: number }>
reindexArchive(): Promise<ArchiveIndex>
archiveIfNeeded(): Promise<ArchiveResult | null>           // 写入成功后的机会性触发（§13.2 T1）
archiveStatus(): Promise<ArchiveStatus>                    // 供 CLI / Admin 面板展示

// ---- id 计数器（P0，§13.6）----
nextId(prefix): Promise<string>        // 改为优先读 .counters.json，缺失时回退扫目录取 max
```

`Workspace` 侧：`testPolicy` 读写（`getTestPolicy` / `setTestPolicy`，含 `archive` 子配置，支持工作区级默认 + 项目级覆盖）、`projectsStats()` 汇总增加测试计数、`summary()` 透传（自动获得，因为走 `boardSummary()`）。

### 5.2 CLI

```
# 用例
nexplan test list [--status s] [--type t] [--priority p] [--work-item WI-1] [--tag t] \
                  [--automated] [--last-result pass|fail|notRun] [--query q] [--limit n] [--json]
nexplan test get <TC-1> [--json]
nexplan test add "<标题>" [--type functional] [--priority P1] [--status draft|active] \
                  [--precondition "..."] [--step "操作|期望结果"]... \
                  [--work-item WI-1] [--bug BUG-2]... [--tags a,b] [--automated] \
                  [--test-file "test/store.test.ts::claims an item"] [--json-input]
nexplan test update <TC-1> [--title/--description/--type/--priority/--status/--tags/--work-item/--bug/...]
nexplan test rm <TC-1> [--force]

# 执行记录
nexplan test run <TC-1> --result pass|fail|blocked|skipped \
                  [--actual "..."] [--evidence "..."] [--env local] [--build v0.4.0] \
                  [--batch "v0.4.0 回归"] [--duration 1200] \
                  [--no-bug] [--verify] [--force-reopen] [--json]
nexplan test run --title "<新用例标题>" --result fail ...      # 未建用例时自动建（R8）

# 查询与报告（默认合并热 + 冷数据；--hot-only 只看热数据）
nexplan test history [<TC-1>] [--result fail] [--build v] [--batch b] \
                     [--from <date>] [--to <date>] [--limit n] [--hot-only] [--json]
nexplan test report [--batch b] [--build v] [--work-item WI-1] \
                    [--from <date>] [--to <date>] [--hot-only] [--format text|md|json]

# 归档（P1，规格见 §13）
nexplan test archive                       # 立即归档（忽略 auto 与门控）
nexplan test archive --dry-run             # 只报告将归档多少条、落入哪些月包
nexplan test archive --before 2025-06-01   # 指定时间点之前
nexplan test archive --keep 1000           # 只保留最新 1000 条，其余归档
nexplan test archive --restore 2025-09     # 把月包拆回热文件（回滚/纠错）
nexplan test archive --reindex             # 重建 archive/index.json

# 配置
nexplan config set-test-policy requirePassingOnComplete <true|false>       # P2
nexplan config set-test-policy archive.hotDays 90                          # P1
nexplan config set-test-policy archive.hotMax 5000                         # P1
```

典型流程：

```bash
nexplan test add "登录：错误密码三次锁定" --type functional --priority P1 \
  --work-item WI-3 --step "输入错误密码 3 次|账户锁定 15 分钟" --status active
nexplan test run TC-1 --result fail --actual "第 3 次仍可重试" \
  --build v0.4.0 --batch "v0.4.0 回归" --evidence "logs/auth.log:42"
#  → TR-1 fail，自动建 BUG-9（severity=major，P1 映射）
nexplan test run TC-1 --result pass --build v0.4.0-rc2 --batch "v0.4.0 回归" --verify
#  → TR-2 pass，BUG-9: fixed → verified
nexplan test report --batch "v0.4.0 回归"
```

命令命名说明：`test run`（记录一次执行）/ `test history`（执行记录列表）刻意错开近形词，比 `run`/`runs` 更不易误用；`exec` 作为 `run` 的别名提供。

### 5.3 MCP（新增 8 个工具，28 → 36）

| 工具 | 关键参数 | 用途 |
|---|---|---|
| `nexplan_test_case_add` | `items[]`、`author`、`project` | 批量建用例（对齐 `backlog_add` 的批量风格） |
| `nexplan_test_case_list` | `status/type/priority/workItem/tags/automated/lastResult/query/limit` | 查用例（含最近执行结果） |
| `nexplan_test_case_get` | `id` | 单条用例 + 最近执行历史 |
| `nexplan_test_case_update` | `id` + 可改字段 | 改用例（含 `deprecated`） |
| `nexplan_test_case_delete` | `id`、`force` | 删用例（creator/admin） |
| `nexplan_test_run_record` | `runs[]`（`caseId` 或 `caseTitle`、`result`、`actual`、`evidence`、`env`、`build`、`batch`、`durationMs`）、`createBugOnFailure`(默认 true)、`verifyBugs`(默认 false)、`author` | **批量上报一次测试执行**（Agent 主路径） |
| `nexplan_test_run_list` | `caseId/result/build/batch/workItem/since/until/limit`、**`includeArchived`(默认 true)、`from`、`to`、`hotOnly`(默认 false)** | 查执行记录（默认合并热 + 冷） |
| `nexplan_test_report` | `batch/build/workItem`、**`from`、`to`、`hotOnly`** | 通过率 / 未执行 / 失败 / flaky |

Agent 典型调用（一次上报整套回归）：

```jsonc
{
  "runs": [
    { "caseId": "TC-1", "result": "pass", "build": "v0.4.0-rc2", "env": "ci", "durationMs": 812 },
    { "caseTitle": "下单：库存不足提示", "result": "fail", "build": "v0.4.0-rc2",
      "actual": "返回 500", "evidence": "logs/order.log stack…" }
  ],
  "createBugOnFailure": true,
  "batch": "v0.4.0 回归",
  "author": "claude-code"
}
```

（`batch` 也支持放在每个 run 上；工具级 `batch` 作为缺省值。）

> 文档影响：`README.md`、`docs/AGENTS.md`(+zh)、`docs/guides/UserGuide.*.md`、`docs/agents/dsh.md` 中硬编码的「28 tools」需改为 36，工具表需增行。

### 5.4 Web 看板

**REST 端点**（沿用现有 `storeFor(req, write)` 鉴权与错误中间件风格）：

```
GET    /api/testcases?...filters
POST   /api/testcases
GET    /api/testcases/:id
PATCH  /api/testcases/:id
DELETE /api/testcases/:id?force=1
GET    /api/testcases/:id/runs?limit=n        # 该用例执行历史（默认合并归档）
POST   /api/testruns                          # 记录执行（批量数组同样支持）
GET    /api/testruns?caseId=&result=&batch=&build=&workItem=&from=&to=&hotOnly=&limit=
GET    /api/testreport?batch=&build=&workItem=&from=&to=&hotOnly=
GET    /api/testarchive                       # 归档状态（热集条数 / 最近评估与归档 / 月包列表）
POST   /api/testarchive                       # 立即归档（等价于 nexplan test archive）
POST   /api/testarchive/restore               # { month } 拆回热文件
POST   /api/testarchive/reindex               # 重建 archive/index.json
```

**UI 改动（`public/index.html`，单文件 SPA，沿用现有 `api.*` / `modalShell` / `notify` / i18n 模式）**：

1. 顶栏新增标签页 **`Tests / 测试`**（第 5 个 tab）。
2. Tests 页 = 左右两栏（复用现有 `.grid2` + `.panel`）：
   - 左：用例列表（筛选：状态/类型/优先级/工作项/最近结果；每行显示 `TC-1 标题` + 最近结果色块 + 构建 + 时间）。
   - 右：用例详情（步骤表格、关联 WI/BUG 可点击跳转、执行历史时间线、`+ 记录执行` 按钮）。
   - 顶部工具条：`+ 新建用例`、`📊 报告`（弹出批次通过率/未执行/flaky 面板）。
3. **记录执行弹窗**：结果单选（pass/fail/blocked/skipped）、实际结果、证据（多行）、环境、构建、批次、耗时、`☑ 失败自动建缺陷`（默认勾选）、`☐ 通过后验证缺陷`（默认不勾）。
4. **看板卡片徽标**：工作项卡片显示 `✅ 2/3` / `❌ 1/3`（有失败用例时红色），无用例不显示。
5. **工作项详情弹窗**：新增「测试用例」区块，列出关联用例与最近结果。
6. **Admin 页项目统计**：新增测试计数（用例数、最近结果分布）。
7. **归档（P1）**：执行历史面板加「包含归档」开关（默认开）；报告面板加时间范围（`from`/`to`）；Admin 页新增归档状态面板 —— 热集条数、最近评估/归档时间、月包列表与体积、「立即归档」、「重建索引」按钮。
8. **i18n**：`I18N.en` / `I18N.zh` 同步补齐全部新键（该页面是双语硬编码字典，必须成对添加）。

### 5.5 状态汇总的增量（`BoardSummary`）

```ts
export interface BoardSummary {
  // ...现有字段不变
  tests: Record<TestResult, number>;  // 用例「最近一次结果」分布（含 notRun 键）
  totalTestCases: number;
  totalTestRuns: number;
}
```

加性字段 → 旧 UI/调用方忽略即可；同步更新 `chips`（Web）、`nexplan status`（CLI）、`nexplan_status`（MCP）、Admin 统计。

---

## 6. 与既有功能的集成点

| 集成点 | 变化 |
|---|---|
| `nexplan_status` / `/api/board` | 增加测试计数（加性）。**只统计热数据** —— 看板 chips 不该为历史数据付出读月包的成本 |
| `recentActivity` | 新增 `testcase` / `testrun` 活动类型，id 正则扩展为 `(WI\|BUG\|TC\|TR)-\d+` |
| 归档提交 | `test: archive 2025-09 (412 runs)` 会作为一条测试活动进入活动流（`BoardActivity.id` 为空，不指向单条记录），Web 渲染为「归档 N 条执行记录」 |
| `nexplan_agent_next` | 建议（P2）：优先推荐「有失败用例的工作项」与「有失败用例但缺陷已 fixed 的回归验证」 |
| `nexplan_backlog_complete` | 返回 `verification` 摘要；可选门禁 |
| id 分配（`nextId`）| 改为读 `.counters.json`（§13.6）→ 顺带修掉「删除最大号后 id 被复用」的既有缺陷 |
| 文档体系 | 可选（P2）：`nexplan test report --format md` 输出可直接 `docs new --body` 粘贴为测试报告文档，实现「测试报告即版本化文档」 |
| 项目统计（Admin） | 增加用例数/通过率，以及归档状态（热集条数、月包列表） |

---

## 7. 分阶段实施计划

### P0 — 最小可用闭环（核心 + 三端最小面）

1. `src/core/types.ts`：类型、Filter、Report、`BoardSummary`/`BoardActivity` 扩展、`Bug` 可选字段。
2. `src/core/store.ts`：`dirs` 增加 `testcases`/`testruns`；`init()` mkdir；**`.counters.json` 持久化 id 计数器 + `nextId` 优先读计数器（缺失时回退扫描取 max）—— 顺带修掉「删除最大号后 id 被复用」的既有缺陷**（§13.6）；用例 CRUD；`recordTestRun`（R1/R2/R3）；`listTestRuns` / `testCaseHistory` / `testReport` 的读取路径**按热 + 冷合并实现**（P0 时归档目录必然为空）；`boardSummary` 扩展；`recentActivity` 映射。
3. `src/core/workspace.ts`：`migrateLegacy` / `rootHasBoard` 目录列表、`assertCanDeleteRecord` 泛化、`projectsStats` 计数。
4. `src/cli/format.ts` + `src/cli/index.ts`：`formatTestCase/formatTestRun/formatTestReport` + `test` 命令组（add/list/get/update/rm/run/history/report）。
5. `src/mcp/tools.ts`：8 个工具。
6. `src/web/server.ts`：REST 端点。
7. `public/index.html`：Tests 标签页（列表+详情+记录执行弹窗）、看板徽标、chips、i18n 双语。
8. 测试：`test/testcase.test.ts`（新）、`test/mcp.test.ts`（工具数 28→36 + 新工具行为）、`test/workspace.test.ts`（删除门禁/权限）；另加 id 计数器与「按 id 早退读取」专项用例（删除最大号后不复用 id、批量上报只产生一次 commit、最新 N 条不触发全目录扫描）。
9. 文档：README 能力表 + 工具数 + 数据布局 + CLI 参考；`docs/CheatSheet.md`；`docs/AGENTS.md`(+zh)；`docs/guides/UserGuide.en.md` / `.zh-CN.md`；`docs/WORKFLOW.md`（Agent 闭环：跑测试 → 上报 → 自动开单）。
10. `package.json` 版本 0.3.0 → 0.4.0；`npm run build` 更新 `dist/`。

### 实施状态（P0 / P1 已交付，P2 待做）

**P0（已交付，v0.4.0）**：core 类型与 Store 全量（用例 CRUD、`recordTestRun(s)`、R1–R4 规则、报告、热+冷合并读取）、**`.counters.json` id 计数器与「删除最大号后 id 被复用」的既有缺陷修复**、CLI `test` 命令组、MCP 8 个工具（28 → 36）、Web REST + Tests 标签页（用例列表/详情/记录执行/报告弹窗）+ 看板徽标 + chips + 中英双语、`testPolicy`（工作区默认 + 项目覆盖）与**完成门禁**（含 `--force` 与强制留痕）、文档与 0.4.0 构建。

**P1（已交付）**：全部归档规格（§13）——`archive.ts` 判定与月包整形、写入后 O(1) 门控、月包 JSONL、`--dry-run` / `--restore` / `--reindex`、CLI `test archive|archive-status`、三端查询参数（`--hot-only` / `--from` / `--to` / `includeArchived`）、`test/archive.test.ts` 19 个断言、文档。

**P1 遗留缺口（设计写了、实现没做 —— 2026-09 审计结果）**

| # | 缺口 | 影响 |
|---|---|---|
| A1 | **Web 归档 UI 完全未做**：`/api/testarchive*` 端点已就绪，但 `public/index.html` 里零调用 —— 缺 §13.9 要求的 Admin 归档状态面板（热集条数 / 最近评估与归档时间 / 月包列表与体积 / 「立即归档」/「重建索引」）、执行历史「包含归档」开关、报告面板 `from`/`to` 时间范围 | 人类在 GUI 里既看不到也管不了归档 |
| A2 | **CLI 批量上报缺失**：MCP 有 `runs[]`、Web 支持数组，CLI `test run` 只能单条（无 `--json-input`） | 三端能力不对齐；CI/脚本一次上报整套要走 MCP |
| A3 | **工作项详情弹窗未列出关联用例**（§5.4 第 5 项） | 从「任务」看不到它的验证状态，只能回 Tests 页翻 |
| A4 | **Admin 页项目统计未含测试计数**（§5.4 第 6 项） | 只有顶部 chips 有汇总，Admin 面板看不到 |
| A5 | **Web 用例编辑弹窗缺「守护缺陷」字段**（CLI `test update --bug`、MCP 都有） | Web 上无法把用例与缺陷绑定，R3 自动流转在 Web 侧用不上 |

**P2（待做，不含已延期的导入）**

1. **`test report --format md`**：导出 Markdown 报告（通过率、失败清单、未执行、flaky、覆盖率缺口），可直接 `docs new --body` 落成版本化文档（「测试报告即文档」）。
2. **`nexplan_agent_next` 纳入测试维度**：在推荐顺序里加「有失败用例但缺陷已 `fixed`」的回归验证项、以及「有失败用例的工作项」，让 Agent 的下一步包含测试驱动的修复/验证。
3. **Web 批量记录执行界面**：多选用例 → 一次提交结果（人工跑一遍回归时批量录入），对齐 MCP/CLI 的批量能力。
4. （可选）**`WorkItemType` 增加 `test` 类型**：影响 7 处枚举/文档（`types.ts`、`store.ts`、`mcp/tools.ts`、CLI `--type` 帮助、`index.html` 表单下拉、`docs/CheatSheet.md`、`UserGuide` 枚举表）。

**D. 已延期（遗留项，待业主下周评审后决定）**

- **CI 测试结果导入**：`nexplan test import --json <file|->`（准绳格式 = 与 MCP `test_run_record` 相同的 `runs[]`，任何 runner/CI 都能用 `jq` 生成）+ 可选适配器 `--from junit`（JUnit XML 是**交换格式**而非通用格式，只能是适配器不能是地基）；共用的匹配与汇总规则：`caseId` → `testFile`（`classname#name` 归一化）→ 标题 三级匹配，未匹配默认跳过并汇总，`--create-missing` 自动建 draft，`--dry-run` 只报告不写，`--batch`/`--build`/`--environment` 缺省注入。
  **延期的原因**：先确认目标项目的 runner/CI 分布，避免为一个非通用格式先付适配器与维护成本。
  **判定标准（下周评审用）**：① 目标项目里有多少 runner 无法一行产出准绳 JSON？② CI 里是否已经产出了可复用的机器可读报告？③ 手工/Agent 上报（`test_run_record`）的遵守率是否真的会掉到需要导入来兜底？

**P2 建议追加（本文档原未列，待拍板）**

- MCP 的归档**只读可见性**：`nexplan_test_run_list` / `nexplan_test_report` 返回里附一个 `archive` 摘要（热集条数、已归档条数、最近归档时间）—— 不新增工具、不破坏 36 的工具数，但让 Agent 知道「查到的数据是否被归档过」。
- 「热路径早退读取」的**性能守卫测试**：当前只有「未 readdir」的 spy 断言，建议补一个基准/计数断言，防止将来某次改动把它悄悄变成全量扫描。
- **项目级归档阈值的端到端测试**：现在测了策略合并（`getTestPolicy`）与直接注入 policy 的归档行为，但**没有**从 `project.json` 覆盖 → 门控按项目阈值真实触发的端到端断言。

### 历史计划（保留供对照）

- ~~`nexplan_agent_next` 纳入失败用例优先级~~ → 见 P2 第 2 项。
- ~~`testPolicy.requirePassingOnComplete` 门禁 + `config set-test-policy`~~ → **已在 P0 交付**。
- ~~`nexplan test import --junit <file.xml>`~~ → 见 **D（已延期）**。

### 粗估工作量

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 核心 + CLI + MCP | 1.5 人日 |
| P0 | Web（UI + REST + i18n） | 1 人日 |
| P0 | 测试 + 文档 + 构建 | 1 人日 |
| P0 | id 计数器 + 热/冷合并读取层抽象（§13.6，归档的前置条件） | +0.3 人日 |
| P1 | ~~报告增强~~（flaky/覆盖率已随报告交付） | — |
| P1 | **归档**（§13：判定 + 月包 + 门控 + 三端 + 测试） | +1～1.5 人日 |
| P2 | A1 遗留缺口修复（Web 归档 UI / CLI 批量 / 工作项用例区块 / Admin 计数 / 用例表单 bugs 字段） | 1.3 人日 |
| P2 | B 新功能（报告 md 导出 / `agent_next` 测试维度 / Web 批量记录 / `WorkItemType: test`） | 1.3 人日 |
| P2 | C 健壮性（MCP 归档摘要 / 性能守卫测试 / 项目级归档阈值端到端测试） | 0.6 人日 |
| D | CI 结果导入 —— **已延期**，待评审 | 1～1.5 人日 |
| **合计** | 已交付约 7 人日；**待做（不含 D）约 3.2 人日**；含 D 约 4.4 人日 | **约 11 人日** |

---

## 8. 验收标准（DoD）

**功能**

- [ ] 可创建/查询/更新/删除用例，字段齐全（前置条件、步骤+期望、类型、优先级、关联 WI/BUG、自动化定位）。
- [ ] 可记录执行（单条 + 批量），字段齐全（结果、实际、证据、环境、构建、批次、耗时、执行人、时间）。
- [ ] 执行记录写入后**不可修改**；用例后续改名/删除不影响历史记录可读性（快照有效）。
- [ ] 失败自动开单生效，且**同一用例同一构建重复失败不会产生重复缺陷**（只追加证据）。
- [ ] `pass` 使 `open/reopened` 缺陷 → `fixed`；`verifyBugs` 使 `fixed` → `verified`；`fail` 使 `fixed/verified` → `reopened`；每次流转都有 note。
- [ ] `nexplan test report` 输出通过率、未执行清单、失败清单、flaky 清单，`--json` 可机器解析。
- [ ] CLI / MCP / Web 三端能力对齐（同一份数据、同一套权限）。
- [ ] Web：Tests 标签页可完成「建用例 → 记录执行 → 看历史 → 看报告」全流程，中英双语无缺失键。

**非功能**

- [ ] 现有 588 行已有测试全部通过；MCP 工具数断言更新为 36。
- [ ] `npm run typecheck` 与 `npm run build` 零错误。
- [ ] 旧工作区（仅 workitems/bugs/docs）打开后自动创建新目录，不报错、不丢数据。
- [ ] 每次写入产生一条语义清晰的 git commit（可读的审计流）。
- [ ] `viewer` 角色无法写用例/执行记录；未登录 Web 用户无法写；项目名册外用户读写均被拒。

**体验**

- [ ] 一次「记录执行失败」后，看板卡片徽标、工作项完成摘要、缺陷列表三处状态一致。
- [ ] `--help` 文案明确写出「失败自动开单」默认行为与关闭方式。

**归档（P1）** —— 完整验收清单见 **§13.7**。P0 阶段只需满足两条前置条件：① `.counters.json` 就位（删掉最大号后不复用 id）；② 所有查询路径按「热 + 冷合并」实现（此时 `archive/` 必然为空）。

---

## 9. 测试策略

| 层级 | 内容 |
|---|---|
| 单元（`test/testcase.test.ts`，新） | 用例 CRUD、ID 自增（TC-N/TR-N 独立于 WI/BUG）、筛选（status/type/workItem/lastResult）、快照不可变、`recordTestRun` 全套副作用、去重规则、R3 四类状态推进、`notRun` 与 flaky 计算、删除规则（有执行记录时拒绝 + `--force`） |
| 集成（`test/mcp.test.ts` 扩展） | 工具数 28 → 36；`nexplan_test_case_add` → `nexplan_test_run_record`(fail) → 断言自动建 BUG 与 `bugIds`；再 `pass` + `verifyBugs` → 断言缺陷 `verified`；批量上报 count |
| 权限（`test/workspace.test.ts` 扩展） | viewer 写被拒；非成员读写被拒；非创建者非 admin 删用例被拒；`force` 仅 admin |
| 兼容（扩展） | 旧工作区（无新目录）init 后可用；`BoardSummary` 旧字段值不变 |
| Web | 现状 `startWebServer` 不返回 `http.Server`，无法在测试内拿到端口。建议**小改动**：让 `startWebServer` 返回 `http.Server`（向后兼容），据此加 `test/web.test.ts` 覆盖鉴权 401/403 与用例端到端；否则退化为 `curl` 手工验收清单 |
| 计数器与早退读取（P0） | 删除最大号后**不复用 id**；`.counters.json` 缺失时回退扫目录取 max；「最新 N 条」在 1 万条热数据下不触发全量 parse（spy 断言读取文件数 ≈ N + 常数） |
| 归档（`test/archive.test.ts`，新，P1） | §13.7 全部断言：判定规则（时间 / 条数 / 批次锚定）、幂等（重复运行与中断重跑）、`--dry-run` 不落盘、`--restore` 还原后结果一致、id 不回退、月包可 `grep`/`jq`、归档恰好一次提交、门控零成本（spy 断言未 `readdir`）、项目级阈值覆盖生效 |
| 手工验收 | 按第 8 节 DoD 逐条在 Web 上走一遍（中/英双语各一次） |

---

## 10. 迁移、兼容与回滚

**迁移**：零脚本迁移。新目录由 `Store.init()` / `Workspace.init()` 自动创建；旧 JSON 不加字段照常工作（新字段全部可选）。`migrateLegacy()` 的目录探测列表加入 `testcases`/`testruns`，使旧单板布局（数据在 workspace 根）也能一并搬迁。

**兼容**：`BoardSummary`、`Bug`、`BoardActivity` 全部为**加性**变更；`assertCanDeleteWorkItem` 保留为别名；`completeWorkItem` 新增返回字段不影响既有调用方；MCP 工具数增加不影响既有工具契约。

**回滚**：整体为一个可 revert 的提交集合。回滚后：新目录中的 `testcases/`、`testruns/` JSON 成为**惰性数据**（不被读取、不被删除），留在 git 历史与工作区中；重新升级即可继续使用。门禁默认关闭，因此不存在「回滚后流程被卡住」的风险。建议在 `docs/` 保留本设计文档作为回滚说明。

**归档的迁移与回滚**（完整对照表见 §13.8）

- **启用**：无迁移。首次满足门控即自动归档已有历史，也可用 `nexplan test archive` 一次性整理。
- **回滚代码**：归档包是普通文件 → **数据不丢**；但旧版本只扫热目录、看不到归档记录，需用 `--restore`（由新版本执行）或手工按行拆回热文件。
- **永久停用自动归档**：`testPolicy.archive.auto=false` —— 已归档文件保留，读路径仍合并，历史查询不受影响。
- **完全还原为纯 A**：逐月执行 `nexplan test archive --restore <YYYY-MM>` 后关闭 `auto`。
- **P0 前置项回滚**：`.counters.json` 是普通文件；回滚代码后旧版仍按「扫描取 max」工作，无副作用（但 id 复用缺陷会回来）。

---

## 11. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自动开单造成缺陷刷屏 | 缺陷列表噪音 | 去重规则（同用例同状态只追加证据）+ 三端默认值可见可关 + `from-test` 标签便于过滤 |
| 自动状态流转「越权」推进缺陷 | 缺陷状态失真 | `verifyBugs` 默认关闭（修复与验证分离）；全部流转写 note；`wontfix` 永不触碰 |
| 门禁阻塞 Agent 流水线 | Agent 被卡死 | 门禁默认关闭、独立配置项、`force` 逃生通道并留痕 |
| 执行记录数量膨胀导致读取变慢 | 列表/报告变慢 | 热路径用「按 id 早退读取」做到 O(limit)（§3.6 结论 1）；超阈值后由归档把热集压到 5k（§13） |
| **归档后「查不到旧记录」的误判** | Agent/人类以为数据丢了 | 读路径默认合并热 + 冷（I4）；输出末尾显式提示「另有 N 条归档记录」（§13.5） |
| **归档把批次切成两半** | 批次报告失真 | 批次锚定规则：批次内任一记录仍热 → 整批留热（§13.4）；专项测试覆盖跨 `hotDays` 边界场景 |
| **id 回退/复用**（既有缺陷，归档会放大） | 引用静默指向另一条目 | `.counters.json` 计数器 + `nextId` 优先读计数器（§13.6），P0 交付 |
| 归档中途被中断 | 出现重复行或半搬移 | 全流程幂等：月包按 id 去重合并、原子 `rename`、重复删除无害（I5） |
| 月包过大（超高量项目） | 单文件过大、单次归档耗时 | `bundle: week` 粒度 + `minRunsPerArchive` / `budgetMs` 可调；实测 2 万条 ≈ 7.9MB、遍历 30ms，余量充足 |
| 归档产生一次性大 diff | code review 噪音 | 归档是**独立且清晰的审计事件**（`test: archive 2025-09 (412 runs)`：删 N 个热文件 + 增 1 个月包）；月包写一次后冻结，不重复变更 |
| 用例与真实自动化测试代码脱节 | 用例腐化 | `testFile` 字段 + 报告暴露「长期未执行」清单；P2 的 JUnit 导入把用例与真实测试绑定 |
| Web 单文件 SPA 继续膨胀（现 1265 行） | 可维护性下降 | 本阶段跟随现有模式；如再增长，另立「拆分前端模块」的独立任务（不在本次范围） |

---

## 12. 开放问题（请评审拍板）

| # | 问题 | 我的推荐 | 备选 |
|---|---|---|---|
| **Q0 ✅已定** | **存储后端** | **A：纯文件 + git，配「归档」解决无界增长**（规格见 §13，已定稿） | SQLite 派生索引（曾记作方案 B）**已否决** —— 理由与实测数据见 §3.6 |
| Q1 | 是否需要独立的「测试计划/测试批次（TestPlan）」实体？ | **不引入**，用 `batch` 自由文本标签 + `build` 字段分组，保留后续升级空间 | 建 `TP-N` 实体（更重，报告更规范） |
| Q2 | 执行记录是否允许修改/删除？ | **不可改**；默认不可删，仅 admin `--force` 纠错 | 完全不可删（最严） |
| Q3 | 失败自动开单的默认值？ | 核心 API 默认 **false**（显式）；CLI/MCP/Web 默认 **true** 且可见可关 | 全部默认 false（最保守）/ 全部默认 true（最省事） |
| Q4 | `pass` 是否自动把缺陷推进到 `verified`？ | **默认不**（`verifyBugs` 显式开启），修复与验证分离 | 默认自动 `verified`（更快但有自证风险） |
| Q5 | 工作项完成是否强制要求用例全通过？ | **默认不阻塞**（只给摘要 + note），门禁作为 `testPolicy` 可选开关 | 直接默认阻塞（严，但会打断现有 Agent 流程） |
| Q6 | `TestRun` 直接挂在**工作项**上是否也要支持（不经过用例，如「手工点了一遍」）？ | **不支持**；统一经用例（可用 R8 自动建用例），保证可复用性与统计口径一致 | 允许 `workItem` 直挂的临时执行记录 |
| Q7 | CLI 命名 `test run` / `test history` 是否接受？ | 接受（`exec` 作为别名） | `test exec` / `test runs` |
| Q8 | 是否为工作项新增 `type: 'test'`？ | P1 再做（便于「编写测试用例」作为任务），P0 先用 tag `testing` | P0 一并做（同步 7 处枚举与文档） |
| Q9 | 是否需要 JUnit XML 导入（对接 CI）？ | 作为 P2 独立评审项，不进入本次 P0 | 现在就做（需新增解析依赖或自写解析器） |
| Q10 | Web 是否需要「批量记录执行」界面（多选用例一次提交结果）？ | P1 再做，P0 只做单条记录 | P0 就做（Agent 场景主要用 MCP，人手场景单条够用） |
| **Q11** | **归档阈值是否接受默认值？** | **接受默认**：`hotDays 90` / `hotMax 5000` / 触发高水位 1.2×（6000）/ `minIntervalHours 24` / `minRunsPerArchive 50` / `budgetMs 2000` | 更激进（30 天 / 2000 条）或更保守（180 天 / 10000 条）；全部可在工作区级配置，并按项目覆盖 |
| **Q12** | **月包粒度** | **`month`**（实测 2 万条 ≈ 7.9MB、遍历 30ms，余量充足） | 超高量项目用 `week`（`bundle` 配置项已预留） |
| **Q13** | 归档的**自动触发**是否默认开启？ | **默认开启**（`auto: true`）—— 无调度器，靠 Agent 写入触发是唯一无维护成本的路径 | 默认关闭、只允许显式 `nexplan test archive`（可控但要靠人记得） |
| **Q14** | 查询输出是否默认提示「另有 N 条归档记录」？ | **默认提示**（避免 Agent/人类误判「数据不见了」，§13.5） | 仅在 `--verbose` 下提示 |

---

## 13. 归档方案完整规格（A + 归档，已定稿）

> **决策（已拍板）**：存储后端确定为「纯文件 + git」（方案 A），用**归档**解决执行记录无界增长。**方案 B（SQLite 派生索引）已否决** —— 实测表明归档后冷数据的全量查询比等价的小文件扫描**快约 34 倍**（§3.6），而 B 原本要解决的热路径成本已被「按 id 早退读取」免费覆盖（§3.3）。
> 本节给出归档的**触发时机、阈值、判定规则、格式、查询路径与验收标准**。

### 13.1 定位与不变量

| # | 不变量 | 违反后果 |
|---|---|---|
| **I1** | **文件是唯一事实源**：归档只是把冷记录从热目录「移动并合并」到月包，**记录字段逐字段不变** | 数据失真 |
| **I2** | **工具契约不变**：MCP 仍是 36 个工具（只给既有查询工具加可选参数，不新增工具）；CLI 既有输出格式不变 | Agent 用法变更 |
| **I3** | **归档包是纯文本**：进 git、可 `diff`、可 `grep`、可 `jq` | 失去可读性/可审计性 |
| **I4** | **所有读路径合并热 + 冷**：绝不允许出现「归档后查不到」 | 静默丢数据 |
| **I5** | **归档幂等**：重复执行、中断后重跑都安全（按 id 去重合并） | 重复记录 |
| **I6** | **归档是优化而非正确性依赖**：不做归档系统也完全可用 | 优化项变成故障源 |

### 13.2 触发时机（何时触发归档）

三个入口，**主入口是「写入后机会性触发」**。之所以不做定时任务：本仓库没有调度器（无 cron、无守护进程），而 Agent 是主要写入方，不会主动执行维护命令。

| # | 入口 | 说明 |
|---|---|---|
| **T1（主）** | **写入后机会性触发** | 每次 `recordTestRun`（单条或批量上报）**成功 commit 之后**调用一次 `archiveIfNeeded()`。放在写入之后：不阻塞业务写入，且此时热集才是最新状态 |
| **T2** | **显式命令** | `nexplan test archive [--dry-run] [--before <date>] [--keep <n>]`，**忽略 `auto` 与全部门控**，立即执行。人类 / CI / 排障用 |
| **T3** | **Web 面板与启动检查** | Admin 页「立即归档」按钮；`nexplan web` 启动时做一次机会性检查（给「长期无写入但有人访问」的项目一个入口） |

**明确不做**：cron / 守护进程（无运行时载体）；每次写入都全量评估（5k 热数据一次评估 ≈ 231ms，纯浪费）；只靠手动维护（Agent 不会做）。

### 13.3 门控与阈值（O(1) 检查 → 评估 → 执行）

写入后的门控分三步，**绝大多数写入在第 1 步就返回，不产生任何额外 IO**：

```
archiveIfNeeded(project):
  # ---- 第 1 步：O(1) 门控（读 .counters.json —— 该文件本来就要读来分配 id，零额外成本）
  if (!policy.archive.auto) return
  c = counters(project)                       # { TR, TR_ARCHIVED, oldestHotAt, lastEvalAt, … }
  hot       = c.TR - c.TR_ARCHIVED            # 热目录中的执行记录条数
  countGate = hot >= policy.hotMax * (1 + hysteresisRatio)      # 默认 5000 × 1.2 = 6000
  timeGate  = !c.oldestHotAt || c.oldestHotAt < now - hotDays * 86400_000  # 默认 90 天；缺失时按「需评估」处理
  throttled = now - c.lastEvalAt < minIntervalHours * 3600_000  # 默认 24h，仅节流时间门

  if (!countGate && !(timeGate && !throttled)) return   # ★ OR 语义：两者任一满足即继续；常规写入在此结束

  # ---- 第 2 步：评估（扫描热目录，≤ 6000 条 ≈ 280ms）
  c.lastEvalAt = now; save(c)                 # 无条件记「已评估」，否则时间门会一直为真
  vintage = classify(hotRuns)                 # 判定规则见 §13.4
  if (vintage.length < minRunsPerArchive) return   # 碎片化归档不值得（默认 50）

  # ---- 第 3 步：执行（受 budgetMs 限制，超预算即停，剩余留给下一次，幂等）
  for (g of groupByMonth(vintage)) {          # 月包粒度由 policy.bundle 决定
    if (elapsed() > budgetMs) break
    merge → write <YYYY-MM>.jsonl.tmp → rename     # 与既有月包按 id 去重合并 + 排序
    fs.rm(该组的热文件)
  }
  c.TR_ARCHIVED += archivedCount
  c.oldestHotAt = 归档后热集中最早的 executedAt   # 供下一次 O(1) 判定
  save(c)
  commit(`test: archive <months> (<n> runs)`) # 归档是一次提交
```

**门控语义：两级判定都是「或」，但含义完全不同（最易读错的地方）**

| 层级 | 条件 | 语义 |
|---|---|---|
| **L1 触发：何时去「评估」** | `countGate` **或** `timeGate` | 两个门各自都是「可能有活干」的**充分线索**，满足任一就值得评估 |
| **L2 判定：哪些记录「可归档」** | `超期` **或** `排名越界` | 热集必须**同时**满足「不超过 90 天」与「不超过 5000 条」两个上限，所以违反任一即归档（§13.4） |

**为什么 L1 用「或」而不是「与」**：`hotMax` 只反映「条数」这一个上限。如果要求两个门同时满足，小体量项目（例如 20 条/天，要两年才积累到 6000 条）会长期不归档，`hotDays` 实际上被架空 —— 而「热集 ≈ 最近一个季度」正是我们想要的性质。用「或」带来的额外成本由两道闸门兜住：`minIntervalHours` 限制评估频率、`minRunsPerArchive` 限制 commit 频率。

**为什么 `countGate` 不加节流**：滞回（6000 vs 5000）已经让它约每 1000 条写入才越界一次；而一次性批量上报 5000 条这种情况本就该立刻归档。

**为什么 `timeGate` 要配 24h 节流**：即使有 `oldestHotAt` 这个精确条件，也可能出现「确有超期记录但数量不足 `minRunsPerArchive`」→ 条件持续为真 → 每次写入都重新扫描。24h 节流就是防这个的。

**实现细节（必须做对）**：第 2 步一旦进入评估，就要**无条件更新 `lastEvalAt`**（哪怕最后一条都没归档）。否则时间门永远为真，下一次写入又会重新评估，退化成「每次写入都扫描热目录」。

**阈值默认值**

| 配置项 | 默认 | 取值理由 |
|---|---|---|
| `auto` | `true` | 无调度器，只能靠写入触发 |
| `hotDays` | `90` | 热数据覆盖一个季度的回归对比 / flaky 观察需求 |
| `hotMax` | `5000` | 实测 5k 条：全量扫描 231ms、增量 commit 62ms —— 人工可接受的水位 |
| `hysteresisRatio` | `0.2` | **触发高水位 6000 ≠ 保留阈值 5000**：归档后要再写满约 1000 条才可能再触发，避免每次写入都评估 |
| `minIntervalHours` | `24` | **仅用于节流时间门**（防「确有超期记录但不足 `minRunsPerArchive`」时反复扫描）；计数门靠滞回自行节流 |
| `minRunsPerArchive` | `50` | 单次至少归档 50 条，避免小归档与 commit 噪音 |
| `budgetMs` | `2000` | 单次归档时间预算，保证不拖慢 Agent 的写入调用 |
| `bundle` | `month` | 月包粒度；超高量项目可改 `week` |

`.counters.json` 另外维护 **`oldestHotAt`**（热集里最早的 `executedAt`）：写入时取 `min(旧值, 新记录.executedAt)`（回填旧时间也自动覆盖），归档后按扫描结果重算；**缺失或损坏时视为「需要评估」**（安全方向）。有了它，`timeGate` 就从「距上次评估 ≥24h」这个**代理条件**升级为「热集里确实存在超期记录」这个 **O(1) 精确条件** —— 不满足时连每天一次的热目录扫描都省掉了。

**配置位置**：工作区默认 `workspace.json → testPolicy.archive`；**项目级 `project.json → testPolicy.archive` 可覆盖**（不同项目量级差异大）。切换用 `nexplan config set-test-policy archive.hotMax 5000`。

**为什么门控不每次 `readdir`**：热集条数从计数器得到是 O(1)；而「是否存在超过 `hotDays` 的记录」必须扫目录才知道，所以用 24h 节流把它摊薄。于是 Agent 的每次上报只多一次「读一个小 JSON」的成本。

### 13.4 归档判定规则（哪些记录可以归档）

- **单条规则**：记录 `r` 可归档 ⟺ `r.executedAt < now − hotDays` **或** `rank(r) > hotMax`。
  `rank` 按 `executedAt desc, id desc` 排序（评估阶段本来就要遍历热记录，排序免费）。
- **批次锚定规则（防「半个批次」）**：若 `r.batch` 非空，则 `r` 可归档还需满足「**该批次中 `executedAt` 最新的那条也可归档**」。
  → 批次仍活跃（还有热记录）就**整批留热**；批次已静默超过 `hotDays` 就**整批归档**。这自然处理了「跨月长批次」。
- 无 `batch` 的记录按单条处理。
- **不设**「每条用例保留最近一次执行」的例外：读路径本就合并热 + 冷（I4），「最近一次结果」天然跨两处。

**边界情况**

| 情况 | 行为 |
|---|---|
| 项目长期无写入 | 不归档（无触发者）——无害，归档只是优化（I6）；可用 T2 / T3 入口 |
| 一次批量上报 5000 条（= `hotMax`） | 该批次整批留热，直到静默超过 `hotDays` |
| 批次跨阈值但仍然活跃 | 整批留热（批次锚定规则） |
| 归档中途进程被杀 | 幂等：下次合并按 id 去重，重复删除无害 |
| `executedAt` 被回填为很久以前 | 按时间规则可归档；但若其批次最新记录是热的 → 随该批次留热 |
| 系统时钟回拨 | 只用相对比较（`now − executedAt`），只影响触发频率，不影响正确性 |
| 热目录被手工清空 | 计数器仍在 → `nextId` 不回退（§13.6）；下次写入由计数器判定 |

### 13.5 归档格式与查询路径

**存储格式**

```
projects/<key>/testruns/
  TR-1.json … TR-512.json        ← 热目录（一执行一文件，git 友好、可早退读取）
  archive/
    2025-07.jsonl                ← 冷月包（一行一条完整 TestRun JSON）
    2025-08.jsonl
    index.json                   ← 可选派生索引（纯文本，可删可重建）
```

- 文件名：`<YYYY-MM>.jsonl`（`bundle: week` 时为 `<YYYY-Www>.jsonl`）。
- 每行是一条**完整的 TestRun JSON**，字段与热文件**逐字段相同**，无包装字段、无嵌套信封。
- 行序：`executedAt asc, id asc`（确定性排序 → diff 稳定、归档可重复执行）。
- **写一次即冻结**：归档完成后该月包不再变更（除非回填迟到记录或执行 `--restore`）→ git 只存一份 blob，**不会出现「每次提交重写大文件」的 O(N²) 膨胀**。
- 体积参考（实测）：20 000 条 ≈ 7.9MB，全量 `parse` 仅 **30ms**。

**为什么不用 gzip**：二进制会丧失 `git diff` 与 `grep` / `jq` 能力 —— 这正是我们选纯文件而不是数据库的核心理由（I3）。

**可选派生索引 `archive/index.json`**（纯文本、可随时重建、删掉无害）：

```jsonc
{ "builtAt": "2025-09-13T10:00:00Z",
  "bundles": [{ "file": "2025-08.jsonl", "from": "…", "to": "…", "runs": 412, "cases": 37 }],
  "byCase":  { "TC-1": ["2025-07", "2025-09"] } }
```

用途：让「某用例的历史」只打开相关月包（2 个）而不是全部（24 个）。重建命令 `nexplan test archive --reindex`。

**查询路径（热 + 冷合并，I4）**

| 场景 | 实现 | 成本（实测口径） |
|---|---|---|
| 最新 N 条（活动流 / 看板徽标） | 热目录按 id 倒序**早退读取** N 条；不足 N 时再取**最新月包尾部**归并 | 2.5ms 级，与历史量无关 |
| 某用例的历史 | 热目录按 `caseId` 过滤 + 仅打开 `index.json.byCase` 指到的月包 | 命中月包数 × 30ms |
| 批次 / 构建 / 时间范围报告 | 按 `index.json.bundles[].from/to` **跳过无关月包**，只流式读命中的包 | 同上 |
| 全历史统计 | 流式遍历全部月包 | 20k ≈ 30ms |

**三端接口（不新增 MCP 工具）**

| 端 | 变化 |
|---|---|
| **MCP** | `nexplan_test_run_list` / `nexplan_test_report` 增加可选参数 `includeArchived`（默认 `true`）、`from`、`to`、`hotOnly`（默认 `false`）—— **工具数保持 36** |
| **CLI** | `nexplan test history [<TC-1>] [--hot-only] [--from <date>] [--to <date>]`；`nexplan test report [--from] [--to] [--hot-only]`；`nexplan test archive [--dry-run] [--before <date>] [--keep <n>] [--restore <YYYY-MM>] [--reindex]` |
| **Web** | 执行历史面板「包含归档」开关（默认开）；报告面板时间范围；Admin 页归档状态（热集条数 / 最近评估与归档时间 / 月包列表与体积 / 「立即归档」/「重建索引」）+ en/zh i18n |
| **裸查询** | `grep '"caseId":"TC-1"' projects/api/testruns/archive/*.jsonl`、`jq -c 'select(.result=="fail")' …` —— 纯文件的独有优势 |

**输出提示**：`test history` / `test report` 在存在归档数据时，输出末尾追加一行 `(另有 N 条归档记录，已包含；--hot-only 可只看热数据)`，避免 Agent 与人类误判为「数据不见了」。

### 13.6 必须配套：持久化 id 计数器（P0 就做）

**为什么必须**：现状 `nextId()` 是「扫描目录取最大号 + 1」（`src/core/store.ts:185-194`）。归档会把旧记录移出热目录；若热目录被判空（例如所有记录都超过 `hotDays`）→ 下一个号会回到 `TR-1`，**与月包内已有记录 id 撞车**，破坏「执行记录不可变」与去重语义。

**顺带修掉一个既有缺陷**（不是归档引入的，但归档会把它放大成必然）：删除编号最大的工作项（`nexplan rm WI-5`）后，下一项会**复用 `WI-5`**，而缺陷的 `workItem` / `fixesBug`、父子关系、用例的 `workItem` 中对 `WI-5` 的引用会**静默指向另一个条目**。

**方案**：项目内新增 `.counters.json`（与 `nexplan.json` 同级，进 git）：

```jsonc
{ "WI": 12, "BUG": 9, "TC": 57,
  "TR": 412,            // 已分配的最大 TR 号（只增不减）
  "TR_ARCHIVED": 300,   // 已归档条数 → 热集条数 = TR - TR_ARCHIVED（§13.3 的 O(1) 计数门）
  "oldestHotAt": "…",   // 热集中最早的 executedAt → 供 §13.3 的 O(1) 时间门
  "lastEvalAt": "…", "lastArchiveAt": "…" }
```

- `nextId()` **优先读计数器并自增**，写回在同一次 `tx()` 内（与业务写入合成同一个 commit）；
- 计数器缺失/损坏 → **回退为扫描目录取 max**（兼容旧工作区与手工创建的数据），并把结果写回计数器；
- 归档删除热文件时**绝不回退** `TR`，只推进 `TR_ARCHIVED`；
- 一个文件同时服务两个目的（id 单调性 + 归档门控），约 30 行代码，比 B 的整套索引便宜两个数量级。

### 13.7 归档的验收标准（DoD）

- [ ] 归档后 `nexplan test history <TC-1>`（默认合并）能查到冷记录，且与热记录**逐字段相等**。
- [ ] 归档**幂等**：重复运行、中断后重跑都不产生重复行（按 id 去重合并）。
- [ ] **批次原子性**：绝不出现半个批次在月包、半个在热目录（含「批次跨 `hotDays` 边界仍活跃」场景）。
- [ ] 归档后 `nextId` 继续递增：热目录被清空后再写入，也**不会复用已归档的 id**。
- [ ] `--dry-run` 准确报告将归档多少条、落入哪些月包，且**不写任何文件**。
- [ ] `--restore <YYYY-MM>` 能把月包拆回热文件，且 `test history` 结果与归档前一致。
- [ ] 月包可被 `grep` / `jq` 直接查询（纯文本断言）。
- [ ] `git log` 中归档**恰好一次提交**（`test: archive 2025-09 (412 runs)`）；月包写一次后不再变更。
- [ ] 归档是优化而非依赖：手工删除整个 `archive/` 目录后系统仍可用（少返回冷数据，不报错）。
- [ ] **门控零成本**：未达高水位且未过 24h 的写入，不产生对热目录的扫描（用 spy 断言未调用 `readdir`）。
- [ ] 阈值可覆盖：项目级 `testPolicy.archive` 覆盖工作区级后行为正确。

### 13.8 归档的迁移与回滚

| 场景 | 动作 |
|---|---|
| 启用归档 | **无迁移**。首次满足门控即自动归档已有历史；也可立即用 `nexplan test archive` 一次性整理 |
| 调整阈值 | `nexplan config set-test-policy archive.hotDays 30`（工作区）或在 `project.json` 按项目覆盖；**无需重建任何东西** |
| 回滚代码 | 归档包是普通文件 → **数据不丢**。但旧版本只扫热目录、看不到归档记录；用 `--restore`（由新版本执行）或手工按行拆回热文件即可 |
| 永久停用自动归档 | `testPolicy.archive.auto=false`：停止自动归档，**已归档文件保留且读路径仍合并**（历史查询不受影响） |
| 完全还原为纯 A | 对每个月包执行 `nexplan test archive --restore <YYYY-MM>`，然后关闭 `auto` |

---

## 附：改动文件清单（P0）

| 文件 | 改动 |
|---|---|
| `src/core/types.ts` | 新增 TestCase/TestRun/TestStep/Filter/TestReport；`BoardSummary`、`BoardActivity`、`Bug` 加性扩展 |
| `src/core/store.ts` | 新目录、`nextId` 前缀、用例 CRUD、执行记录与副作用、报告聚合、activity 映射、summary 扩展 |
| `src/core/workspace.ts` | 迁移目录列表、`assertCanDeleteRecord`、`projectsStats` 测试计数、`testPolicy`（P2） |
| `src/cli/format.ts` | `formatTestCase` / `formatTestRun` / `formatTestReport` |
| `src/cli/index.ts` | `test` 命令组（8 个子命令） |
| `src/mcp/tools.ts` | 8 个新工具 + 枚举 |
| `src/web/server.ts` | 10 个 REST 端点；`startWebServer` 返回 `http.Server`（为可测试性） |
| `public/index.html` | Tests 标签页、执行记录/用例表单、看板徽标、chips、Admin 统计、en/zh i18n |
| `test/testcase.test.ts` | 新增（核心行为） |
| `test/mcp.test.ts` | 工具数 36 + 新工具端到端 |
| `test/workspace.test.ts` | 新权限/删除门禁 |
| `test/web.test.ts` | 新增（可选，取决于 `startWebServer` 返回值改动） |
| `README.md` | 能力表、工具数、数据布局、CLI 参考 |
| `docs/CheatSheet.md` | 测试命令速查（中英） |
| `docs/AGENTS.md` + `docs/AGENTS.zh-CN.md` | 工具表 + Agent 测试闭环 |
| `docs/guides/UserGuide.en.md` + `.zh-CN.md` | 新章节「测试用例与执行记录」、工具数、CLI 参考、数据布局 |
| `docs/WORKFLOW.md` | Agent 工作流增加「跑测试 → 上报 → 自动开单」步骤 |
| `docs/agents/dsh.md` | 「28 tools」→ 36 |
| `package.json` | 版本 0.4.0 |

## 附二：改动文件清单（归档，规格见 §13）

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/core/store.ts` | `.counters.json` 读写；`nextId` 优先读计数器、缺失回退扫目录（§13.6）；`archiveRuns()`；写入成功后的 `archiveIfNeeded()` 门控；读取路径合并热 + 冷 | P0（计数器 + 合并读取）/ P1（归档） |
| `src/core/archive.ts`（新） | 归档判定（单条规则 + 批次锚定）、月包合并去重排序、原子写（`tmp` + `rename`）、`--dry-run`、`--restore`、`index.json` 重建 | P1 |
| `src/core/types.ts` | `TestRunFilter` 增加 `from` / `to` / `includeArchived` / `hotOnly`；新增 `ArchivePolicy`、`ArchiveStatus`、`TestReportFilter` | P0 / P1 |
| `src/core/workspace.ts` | `testPolicy.archive` 读取（工作区默认 + 项目级覆盖）；归档状态汇总给 Admin 页 | P1 |
| `src/cli/index.ts` | `test archive [--dry-run\|--before\|--keep\|--restore\|--reindex]`；`test history --hot-only/--from/--to`；`test report --from/--to/--hot-only`；`config set-test-policy archive.*` | P1 |
| `src/mcp/tools.ts` | `nexplan_test_run_list` / `nexplan_test_report` 增加 `includeArchived` / `from` / `to` / `hotOnly`（**不新增工具，保持 36**） | P1 |
| `public/index.html` | 执行历史「包含归档」开关、报告时间范围、Admin 归档状态面板（热集条数 / 最近评估与归档 / 月包列表与体积 / 立即归档 / 重建索引）+ en/zh i18n | P1 |
| `test/archive.test.ts`（新） | §13.7 全部断言 | P1 |
| `test/testcase.test.ts` | id 计数器、按 id 早退读取、批量上报只产生一次 commit（P0 前置项） | P0 |
| `README.md` + `docs/CheatSheet.md` + `docs/guides/UserGuide.*.md` + `docs/AGENTS*.md` | 归档概念与阈值配置、`--from`/`--to`/`--hot-only` 用法、审计查法（`git show <sha>:…/archive/2025-09.jsonl`） | P1 |
