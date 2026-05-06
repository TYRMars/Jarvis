# Work 编排与自动执行

**状态：** Adopted (v1.0.0) — Phase 0–6 已落地,只剩 Phase 7 (Cloud / Edge
调度) 仍是 Proposed。v1.0.0 在 `Requirement` 上加了 `triage_state` (Approved /
ProposedByAgent / ProposedByScan) + `depends_on` 两个字段,把"agent 自身触发的
任务"与"用户显式批准的任务"在结构上分开,auto loop 只消费 `Approved` 且依赖全
`Done` 的需求。新增 `requirement.{create,update,delete}` 工具让 agent 在普通对
话里就能落库需求 (system prompt 加了"识别 spec → plan.update 预览 →
project.create_or_get → requirement.create" 工作流段),以及 `triage.scan_candidates`
工具用于扫 TODO/FIXME 注释生成候选。Triage 队列在 Web UI `/projects` 看板上以
抽屉形式展示,带 Approve / Reject (要求 reason)。
另外仍补充借鉴 [Multica](https://github.com/multica-ai/multica) 的 AgentProfile /
Activity timeline / 持久化 RequirementRun 三个概念(详见下文 "## 借鉴 Multica
的产品形态")。
后续常驻调度、外部 issue tracker、repo-owned `WORKFLOW.md`、per-issue workspace、
retry/reconcile 的细化方案见
[`symphony-inspired-orchestration.zh-CN.md`](symphony-inspired-orchestration.zh-CN.md)。
**涉及:** 已新增 `crates/harness-requirement/`(原计划名 `harness-work`,因与
`harness_core::Project + Requirement` 模型融合而改名);扩展 `harness-core` 的事件
/工具协作方式但不修改 agent loop 语义;`harness-store` 已增加 Requirement 持久化
+ Doc 持久化,后续增加 `RequirementRunStore + AgentProfileStore + ActivityStore`;
`harness-server` 已暴露 Requirement / Doc API + WS 事件流;`apps/jarvis-web` 已
把 `/projects` 页面改成看板,后续要加运行历史、活动时间线、Agent profile 选择;
后续可与 `harness-cloud` 对接,实现云端调度 Edge Jarvis 执行 Requirement run。

## 背景

Jarvis 已经具备 coding agent 的底座：agent loop、工具注册、审批、计划事件、持久化、
WebSocket/SSE、MCP、文件和 shell 工具、TODO board。下一步的“Work”不应该只是一个
更大的聊天窗口，而应该是一个能把需求拆成可执行单元、隔离上下文、运行验证、记录
进度，并在需要时向人请求判断的工作流层。

其中 TODO board 已经完成初版落地：`harness_core::todo` 定义了长期 backlog 模型，
`harness-store` 提供持久化，`harness_tools::todo` 暴露 `todo.*` 工具，
`harness_server::todos_routes` 提供 REST + WS 广播，Web UI 也有 `TodosRail`。因此
Work 方案不需要重新发明任务入口，而应该把 TODO board 当作已可用的基础层。

在新的整体产品设计中，Work 是 Chat / Work / Doc 三个基础产品入口之一。Coding、
日常办公、资料研究等基础能力都可以进入 Work，但 Work 本身只负责项目、任务、执行、
验证和诊断这些长期推进状态。

参考 GSD 2 的方向，最值得吸收的是它的自动执行状态机、fresh session per unit、
worktree 隔离、上下文 manifest、verification gate、doctor/forensics 和模型路由。
Jarvis 不照搬 GSD 的 TypeScript CLI 或庞大扩展体系，而是把这些思想拆成 Rust crate、
稳定协议和 Web UI 能消费的事件。

核心原则仍然不变：`harness-core` 只拥有 agent loop 和 trait，不理解 Work、Git
策略、云端调度、UI 或具体业务状态。Work 是上层编排。

## 实施进展与术语对齐 (2026-04-30)

本节是给读者的"现状交底"。原 proposal 写于 Work 还没动工之前,实际落地中
为了和已有的 `harness_core::Project` 模型融合,做了几个关键命名调整。后文
仍保留原始的 `WorkProject / WorkUnit / WorkRun` 词汇以便对照阅读,但代码里
是另一套名字。

**已完成阶段:**

| 阶段 | 落地处 | 命中本 proposal 的章节 |
|---|---|---|
| Phase 0 — TODO board | `harness_core::todo` + 5 后端 + `/v1/todos` + `TodosRail` | 已写入 [`persistent-todos.md`](persistent-todos.md) |
| Phase 1 — Work 模型 | `harness_core::requirement::{Requirement, RequirementStatus, RequirementEvent}` + `RequirementStore` + 5 后端 | 见下方 "核心模型" |
| Phase 2 — REST + UI 最小闭环 | `/v1/projects/:id/requirements*` + WS + `/projects` 看板四列 | 见下方 "API 草案" |
| Phase 3 — 手动执行 | `crates/harness-requirement/` (model / manifest / events) + `POST /v1/requirements/:id/runs` mints fresh Conversation | 见下方 "执行模型" |

**关键术语映射(原 proposal → 实际代码):**

| 原 proposal 名字 | 实际代码名字 | 备注 |
|---|---|---|
| `WorkProject` | `Project` (`harness_core::project::Project`) | 复用现有项目模型,不再造一套。Project 同时承载 Conversation、Requirement、Doc 三个产品入口 |
| `WorkUnit` | `Requirement` (`harness_core::requirement::Requirement`) | 字段对齐前端已有的看板模型(`backlog / in_progress / review / done`) |
| `WorkRun` | `RequirementRun` (`harness_requirement::RequirementRun`) | 已定义 + 在 `/runs` 响应里返回,但 **尚未持久化**(见 Phase 3.5 待办) |
| `WorkContextManifest` | `RequirementContextManifest` | `harness_requirement::manifest::build_default_manifest` |
| `VerificationPlan / Result` | `VerificationPlan / VerificationResult` | `harness_requirement::model::*`,**类型定义齐全但执行回路未做**(Phase 4) |
| `WorkEvent` | `RequirementEvent` + `RequirementRunEvent` | 第二个还没在 WS 上发出 |
| `WorkStore` | `RequirementStore` | 不含 Run / Manifest / Verification |
| `harness-work` crate | `harness-requirement` crate | crate 名直白对齐模型名 |

后文章节里 `WorkUnit / WorkRun` 等术语未来 PR 会逐段替换为
`Requirement / RequirementRun`,但本次先保留原文以保留历史脉络。

## 借鉴 Multica 的产品形态

[Multica](https://github.com/multica-ai/multica) 把"Agent 当作真正的同事"
做成了 issue tracker 风格的协作平台。它的核心三件套对 Jarvis Phase 4-6
的"自动模式 + 可诊断"路线有直接帮助。我们**不**抄它的 Postgres + Go +
Next.js 架构(那是 SaaS 思路,与本仓库本地优先冲突),只吸收三个思想:

### 1. AgentProfile — 给 agent 起名字、定义档案

**今天的问题**:`/runs` 创建 conversation 时只能用 server 启动时配置的全局
provider/model。用户没法说"这条 requirement 派给 Alice(Claude Code on
rust) 做"。

**Multica 的形态**:Agent 是命名实体,有 avatar、provider、可被 @mention,
在看板上以 assignee 出现。

**Jarvis 的最小落地**:新增 `AgentProfile` 值类型 + `AgentProfileStore`,
让用户在设置页定义多个命名 agent;Requirement 加 `assignee_id` 字段;
`/runs` 读 assignee 的 provider/model/system_prompt 来构建 Conversation。
**这是 Phase 6 受限自动模式的天然载体** — auto loop 选 Ready unit 时,只
按它指定的 agent 派发。

数据模型(详见 "核心模型 v2" 一节):

```rust
pub struct AgentProfile {
    pub id: String,                       // UUID v4
    pub name: String,                     // "Alice", "Rust Reviewer"
    pub avatar: Option<String>,           // 表情 / 颜色 / URL
    pub provider: String,                 // "codex" / "anthropic" / "openai" / ...
    pub model: String,                    // 具体 model id
    pub system_prompt: Option<String>,    // 可选,覆盖全局 coding prompt
    pub default_workspace: Option<String>,// 可选,新会话默认绑这个 workspace
    pub allowed_tools: Vec<String>,       // 显式 allowlist;空 = 用 server 默认
    pub created_at: String,
    pub updated_at: String,
}
```

REST: `GET / POST / PATCH / DELETE /v1/agent-profiles`,WS 事件
`agent_profile_upserted / agent_profile_deleted`。

### 2. Activity timeline — 卡片完整审计流

**今天的问题**:看板卡片只有当下 status,没法回答"这卡片是什么时候被
谁从 in_progress 拖到 review 的"、"它跑了几次 run、verification 结果"。
诊断 / forensics(原 Phase 5)几乎无据可查。

**Multica 的形态**:每张 issue 有一条 activity stream:status_change /
comment / run_started / run_finished / blocker / commit。

**Jarvis 的最小落地**:新增 `Activity` 值类型 + `ActivityStore`,在所有
现有 mutation 处发 activity 行(REST handler 自己写,无需 agent 参与)。
WS 帧 `activity_appended` 推到看板卡片详情页。

```rust
pub struct Activity {
    pub id: String,
    pub requirement_id: String,
    pub kind: ActivityKind,
    pub actor: ActivityActor,
    pub body: serde_json::Value,   // 自由 payload (status from→to / run id / comment text / verification status)
    pub created_at: String,
}

pub enum ActivityKind {
    StatusChange,
    AssigneeChange,
    Comment,
    RunStarted,
    RunFinished,
    VerificationFinished,
    Blocked,
    Unblocked,
}

pub enum ActivityActor {
    Human,                          // v0:全部记成 "human" 即可
    Agent { profile_id: String },   // 由 agent 触发的(比如 requirement.* 工具)
    System,                         // server 自身的状态推进(Backlog→InProgress)
}
```

这一笔做完,**Phase 5 的 doctor / forensics 几乎免费实现** — 时间线天然
是审计流。

### 3. 持久化 RequirementRun + WS 推送

**今天的问题**:`/runs` 返回的 `RequirementRun` 在响应里出现一次后就丢了。
看板上"几次 sessions"是从 `Requirement.conversation_ids.length` 推断的,
看不到 run 的 summary、started_at、finished_at、error、verification 结果。

**Multica 的形态**:每次 task lifecycle (enqueue → claim → start →
complete/fail) 都有持久行,UI 可回看。

**Jarvis 的最小落地**:把已有的 `RequirementRun` 类型挂到新 trait
`RequirementRunStore`(5 后端,模板与 `RequirementStore` 一致),把已有
`RequirementRunEvent::{Started, Finished, Verified}` 接到 WS bridge,看板
卡片下展开"Run #N · started 12:34 · verification: passed" 列表。

这是 Phase 3 的尾巴,**也是 Phase 4 verification gate 执行回路的载体**
(verification 结果要写进 run 的 `verification` 字段)。

### 不该照抄的

- **Postgres + pgvector 重栈**:Multica 是云优先,Jarvis 是本地优先(默认 JSON 文件)。
- **多租户 + roles**:v0 是单用户/小团队,延后。
- **Cloud SaaS 强绑定**:我们仍然以本地 binary + 可选云端 dispatch 为主。

## 目标

1. **把 Work 做成一等对象。**
   明确 Project、Milestone、Slice、Task、Run、Artifact、Verification 的模型，而不是
   只靠对话历史和自然语言计划。

2. **每个执行单元使用干净上下文。**
   一个 Work unit 对应一次独立 agent run，由系统注入精确上下文，避免长会话上下文
   膨胀和历史污染。

3. **完成标准可验证。**
   Work unit 完成后必须产出验证结果：测试、lint、diff 摘要、人工确认或明确的
   blocked 原因。

4. **默认安全。**
   自动执行不默认写主工作区；高风险操作仍走审批；长任务和自动模式必须能暂停、恢复、
   诊断。

5. **复用已实现的 TODO board。**
   `todo.*` 是现成的轻量 backlog；Work 是结构化执行层。TODO 可以升级成 Work task，
   Work 也可以产出 follow-up TODO。

6. **为端云协同预留接口。**
   本地 Work 先跑通；后续 Cloud Jarvis 可以把 Work unit 派发到 Edge Jarvis。

非目标：

- 不在 v0 实现完整项目管理系统；
- 不替代 GitHub Issues、Linear、Jira；
- 不默认全自动 commit / push / PR；
- 不把复杂调度逻辑塞进 `harness-core`；
- 不第一版就实现多 agent 并行编排。

## 包边界

新增 crate：

```text
crates/
  harness-work/
    src/
      lib.rs
      model.rs             # WorkProject, WorkUnit, Milestone, Slice, Task
      engine.rs            # WorkEngine 状态推进
      manifest.rs          # WorkContextManifest
      dispatcher.rs        # unit -> Agent run
      verification.rs      # 验证计划与结果
      worktree.rs          # 后续：Git worktree 生命周期
      scheduler.rs         # 后续：队列与依赖调度
      policy.rs            # 自动执行权限与风险控制
      events.rs            # WorkEvent
      store.rs             # WorkStore trait
      diagnostics.rs       # doctor / forensics 数据模型
```

依赖方向：

- `harness-work` 可以依赖 `harness-core` 的 `Agent`、`Conversation`、`ToolRegistry`、
  `Approver`、`Memory`、`BoxError`；
- `harness-work` 可以依赖 `serde` / `tokio` / `async-trait`；
- `harness-work` 不读 `std::env`；
- `harness-work` 不依赖 `harness-server`、Web UI 或具体云厂商；
- Work 的 HTTP/WS wiring 在 `harness-server`；
- Work 的 env/config wiring 在 `apps/jarvis`。

## 核心模型

```rust
pub struct WorkProject {
    pub id: String,
    pub workspace: String,
    pub title: String,
    pub status: WorkStatus,
    pub created_at: String,
    pub updated_at: String,
}

pub struct WorkUnit {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub kind: WorkUnitKind,
    pub title: String,
    pub description: Option<String>,
    pub status: WorkStatus,
    pub priority: WorkPriority,
    pub dependencies: Vec<String>,
    pub assigned_node: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub enum WorkUnitKind {
    Milestone,
    Slice,
    Task,
    Verification,
    FollowUp,
}

pub enum WorkStatus {
    Pending,
    Ready,
    InProgress,
    Blocked,
    NeedsReview,
    Completed,
    Failed,
    Cancelled,
}
```

状态机：

```text
Pending -> Ready -> InProgress -> NeedsReview -> Completed
                         |              |
                         v              v
                      Blocked         Failed
                         |
                         v
                       Ready
```

说明：

- `Pending`：已创建，但依赖或上下文未满足；
- `Ready`：可以执行；
- `InProgress`：正在执行；
- `NeedsReview`：执行完成，但需要人确认或合并；
- `Completed`：验证通过且结果被接受；
- `Blocked`：缺少信息、权限、依赖或外部资源；
- `Failed`：验证失败或执行失败，等待重试/人工处理；
- `Cancelled`：放弃。

## TODO 与 Work 的关系

现有 `TodoItem` 已经实现并接入 store、tools、REST、WS 和 Web UI。它保持轻量，不
强行升级成复杂 issue。Work 在它上面扩展：

```text
TodoItem
  - 人和 agent 都能快速记下一条事
  - 适合轻量 backlog / follow-up
  - 可以没有验收标准
  - 已经有 todo.list / todo.add / todo.update / todo.delete
  - 已经有 /v1/todos REST API 和 WebSocket 更新事件

WorkUnit
  - 有依赖、状态机、上下文 manifest、执行 run、验证结果
  - 适合可执行任务、自动模式、长流程
  - 可以由 TodoItem 转化而来
```

落地策略：

- 不迁移或替换现有 TODO 数据；
- Work v0 只增加 `todo_id -> work_unit_id` 的关联能力；
- `TodosRail` 继续作为轻量 backlog 面板存在；
- Work 页面可以内嵌 TODO 视图，但不把 TODO 变成 Work 的子表；
- agent 仍可用 `todo.*` 记录 follow-up，Work 引擎再决定是否升级成可执行 unit。

建议 API：

```text
POST /v1/work/from-todo/:todo_id
POST /v1/work/units/:id/create-follow-up-todo
```

工具侧：

| 工具 | 作用 |
|---|---|
| `work.list` | 列出当前 workspace 的 Work projects / units |
| `work.create` | 创建 project 或 task |
| `work.update` | 更新状态、描述、依赖 |
| `work.start` | 启动一个 unit 的执行 run |
| `work.block` | 标记 blocked 并写明原因 |
| `work.complete` | 记录完成摘要和验证结果 |

这些工具默认是 metadata mutation，类似 `todo.*`，但 `work.start` 可能触发实际执行，应该
受 Work policy 控制。

## WorkContextManifest

GSD 2 最值得借鉴的设计之一是 typed manifest：每次派发任务前，系统先构建一个明确的
上下文包，而不是让模型在仓库里漫游。

```rust
pub struct WorkContextManifest {
    pub unit_id: String,
    pub workspace: String,
    pub goal: String,
    pub instructions: Vec<ContextRef>,
    pub files: Vec<ContextRef>,
    pub symbols: Vec<SymbolRef>,
    pub prior_runs: Vec<RunRef>,
    pub todos: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub verification: VerificationPlan,
    pub constraints: Vec<String>,
}
```

示例 JSON：

```json
{
  "unit_id": "task_123",
  "goal": "为 TODO board 添加按 priority 排序",
  "instructions": [
    {"kind": "file", "path": "AGENTS.md"},
    {"kind": "file", "path": "docs/proposals/persistent-todos.md"}
  ],
  "files": [
    {"kind": "file", "path": "crates/harness-core/src/todo.rs"},
    {"kind": "file", "path": "apps/jarvis-web/src/components/Workspace/TodosRail.tsx"}
  ],
  "allowed_tools": ["fs.read", "fs.patch", "git.diff", "cargo.test"],
  "verification": {
    "commands": [
      "cargo test -p harness-core todo::",
      "npm --prefix apps/jarvis-web test -- --run"
    ]
  }
}
```

manifest 构建来源：

- `AGENTS.md` / `CLAUDE.md` / project docs；
- Work unit 描述；
- TODO board；
- Git status / diff；
- 最近失败验证；
- 用户显式选择的文件；
- 后续可接 LSP、ripgrep、代码索引、memory。

v0 不需要复杂 relevance ranking。先支持显式文件 + instruction files + Git 状态 + TODO。

## 执行模型

每个 Work unit 执行一次 `WorkRun`：

```rust
pub struct WorkRun {
    pub id: String,
    pub unit_id: String,
    pub status: WorkRunStatus,
    pub manifest: WorkContextManifest,
    pub conversation_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
}
```

执行流程：

```text
1. Load unit + project state
2. Check dependencies and policy
3. Build WorkContextManifest
4. Create fresh Conversation
5. Prepend system prompt + manifest summary
6. Run Agent::run_stream
7. Capture events and artifacts
8. Run verification gate
9. Update unit status
10. Emit WorkEvent
```

为什么 fresh session：

- 上下文更小；
- 任务目标更明确；
- 更容易重试；
- 更容易做 cost / token 统计；
- 失败不会污染长期对话。

## Verification Gate

完成不能只靠模型自述。每个 Work unit 可以带一个验证计划：

```rust
pub struct VerificationPlan {
    pub commands: Vec<VerificationCommand>,
    pub require_diff: bool,
    pub require_tests: bool,
    pub require_human_review: bool,
}

pub struct VerificationResult {
    pub status: VerificationStatus,
    pub command_results: Vec<CommandResult>,
    pub diff_summary: Option<String>,
    pub notes: Option<String>,
}
```

最小规则：

- 没有代码变更的 unit 可以只要求摘要；
- 有代码变更的 unit 默认要求 `git.diff --stat`；
- 如果 manifest 指定测试命令，必须执行并记录结果；
- 验证失败时 unit 进入 `Failed` 或回到 `Ready` 以便重试；
- 需要用户判断时进入 `NeedsReview`。

验证命令应该走现有审批/权限体系。自动模式不能绕开危险命令。

## Worktree 隔离

v0 可以先在当前 workspace 执行；v1 引入可选 worktree 模式：

```env
JARVIS_WORKTREE_MODE=off | per_run | per_unit
JARVIS_WORKTREE_ROOT=.jarvis/worktrees
```

策略：

- `off`：开发期默认，直接在当前 workspace 执行；
- `per_run`：每次 WorkRun 创建独立 worktree；
- `per_unit`：同一 WorkUnit 多次重试复用 worktree。

安全要求：

- 创建前检查主工作区 dirty 状态；
- 不自动覆盖用户未提交改动；
- worktree 生命周期写审计事件；
- 合并前必须展示 diff；
- 自动合并默认关闭；
- 孤儿 worktree 可被 doctor 检出。

## WorkEvent

Work 事件通过 HTTP/WS/SSE 给 UI 和未来云端控制面消费：

```rust
pub enum WorkEvent {
    ProjectUpserted(WorkProject),
    UnitUpserted(WorkUnit),
    UnitDeleted { project_id: String, unit_id: String },
    RunStarted(WorkRun),
    RunDelta { run_id: String, content: String },
    RunFinished(WorkRun),
    VerificationStarted { run_id: String },
    VerificationFinished { run_id: String, result: VerificationResult },
    Blocked { unit_id: String, reason: String },
    NeedsReview { unit_id: String, summary: String },
}
```

不要把 WorkEvent 混进 `AgentEvent` 成为 agent loop 的责任。`harness-server` 可以把同一
socket 上的 agent events 和 work events 做 envelope 复用：

```json
{"type":"work_event","event":{...}}
{"type":"agent_event","event":{...}}
```

## Store

新增 `WorkStore`：

```rust
#[async_trait]
pub trait WorkStore: Send + Sync {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<WorkProject>>;
    async fn get_project(&self, id: &str) -> Result<Option<WorkProject>>;
    async fn upsert_project(&self, project: &WorkProject) -> Result<()>;

    async fn list_units(&self, project_id: &str) -> Result<Vec<WorkUnit>>;
    async fn get_unit(&self, id: &str) -> Result<Option<WorkUnit>>;
    async fn upsert_unit(&self, unit: &WorkUnit) -> Result<()>;

    async fn list_runs(&self, unit_id: &str) -> Result<Vec<WorkRun>>;
    async fn upsert_run(&self, run: &WorkRun) -> Result<()>;

    fn subscribe(&self) -> broadcast::Receiver<WorkEvent>;
}
```

SQL 表草案：

```text
work_projects(id, workspace, title, status, created_at, updated_at)
work_units(id, project_id, parent_id, kind, title, description,
           status, priority, dependencies_json, assigned_node,
           created_at, updated_at)
work_runs(id, unit_id, status, manifest_json, conversation_id,
          started_at, finished_at, summary, error)
work_verifications(id, run_id, status, plan_json, result_json, created_at)
work_artifacts(id, run_id, kind, uri, metadata_json, created_at)
```

先支持 memory + sqlite + json-file；Postgres/MySQL 跟随 `harness-store` 现有模式补齐。

## API 草案

```text
GET    /v1/work/projects?workspace=<abs>
POST   /v1/work/projects
GET    /v1/work/projects/:id
PATCH  /v1/work/projects/:id

GET    /v1/work/projects/:id/units
POST   /v1/work/projects/:id/units
GET    /v1/work/units/:id
PATCH  /v1/work/units/:id

POST   /v1/work/units/:id/start
POST   /v1/work/units/:id/block
POST   /v1/work/units/:id/complete
GET    /v1/work/units/:id/runs
GET    /v1/work/runs/:id
POST   /v1/work/runs/:id/cancel

POST   /v1/work/from-todo/:todo_id
GET    /v1/work/events
```

WebSocket 可以复用现有聊天 socket，也可以后续新增 `/v1/work/ws`。v0 建议复用，避免
前端同时维护多条连接。

## Web UI

第一版 Work 页面不要做成复杂项目管理工具。建议三个区域：

```text
左侧：Project / Milestone / Slice / Task 树
中间：当前 unit 的目标、manifest、运行日志、验证结果
右侧：TODO、Plan、Diff、Review / Blocker
```

最小功能：

- 从 TODO 创建 Work task；
- 创建/编辑 Work unit；
- 点击 Start 触发执行；
- 展示 run stream；
- 展示验证命令和结果；
- 标记 blocked / needs review / completed；
- 查看最近失败原因。

后续增强：

- milestone 进度条；
- dependency graph；
- worktree 状态；
- cost/token；
- cloud/edge 执行节点；
- doctor/forensics 页面。

## 自动模式

v0 不做“无人值守完成整个 milestone”。先做手动 start：

```text
用户选择 unit -> Start -> Jarvis 执行 -> 验证 -> 用户确认
```

v1 再做受限 auto：

```text
自动选择 Ready unit
执行一个 unit
验证
若成功进入 NeedsReview 或 Completed
若失败最多重试 N 次
遇到审批/问题/高风险则暂停
```

配置：

```env
JARVIS_WORK_MODE=off | manual | auto
JARVIS_WORK_AUTO_MAX_UNITS=1
JARVIS_WORK_AUTO_MAX_RETRIES=1
JARVIS_WORK_REQUIRE_REVIEW=1
```

## 模型路由

后续可以参考 GSD 的 complexity routing，但 v0 只记录元数据：

```rust
pub enum WorkComplexity {
    Light,
    Standard,
    Heavy,
}
```

路由信号：

- 预计修改文件数；
- 是否需要跨模块理解；
- 是否涉及数据库/安全/云资源；
- 最近失败次数；
- 用户指定 priority。

先记录，不自动换模型。等 WorkRun 数据积累后再做 provider/model selection。

## 云端协同

Work 与 `harness-cloud` 的关系：

```text
Cloud Jarvis
  - 存 WorkProject / WorkUnit / WorkRun
  - 选择执行节点
  - 收集事件、验证结果、artifact

Edge Jarvis
  - 接收 WorkRun
  - 在本地 workspace 或 worktree 执行
  - 回传 agent events / verification / diff
```

WorkUnit 增加 `assigned_node`，Cloud 可以根据 label 路由：

```toml
[[work.routes]]
workspace = "/repo"
node_selector = { labels = ["mac", "trusted"] }
allowed_tools = ["fs.read", "fs.patch", "git.diff", "cargo.test"]
```

v0 只本地执行；Cloud dispatch 是后续阶段。

## 迭代计划

### Phase 0：TODO board 基础层（已实现）

- `TodoItem` / `TodoStatus` / `TodoPriority` 模型；
- `TodoStore` 与 memory / json-file / sqlite / postgres / mysql 后端；
- `todo.list` / `todo.add` / `todo.update` / `todo.delete` 工具；
- `/v1/todos` REST API；
- WS `todo_upserted` / `todo_deleted` 事件；
- Web UI `TodosRail`；
- proposal：`docs/proposals/persistent-todos.md`。

### Phase 1：Work 方案与本地模型

- 新增本 proposal；
- 新增 `harness-work` crate 骨架；
- 定义 WorkProject / WorkUnit / WorkRun / Verification 类型；
- memory store + 单元测试；
- 不接 UI，不自动执行。

### Phase 2：REST + Web UI 最小闭环

- `harness-server` 暴露 Work CRUD；
- Web UI 新增 Work panel；
- 支持从 TODO 创建 Work task；
- 支持手动更新状态；
- 支持 WS 广播 WorkEvent。

### Phase 3：WorkRun 手动执行(已落地)

- `work.start` / REST `POST /start`(实际是 `POST /v1/requirements/:id/runs`);
- 构建最小 WorkContextManifest(实际 `RequirementContextManifest`);
- fresh Conversation 执行一次 agent run(`/runs` mints conversation,挂到
  ConversationStore + 把 conversation_id append 回 `Requirement.conversation_ids`);
- 保存 run summary 和 conversation id;
- 展示实时 stream(WS `agent_event` + 现有 chat 通道复用)。

### Phase 3.5:RequirementRun 持久化 + WS(新增 — Multica 启发)

- `harness_core::store::RequirementRunStore` trait + 5 后端(模板复用 RequirementStore);
- `RequirementRun.summary / error / verification / finished_at` 落库;
- WS 帧 `requirement_run_started / requirement_run_finished / requirement_run_verified`;
- 看板卡片详情页展示最近 N 次 run。

### Phase 3.6:AgentProfile + Requirement.assignee_id(新增 — Multica 启发)

- `AgentProfile` + `AgentProfileStore`(5 后端);
- `Requirement.assignee_id: Option<String>` 字段(向后兼容,`#[serde(skip_serializing_if = "Option::is_none")]`);
- `/v1/agent-profiles*` REST + `agent_profile_upserted/deleted` WS;
- `/runs` 读 assignee 的 provider/model/system_prompt 来构建 Conversation;
- 设置页"Agents" tab 管理多个命名 agent;看板卡片下拉 picker。

### Phase 3.7:Activity timeline(新增 — Multica 启发)

- `Activity` + `ActivityStore`(5 后端);
- 在所有现有 mutation 处发 activity:`status_change` /
  `assignee_change` / `run_started` / `run_finished` / `verification_finished` /
  `blocked / unblocked` / `comment`;
- WS 帧 `activity_appended`;
- 看板卡片右侧抽屉显示完整时间线。

### Phase 4：Verification Gate (已落地)

- 支持验证命令(走现有 `shell.exec` + 审批门);
- 把 stdout / stderr / exit_code / duration 写回 `RequirementRun.verification`(依赖 Phase 3.5);
- 失败进入 `Failed`;成功进入 `NeedsReview` 或 `Completed`;
- 同步发 `verification_finished` activity(依赖 Phase 3.7);
- UI 展示 diff/test/check;
- 新增 `requirement.*` agent 工具(`requirement.list / start / block / complete /
  create / update / delete`)让 agent 自己能驱动看板状态(`create/update/delete`
  在 v1.0.0 加入,见下方 v1.0.0 章节)。

实际落地:`harness-server::verification` 模块 +
`POST /v1/runs/:id/verify`。`apply_verification` 复用同一条 fan-out (Activity /
WS 帧 / 终态翻转),手动 `POST /verification` 与自动验证走同一段代码。

### Phase 5：Worktree 与诊断 (已落地)

- 可选 per-run worktree;
- doctor 检查孤儿 worktree、未合并变更、失败 run — **底层数据来自
  Phase 3.5 的 `RequirementRunStore` + Phase 3.7 的 `ActivityStore`**,无需
  额外采集;
- 合并前展示 diff;
- 默认不自动合并。

实际落地:`harness-server::worktree` 模块 + `harness-server::diagnostics` 模块 +
REST `/v1/diagnostics/worktrees/orphans{,/cleanup}` /
`/v1/diagnostics/runs/{stuck,failed}` /
`DELETE /v1/runs/:id/worktree`。诊断只读;cleanup 与 remove 走显式 POST/DELETE,
不会被 auto loop 自动触发。

### Phase 6：受限 Auto Mode (已落地)

- 自动推进一个 Ready unit(**前置依赖 Phase 3.6 的 AgentProfile** —
  auto loop 必须明确"派给哪个 agent");
- v1.0.0 起额外要求 `triage_state == Approved` 和 `depends_on` 全部 `Done`(
  防止 agent 自己创建的需求被 auto loop 默默吃掉);
- 最大重试次数;
- 遇到审批、高风险、blocked 自动暂停,在 timeline 写明原因;
- 记录 cost/token/耗时(写进 RequirementRun)。

实际落地:`harness-server::auto_mode` 模块 + 环境变量 `JARVIS_WORK_MODE=auto` /
`JARVIS_WORK_TICK_SECONDS` / `JARVIS_WORK_MAX_UNITS_PER_TICK` /
`JARVIS_WORK_MAX_RETRIES` / `JARVIS_WORK_RUN_TIMEOUT_MS`。Off by default;binary
unconditional 调用 `spawn_auto_mode`,`Off` mode no-op。

### Phase 6.5:Spec → Project 拆解 (v1.0.0 新增)

v1.0.0 的核心目标:让 Jarvis 能根据 **spec → 自动建立 project / 规划
requirement / 逐项执行 / 验证回报**。Spec 不是专门的文档格式,可能是用户的一句
话、一份让 Jarvis 读的文档,或 Jarvis 自己巡检发现的候选。所以 v1.0 不做
`spec.import` 这种"专门 parser",而是补齐已有原语:

- 新增 `Requirement.triage_state: TriageState`
  (`Approved` / `ProposedByAgent` / `ProposedByScan`),`#[serde(default,
  skip_serializing_if = "is_default")]` 兼容旧数据。
- 新增 `Requirement.depends_on: Vec<String>` 用于 auto loop 的拓扑序选取。
- 新增 agent 工具 `requirement.create / update / delete`
  (`harness-tools::requirement`):agent 在普通对话里就能落库。`create` 默认
  `triage_state=ProposedByAgent`,要 agent 显式传 `approved` 才直接进 board;
  `delete` 是写操作里唯一 approval-gated 的(`update` 不是 — 通过审计行恢复)。
- 新增 agent 工具 `triage.scan_candidates` (`harness-tools::triage_scan`):
  扫 workspace 的 TODO / FIXME / XXX / HACK 注释 + 后续可加 `failed_runs` /
  `orphan_worktrees`,返回结构化候选清单,**不直接落库** — 由 agent 决定
  `requirement.create(triage_state=ProposedByScan)`。
- 系统 prompt 段(`apps/jarvis/src/serve.rs::CODING_SYSTEM_PROMPT`):教 LLM
  "用户描述需求 / 让你读 doc 拆解" → workspace.context → fs.read →
  plan.update 预览 → project.create_or_get → requirement.create 循环。
- REST: 给 `GET /v1/projects/:id/requirements` 加 `?triage_state=approved|
  proposed_by_*|proposed` filter; 新增 `POST /v1/requirements/:id/approve`
  (idempotent) 和 `POST /v1/requirements/:id/reject` (要求 `reason`,写
  Activity 后软删)。
- Web UI:`ProjectBoard` 在看板列上方加 "Triage drawer",列出
  `proposed_by_*` 候选,带 Approve / Reject(prompt 输入 reason)按钮。
  Backlog 列只展示 `Approved` 行,所以 board count 不再被巡检候选污染。
- Auto loop:`harness-server::auto_mode::tick` 增加两条 `continue` 守卫
  — `triage_state != Approved` 跳过;`depends_on` 任一项不在 `Done`
  跳过(O(1) per-dep,基于本 project 的 status 快照)。新增的两条
  `tick_*` 测试覆盖这两条路径。

### Phase 7：Cloud / Edge 调度

- Cloud 选择 Edge 节点；
- Edge 执行 WorkRun；
- 回传事件和 artifacts；
- 支持断线恢复。

## 风险与取舍

- **Work 太像项目管理工具。**
  v0 只做 agent 执行需要的最小模型，不做看板、评论、附件、复杂权限。

- **自动模式误改代码。**
  v0 只手动 start；写操作仍走审批；worktree 隔离后再扩大自动化。

- **状态重复：TODO、Plan、Work 三套概念。**
  三者职责不同：Plan 是本轮步骤，TODO 是长期轻量 backlog，Work 是可执行任务流。

- **上下文 manifest 构建过复杂。**
  v0 只支持显式文件和基础项目说明；复杂 relevance ranking 后置。

- **与云端方案耦合过早。**
  Work 先本地闭环，Cloud 只作为后续 dispatch backend。

## 验收标准

MVP 完成时应满足：

- `cargo check --workspace` 通过；
- 可以创建 Work project 和 Work task；
- 可以从 TODO 创建 Work task；
- Web UI 能显示 Work unit 状态；
- 点击 Start 能产生一次 WorkRun；
- WorkRun 使用 fresh Conversation；
- 运行结果、摘要、错误能持久化；
- 至少一个验证命令可以被执行并记录；
- Work 事件能通过 WS 推送到 UI；
- 不启用 auto 时不会自行修改文件；
- 高风险操作仍遵守现有审批规则。

## 参考

- GSD 2: https://github.com/gsd-build/gsd-2
- GSD 2 Architecture Overview: https://github.com/gsd-build/gsd-2/blob/main/docs/dev/architecture.md
- **Multica** (Agent-as-teammate platform): https://github.com/multica-ai/multica
  — 借鉴 AgentProfile / Activity timeline / 持久化 Run 三个产品形态,见
  上方 "## 借鉴 Multica 的产品形态" 一节。
- Jarvis product design: `docs/proposals/product-design.md` /
  `docs/proposals/product-design.zh-CN.md`
- Jarvis persistent TODO board: `docs/proposals/persistent-todos.md`
- Jarvis cloud capabilities: `docs/proposals/cloud-capabilities.zh-CN.md`
