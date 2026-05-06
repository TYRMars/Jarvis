# Symphony 启发的 Work 常驻编排

**Status:** Proposed.
**Source:** [openai/symphony `SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md),
阅读时间：2026-05-06。
**Touches:** 新增 `harness-orchestrator` 或扩展 `harness-requirement` 的上层编排模块；
新增 `WORKFLOW.md` loader / typed config / tracker adapter / workspace manager；
扩展 `RequirementRunStore`、run events、diagnostics API 与 Web UI；`apps/jarvis`
负责 CLI/env/config wiring。`harness-core` 不改 agent loop 语义。

## 背景

Symphony 定义的是一个长期运行的 coding-agent 调度服务：持续从 issue tracker
读取候选任务，为每个 issue 创建隔离 workspace，按 repo 内 `WORKFLOW.md`
契约运行 agent，并通过并发限制、重试、reconcile 和结构化日志保证可运营。

Jarvis 已经具备其中一半底座：

- `Requirement` / Project 看板已经是一等 Work 对象；
- `RequirementRun` 已有 status、summary、error、verification、logs 与
  `worktree_path` 字段；
- `RequirementContextManifest` 已能为 fresh run 注入 goal、instructions、
  files、verification 与 constraints；
- `AgentConfig.session_workspace` 可以把工具执行 pin 到 per-session workspace；
- `Approver`、permission mode、tool filter 已经覆盖 Symphony 留给实现方自定的
  approval / sandbox posture；
- `ChatRunRegistry` 已经证明了 run 状态、事件回放和 interrupt API 的最小形态。

因此 Jarvis 不应该照搬 Symphony 的进程模型，也不应该把核心 agent loop 改成
Codex app-server subprocess。更合适的路线是吸收 Symphony 的**常驻编排层**：
poll issue、claim、dispatch、retry、reconcile、隔离 workspace、热加载 workflow、
面向操作者观测。

## 目标

1. **把 Work 从“手动触发”升级为“可长期运行”。**
   Jarvis 可以按固定 cadence 扫描外部 tracker 或本地 Requirement 队列，自动选择
   eligible task 运行。

2. **让执行策略随代码库版本化。**
   `WORKFLOW.md` 描述 prompt、tracker、workspace、hooks、并发、重试、agent
   策略。团队改代码的同时改 agent 工作契约。

3. **每个 Requirement run 有隔离 workspace。**
   agent cwd 必须是 per-requirement 或 per-run workspace，路径必须留在配置 root
   内，workspace key 必须 sanitize。

4. **失败可重试，运行可诊断。**
   所有 run attempt 都有生命周期、失败原因、重试计划、最近事件、token/runtime
   统计和 operator-visible logs。

5. **保留 Jarvis 的本地优先和安全默认值。**
   自动执行必须走现有 permission / approval / sandbox 策略，不默认高信任
   auto-approve。

## 非目标

- 不重写 `harness-core::Agent`。
- 不把 Linear 写死进核心；Linear / GitHub / Jira 都只是 tracker adapter。
- 不把 tracker 写操作塞进 orchestrator；评论、状态迁移、PR 链接可以由 agent
  工具或 MCP 完成。
- 不把 Jarvis 变成只支持 Codex app-server 的 runner；内部 Rust agent runtime 仍是
  第一执行路径。
- 不第一版实现分布式调度、多租户或云端 control plane。

## 术语映射

| Symphony | Jarvis |
|---|---|
| Issue | `Requirement` 或外部 tracker 的 normalized issue |
| Run Attempt | `RequirementRun` |
| Workflow Definition | repo-owned `WORKFLOW.md` |
| Workspace | per-requirement / per-run workspace 或 git worktree |
| Agent Runner | Jarvis agent run dispatcher |
| Orchestrator State | 新的 Work run scheduler runtime state |
| Status Surface | `/diagnostics`、Work Overview、Requirement detail |

## 包边界

优先方案：新增 `crates/harness-orchestrator/`。

```text
crates/
  harness-orchestrator/
    src/
      lib.rs
      workflow.rs      # WORKFLOW.md loader + YAML front matter split
      config.rs        # typed getters, defaults, env indirection, validation
      tracker.rs       # IssueTrackerAdapter trait + NormalizedIssue
      scheduler.rs     # poll, claim, dispatch, retry, reconciliation
      workspace.rs     # workspace key, root containment, hooks
      prompt.rs        # strict template rendering
      events.rs        # OrchestratorEvent / snapshot models
      diagnostics.rs   # runtime snapshot + issue-specific debug model
```

依赖方向：

- `harness-orchestrator` 可以依赖 `harness-core`、`harness-requirement`；
- 可以依赖 `serde`、`tokio`、`async-trait`、`notify`、`liquid` 或等价 strict template
  engine；
- 不依赖 `harness-server`、`apps/jarvis-web`、具体 UI；
- 不读 `std::env`，但可以接受由 `apps/jarvis` 注入的 env resolver；
- HTTP/WS wiring 仍在 `harness-server`；
- CLI/env/config composition 仍在 `apps/jarvis`。

备选方案：把 orchestration 放进 `harness-requirement`。优点是少一个 crate；
缺点是 tracker、workflow、scheduler 会让 requirement crate 变重。除非实现非常小，
否则推荐独立 crate。

## `WORKFLOW.md` 契约

文件发现优先级：

1. CLI/runtime 显式路径；
2. Project 配置路径；
3. workspace root 下 `WORKFLOW.md`。

格式：

```markdown
---
tracker:
  kind: github
  repo: owner/name
  active_states: ["todo", "in_progress"]
  terminal_states: ["done", "closed"]
polling:
  interval_ms: 30000
workspace:
  root: .jarvis/workspaces
hooks:
  before_run: |
    cargo check --workspace
agent:
  max_concurrent_agents: 2
  max_turns: 20
  max_retry_backoff_ms: 300000
---

你正在处理 {{ issue.identifier }}: {{ issue.title }}。

请阅读仓库说明，完成任务，运行验证，并在需要人工判断时明确说明 blocker。
```

解析规则：

- front matter 可选；没有时整文件作为 prompt body；
- front matter 必须是 YAML map；
- unknown top-level keys 忽略，便于扩展；
- prompt body trim 后保存；
- workflow read/parse/config validation failure 阻止新 dispatch；
- template render failure 只失败当前 run attempt。

配置规则：

- `$VAR_NAME` 只在显式写入配置值时解析；
- 不做“环境变量全局覆盖 YAML”；
- path 支持 `~` 和相对 `WORKFLOW.md` 所在目录解析；
- 热重载必须保留 last-known-good config，invalid reload 只发 operator-visible error。

## Tracker Adapter

核心 trait 草案：

```rust
#[async_trait]
pub trait IssueTrackerAdapter: Send + Sync {
    async fn fetch_candidate_issues(&self) -> Result<Vec<NormalizedIssue>>;
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<NormalizedIssue>>;
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<NormalizedIssue>>;
}

pub struct NormalizedIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub state: String,
    pub branch_name: Option<String>,
    pub url: Option<String>,
    pub labels: Vec<String>,
    pub blocked_by: Vec<IssueBlocker>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}
```

第一版可以先实现一个 adapter：

- **GitHub Issues**：更贴近开源仓库和当前 GitHub 插件能力；
- **Linear**：更贴近 Symphony spec，适合团队看板。

无论实现哪个，orchestrator 只消费 `NormalizedIssue`。外部 issue 可以 materialise
成 Jarvis `Requirement`，也可以每次 run 时临时映射；长期建议落库成 `Requirement`，
这样 Work UI、Activity、Run history 都能复用。

## 调度状态机

内部 orchestration state 不等同于 Requirement status：

- `Unclaimed`：未运行、无 retry；
- `Claimed`：已被调度器保留；
- `Running`：worker task 正在执行；
- `RetryQueued`：等待 retry timer；
- `Released`：不再 eligible，释放 claim。

tick 流程：

1. reconcile running issues；
2. validate workflow/config；
3. fetch candidate issues；
4. 按 priority、created_at、identifier 排序；
5. 在全局/按状态并发限制下 dispatch；
6. emit snapshot / events。

candidate eligible 条件：

- id、identifier、title、state 存在；
- state 在 active states，且不在 terminal states；
- 未 running，未 claimed；
- 有可用并发 slot；
- blocker 已满足；
- 对应 Project / workspace policy 允许自动执行。

retry 规则：

- normal worker exit 后短延迟 continuation retry，默认 1000ms；
- failure retry 使用指数退避：`min(10000 * 2^(attempt - 1), max_retry_backoff_ms)`；
- retry timer 触发时重新 fetch candidates；如果 issue 不再 active，release claim；
- slot 不足时重新排队，并记录 `no available orchestrator slots`。

stall detection：

- 每个 running entry 记录 latest event timestamp；
- 超过 `stall_timeout_ms` 无事件则 cancel worker 并 schedule retry；
- `stall_timeout_ms <= 0` 表示关闭。

## Workspace 管理与安全不变量

workspace root：

- 来自 `WORKFLOW.md`、Project config 或 server config；
- 解析成 absolute path；
- 每个 issue 的 workspace path 是 `<root>/<sanitized_identifier>`；
- future option：每个 attempt 使用 `<root>/<sanitized_identifier>/<run_id>`。

sanitize：

- 只允许 `[A-Za-z0-9._-]`；
- 其他字符替换为 `_`。

必须满足：

- `workspace_path` 必须在 `workspace_root` 下；
- agent launch / Jarvis run 的 cwd 必须是 `workspace_path`；
- `AgentConfig.session_workspace` 必须设置为该路径；
- hooks 也在该 cwd 执行；
- 不因 checkout/population 失败 destructive reset 复用 workspace，除非 policy 明确配置。

hooks：

- `after_create`：仅新建 workspace 后运行，失败则 abort creation；
- `before_run`：每次 attempt 前运行，失败则当前 attempt failed；
- `after_run`：每次 attempt 后 best-effort，失败只记录；
- `before_remove`：terminal cleanup 前 best-effort；
- hook output 截断入 log；
- hook timeout 默认 60000ms。

## Agent Runner 集成

Jarvis 默认使用内部 Rust agent runtime：

1. create/reuse workspace；
2. run `before_run` hook；
3. build prompt：`WORKFLOW.md` prompt template + normalized issue + attempt +
   `RequirementContextManifest`；
4. mint fresh `Conversation`；
5. clone/build `AgentConfig`，设置 `session_workspace`、permission/approver、agent profile；
6. run `Agent::run_stream`；
7. 将 `AgentEvent` 转成 RequirementRun events / logs / snapshot；
8. run verification plan；
9. run `after_run` hook；
10. mark run terminal and decide retry/release。

Codex app-server 可作为可选 runner backend，而不是默认架构：

```rust
#[async_trait]
pub trait WorkRunner: Send + Sync {
    async fn run_attempt(&self, input: RunAttemptInput) -> Result<RunAttemptOutput>;
}
```

后续可以有：

- `JarvisInternalRunner`；
- `CodexAppServerRunner`；
- `ClaudeCodeRunner`；
- cloud/edge runner。

## Persistence 与事件

需要补齐或强化：

- `RequirementRunStore`：durable run rows；
- `RequirementRunEvent` WS bridge；
- retry queue 可先 in-memory，后续可持久化；
- run logs 写入 `RequirementRun.logs`；
- Activity timeline 记录 `run_started` / `run_finished` / `verification_finished` /
  `retry_scheduled` / `workspace_cleaned`；
- diagnostics snapshot API 暴露 running、retrying、totals、last errors。

推荐 snapshot 字段：

```json
{
  "counts": { "running": 2, "retrying": 1 },
  "running": [],
  "retrying": [],
  "token_totals": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "seconds_running": 0,
  "latest_errors": []
}
```

## HTTP / Web UI

`harness-server` 新增或扩展：

- `GET /v1/work/orchestrator/state`；
- `POST /v1/work/orchestrator/refresh`；
- `POST /v1/work/orchestrator/pause`；
- `POST /v1/work/orchestrator/resume`；
- `GET /v1/requirements/:id/runs`；
- `GET /v1/requirements/:id/runs/:run_id`；
- `POST /v1/requirements/:id/runs/:run_id/cancel`。

Web UI：

- Work Overview 显示 active runs / retry queue / last failures；
- Requirement detail 显示 run attempts、logs、verification、workspace path；
- diagnostics 页显示 stalled runs、orphan workspaces、invalid workflow reload；
- Project settings 支持选择 workflow file、enable auto dispatch、并发上限。

## 配置与 CLI

`apps/jarvis` 增加：

```text
jarvis work serve --workflow ./WORKFLOW.md
jarvis work once --requirement <id>
jarvis work refresh
jarvis work doctor
```

或先复用现有 `serve`：

```text
jarvis serve --workflow ./WORKFLOW.md --work-auto
```

建议新增 config 字段：

```json
{
  "work": {
    "enabled": false,
    "workflow_path": null,
    "auto_dispatch": false,
    "max_concurrent_runs": 1
  }
}
```

自动执行默认关闭。开启时仍受 permission mode、project policy 和 approval gate 约束。

## 与现有 proposal 的关系

- `work-orchestration.zh-CN.md` 是 Work 模型和阶段路线的总纲；本文是对其中
  “常驻调度 / 外部 issue / workflow 契约 / retry reconcile” 的补充 spec。
- `permission-modes.md` 仍是安全策略 source of truth；本文不重新定义权限模式。
- `sandboxing.md` 覆盖 OS/container 级隔离；本文只定义 workspace path 不变量。
- `web-multi-session-runs.zh-CN.md` 的 per-conversation run registry 可作为
  RequirementRun registry 的实现参考。
- `cloud-blueprint.zh-CN.md` 的 Cloud / Edge 调度可以在本地 orchestrator 跑通后再接。

## 分阶段落地

### Phase 0: Spec alignment

- 本文入库；
- 在 `work-orchestration.zh-CN.md` 中链接本文；
- 确认第一版 tracker adapter 选 GitHub 还是 Linear。

### Phase 1: Workflow loader

- 实现 `WORKFLOW.md` read/parse；
- typed config + defaults + `$VAR` resolver；
- strict prompt template rendering；
- 单元测试覆盖 invalid YAML、front matter non-map、unknown variable、path resolution。

### Phase 2: Workspace manager

- sanitized workspace key；
- root containment validation；
- hooks + timeout + truncated logs；
- 接入 `AgentConfig.session_workspace`。

### Phase 3: Requirement orchestrator MVP

- in-memory state；
- manual `refresh` tick；
- local Requirement queue dispatch；
- global concurrency；
- run event/log persistence。

### Phase 4: Tracker adapter

- 实现一个外部 tracker adapter；
- normalized issue -> Requirement materialise；
- active/terminal state reconcile；
- blocker gating。

### Phase 5: Retry, stall, diagnostics

- retry queue + exponential backoff；
- stall timeout；
- startup terminal cleanup；
- diagnostics snapshot + Web UI。

### Phase 6: Dynamic reload and hardening

- `WORKFLOW.md` file watch；
- last-known-good config；
- pause/resume controls；
- token/runtime/rate-limit accounting；
- optional persistent retry queue。

## 验收标准

- `harness-core` 没有引入 HTTP、tracker、workspace hook 或 scheduler 概念；
- workflow parse/render 错误有 typed error；
- invalid workflow reload 不会 crash server；
- agent run 的 effective workspace 始终在 workspace root 内；
- terminal/non-active tracker state 能停止 running worker；
- failed run 会记录 error 并进入 retry；
- operator 能通过 API/UI 看到 running、retrying、last error、run logs；
- clippy gate 通过：`cargo clippy --workspace --all-targets -- -D warnings`。

