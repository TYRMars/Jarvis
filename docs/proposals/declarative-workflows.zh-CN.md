# 声明式 Workflow（多步 Agent 编排，绑定 Requirement）

**Status:** Adopted (v1) — `harness-workflow` crate、JSON/内存存储、`/v1/workflows`
REST、`workflow_runtime` 执行器、auto-loop 分支与 Web UI 均已落地。
**Source:** 受 Claude Code 的 `Workflow` 工具启发（`agent()` / `pipeline()` /
`parallel()` / `phase()` 原语），把"一次性单轮 agent 运行"升级为"可复用的多步配方"。
**Touches:** 新增 `crates/harness-workflow/`（值类型 + `WorkflowStore` trait）；
`harness-store` 增加 `JsonFileWorkflowStore` / `MemoryWorkflowStore` + `connect_workflows`；
`harness-project::Requirement` 增加 `workflow_id` 软引用字段；`harness-server` 增加
`workflow_routes` + `workflow_runtime`，并在 `auto_mode::drive_one_with_prompt` 分支；
`apps/jarvis` 在组合根用 `connect_workflows` + `with_workflows` 接线；`apps/jarvis-web`
增加 `services/workflows.ts`、Settings → Workflows 目录页与 Requirement 详情的绑定 + 运行时间线。
`harness-core` 的 agent loop 语义不变。

## 背景

Jarvis 已经有执行底座（agent loop、subagent 注册表 + `SubAgentBatchTool` 扇出、
`RequirementRun`、worktree、verification、`Activity` 时间线），以及"单提示"的 per-
requirement 运行（`auto_mode::drive_one_with_prompt` + 从 `WORKFLOW.md` 读出的
`workflow_prompt` 字符串模板）。缺的是**结构化、可复用、多步**的编排：用户定义一次，
**绑定到某个 Requirement**，于是"推进该需求"就运行整套配方（research → implement →
verify），而不是一轮笼统的 agent 对话。

## 与既有概念的命名澄清

- `WORKFLOW.md` / `AutoModeConfig.workflow_prompt`：是**调度器种子提示**（字符串模板），
  属于 [`symphony-inspired-orchestration.zh-CN.md`](symphony-inspired-orchestration.zh-CN.md)
  设想的常驻调度层。本提案的 `WorkflowDefinition` 是它的**结构化演进**：把单字符串升级为
  有序的、可嵌套的步骤树。两者互补，不冲突。
- `RequirementTodoCreator::Workflow`：是既有枚举值（标记系统生成的执行清单项），与本
  提案的 `WorkflowDefinition` 无关，名字复用但语义独立。

## 目标

1. **声明式、可复用的多步配方。** `WorkflowDefinition` = 有序 `WorkflowStep` 树。
2. **绑定 Requirement。** `Requirement.workflow_id` 软引用；绑定后手动/auto 执行都跑配方。
3. **复用既有执行机制，而非新造。** 执行器在 server 层直接驱动 `Agent::run`，复用
   manifest builder、worktree、`RequirementRun`/`Activity`。
4. **本地优先、安全默认。** 执行器在 server/runtime 层调用（不作为 agent 可见工具），
   绕开 v1.0 的 subagent 递归禁令；写盘/执行仍受现有 permission/approval 约束。

## 非目标

- 不在服务端跑任意 JS（Claude Code 的脚本引擎）。改用声明式数据模型。
- 第一版不实现 structured-output schema、token budget、resume（数据模型留好扩展位
  `output_key` 做 handoff，不预先承诺这些）。
- 不改 `harness-core` 的 agent loop。

## 术语映射（Claude Code → Jarvis）

| Claude Code | Jarvis |
|---|---|
| `agent(prompt, …)` | `WorkflowStepKind::Agent { prompt, subagent?, model?, output_key? }` |
| `pipeline(…)` | `WorkflowStepKind::Pipeline { steps }`（顺序，输出经 `{{ prev }}` 前递） |
| `phase(title)` | `WorkflowStepKind::Phase { title, steps }`（带标签的顺序组） |
| `parallel([…])` | `WorkflowStepKind::Parallel { steps, join }`（并发 + `JoinPolicy`） |
| 结构化 handoff | `output_key` + `{{ outputs.<key> }}` 模板插值 |
| 一次 run | `WorkflowRun`（每个叶子步骤一条 `WorkflowStepResult`） |

## 数据模型（`crates/harness-workflow`）

- `WorkflowDefinition { id, project_id?, name, description?, steps, created_at, updated_at }`
- `WorkflowStep { id, name, kind }`
- `WorkflowStepKind`（`#[serde(tag="type")]`）：`Agent` / `Pipeline` / `Phase` / `Parallel`
- `JoinPolicy`：`AllRequired`（默认）/ `BestEffort`
- `WorkflowRun { id, workflow_id, requirement_id?, status, step_results, error?, started_at, finished_at? }`
- `WorkflowStepResult { step_id, name, status, conversation_id?, output?, error? }`
- `WorkflowRunStatus`：`Pending` / `Running` / `Succeeded` / `Failed` / `Cancelled`
- `WorkflowStore` trait：定义 CRUD + 运行 `list_runs/get_run/upsert_run`

值类型都派生 `ts_rs::TS`（owning crate，不放 `harness-core`），生成的 TS 在
`apps/jarvis-web/src/types/generated/`。

## 执行器（`harness-server/src/workflow_runtime.rs`）

`drive_workflow` / `execute_workflow_run` 遍历步骤树：

- **Agent**：插值 `{{ prev }}` / `{{ outputs.<key> }}` → mint 一个 conversation
  （system = requirement manifest summary 或通用提示；user = 渲染后的 prompt）→
  `state.build_agent_with(None, model, |cfg| cfg.session_workspace = …)` → `Agent::run`
  （带 timeout）→ 取末条 assistant 文本作为 output，按 `output_key` 入 outputs。
- **Pipeline / Phase**：顺序递归，前递 `{{ prev }}`（递归 future 用 `Box::pin` 保持有限大小）。
- **Parallel**：`futures::future::join_all` 单任务并发，叶子里用 `Semaphore`(=4) 限并发；
  `AllRequired` 任一失败则失败，`BestEffort` 收集成功项。

绑定 requirement 时：把每个步骤 conversation `link_conversation` 回需求，并在开始/结束
写 `Activity`（`RunStarted` / `RunFinished`，复用 `record_activity`）。

**subagent 步骤是前向兼容**：`AppState` 暂未暴露 subagent 注册表，故 `subagent: Some(..)`
的步骤目前仍走主 agent loop（记日志），数据模型保留字段供后续接线。

**并发写盘风险**：并行写步骤同时改主 checkout 不安全；v1 谨慎处理（建议绑定 per-run
worktree 或顺序化写步骤）。

## 触发

- **手动**：`POST /v1/workflows/:id/run { requirement_id? }` → 同步 mint+persist
  `Running` run → 后台 `tokio::spawn` 执行 → 返回 `202` + run。
- **auto-loop**：`auto_mode::drive_one_with_prompt` 开头分支：requirement 绑定了存在的
  workflow 就调 `drive_workflow` 并返回，否则回落单 agent 路径。

## HTTP / Web UI

- `GET/POST /v1/workflows`、`GET/PATCH/DELETE /v1/workflows/:id`、
  `POST /v1/workflows/:id/run`、`GET /v1/workflows/:id/runs`、`GET /v1/workflow-runs/:run_id`。
  未配置存储时统一 503（同 `automation_routes` 约定）。
- 绑定通过既有 `PATCH /v1/requirements/:id`（新增 `workflow_id` 三态字段：省略/`null`清除/字符串绑定）。
- Web：`services/workflows.ts`（缓存 + 订阅）；Settings → Workflows 目录页（增删改 + 运行 + 运行历史）；
  Requirement 详情的 workflow 选择器 + 运行时间线。

## 与既有 proposal 的关系

- 补充 [`symphony-inspired-orchestration.zh-CN.md`](symphony-inspired-orchestration.zh-CN.md)：
  那里的 `WORKFLOW.md` 是**调度器配置**，本提案是**per-requirement 的结构化配方**。
- 复用 [`subagents.zh-CN.md`](subagents.zh-CN.md) 的并发原语思想（`SubAgentBatchTool` /
  `JoinStrategy` / `Semaphore`）。
- 绑定到 [`work-orchestration.zh-CN.md`](work-orchestration.zh-CN.md) 的 Requirement 生命周期。

## 后续

- subagent 步骤接线（`AppState` 暴露 subagent 注册表后）。
- structured-output schema / token budget / resume。
- 并行写步骤的 worktree 隔离强制化。
- WS 推送步骤级进度帧（当前 UI 轮询 `/runs`）。
- 标准 SQL 后端的 `WorkflowStore`（当前 SQL 部署回落内存）。
