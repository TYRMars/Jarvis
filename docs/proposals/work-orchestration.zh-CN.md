# Work 编排与自动执行

**状态：** Proposed
**涉及：** 新增 `crates/harness-work/`；扩展 `harness-core` 的事件/工具协作方式但不修改
agent loop 语义；`harness-store` 增加 Work 持久化；`harness-server` 增加 Work API 与
事件流；`apps/jarvis-web` 增加 Work 页面、任务轨道、验证结果和诊断视图；后续可与
`harness-cloud` 对接，实现云端调度 Edge Jarvis 执行 Work unit。

## 背景

Jarvis 已经具备 coding agent 的底座：agent loop、工具注册、审批、计划事件、持久化、
WebSocket/SSE、MCP、文件和 shell 工具、TODO board。下一步的“Work”不应该只是一个
更大的聊天窗口，而应该是一个能把需求拆成可执行单元、隔离上下文、运行验证、记录
进度，并在需要时向人请求判断的工作流层。

参考 GSD 2 的方向，最值得吸收的是它的自动执行状态机、fresh session per unit、
worktree 隔离、上下文 manifest、verification gate、doctor/forensics 和模型路由。
Jarvis 不照搬 GSD 的 TypeScript CLI 或庞大扩展体系，而是把这些思想拆成 Rust crate、
稳定协议和 Web UI 能消费的事件。

核心原则仍然不变：`harness-core` 只拥有 agent loop 和 trait，不理解 Work、Git
策略、云端调度、UI 或具体业务状态。Work 是上层编排。

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

5. **和 TODO board 衔接。**
   `todo.*` 是轻量 backlog；Work 是结构化执行层。TODO 可以升级成 Work task，Work
   也可以产出 follow-up TODO。

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

现有 `TodoItem` 保持轻量，不强行升级成复杂 issue。Work 在它上面扩展：

```text
TodoItem
  - 人和 agent 都能快速记下一条事
  - 适合轻量 backlog / follow-up
  - 可以没有验收标准

WorkUnit
  - 有依赖、状态机、上下文 manifest、执行 run、验证结果
  - 适合可执行任务、自动模式、长流程
  - 可以由 TodoItem 转化而来
```

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

### Phase 3：WorkRun 手动执行

- `work.start` / REST `POST /start`；
- 构建最小 WorkContextManifest；
- fresh Conversation 执行一次 agent run；
- 保存 run summary 和 conversation id；
- 展示实时 stream。

### Phase 4：Verification Gate

- 支持验证命令；
- 保存 VerificationResult；
- 失败进入 `Failed`；
- 成功进入 `NeedsReview` 或 `Completed`；
- UI 展示 diff/test/check。

### Phase 5：Worktree 与诊断

- 可选 per-run worktree；
- doctor 检查孤儿 worktree、未合并变更、失败 run；
- 合并前展示 diff；
- 默认不自动合并。

### Phase 6：受限 Auto Mode

- 自动推进一个 Ready unit；
- 最大重试次数；
- 遇到审批、高风险、blocked 自动暂停；
- 记录 cost/token/耗时。

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
- Jarvis persistent TODO board: `docs/proposals/persistent-todos.md`
- Jarvis cloud capabilities: `docs/proposals/cloud-capabilities.zh-CN.md`
