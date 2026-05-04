# SubAgent 系统 — 默认 SubAgent + Reviewer 自动验收

**状态：** Proposed (v1.0)。Jarvis 当前只有"主 agent loop"一种执行主体；
所有专门化 (写代码、读文档、评审验收等) 都得在主 agent 的 system prompt
+ 工具集里硬塞，难以扩展，也难以在不同任务间复用便宜模型。本提案在
`harness-core` 之外新增一个 SubAgent 注册表，默认内置四个 SubAgent
(ClaudeCode / Codex / DocReader / Reviewer)，并把"自动评审验收"作为
Reviewer 的产品能力同时落地，把 Requirement `Review → Done` 的人工
闸门改为"默认走 reviewer subagent，可降级回人工"。

**涉及：**
- 新增 crate `crates/harness-subagents/` 持有 SubAgent trait + 内置实现
- `harness-core::Requirement` 增加 `acceptance_policy` 字段
- `harness-tools` 注册一组 `subagent.*` 工具，让主 agent 可显式委派
- `harness-server` 新增 `review_runner` 与 `auto_mode` 协作；REST 端点
  `POST /v1/requirements/:id/review`
- Web UI：RequirementDetail / 看板卡片展示评审状态；新增 SubAgent 列表
  设置页 (复用 Settings → Models → Subagents tab — 这个 tab 已存在但今天
  只是 placeholder)
- 配置：环境变量 `JARVIS_REVIEW_MODE` + 每条 Requirement 的
  `acceptance_policy` 双层

## 背景

用户的诉求是："默认有的 SubAgent — 写代码 (ClaudeCode / Codex 可调用)、
读文档 (用便宜模型)、审阅 (review agent)"。这不是单个功能，而是一个
**可扩展的子智能体注册表**：每个 SubAgent 都有自己的角色、模型、工具
集、调用约定，主 agent 可以委派任务给它们。

当前架构里几个相关锚点：
- `harness-core::Agent` 是 agent loop 的唯一抽象。
- `harness-llm` 里有多个 provider，可以通过 `JARVIS_MODEL` 等环境变量
  配置主 agent 用哪个模型。
- `apps/jarvis-cli` 是把 `harness-core::Agent` 包成 CLI 的 binary。
- `harness-mcp::McpClient` 已经把"远程 MCP 服务"包装成 `Tool`，是
  "外部能力即工具"的先例。
- `crates/harness-tools/src/requirement.rs::complete` 结构性禁止写
  `Done`，CLAUDE.md 把这写成"human-only acceptance gate"。

可以借鉴的开源对照：
- Claude Code 的 `Task` 工具：主 agent 通过 `Task(description, prompt,
  subagent_type)` 调用专门 subagent，subagent 跑完返回单条消息给主 agent。
- Cursor / Aider 的"独立窗口模型"：写代码用 GPT-4，读 PR 用 Haiku。

## 核心设计：SubAgent as Tool

每个 SubAgent 表现为一个工具：主 agent 调用 `subagent.<name>(input)`，
工具内部把 `input` 转给 subagent 执行 (内部 Agent loop 或外部 CLI)，把
最终回复作为字符串返回给主 agent。**主 agent 不知道也不关心 subagent
的内部实现**。

```rust
// crates/harness-subagents/src/lib.rs
#[async_trait]
pub trait SubAgent: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> serde_json::Value;
    async fn invoke(&self, input: SubAgentInput) -> Result<SubAgentOutput, BoxError>;
}

pub struct SubAgentInput {
    pub task: String,                    // 主 agent 给的自然语言任务
    pub workspace_root: PathBuf,         // 沙盒根 (与主 agent 共享)
    pub context: Option<serde_json::Value>, // 可选结构化上下文
}

pub struct SubAgentOutput {
    pub message: String,                 // 给主 agent 的最终回复 (流结束时)
    pub artifacts: Vec<Artifact>,        // 可选产物 (修改的文件列表 / verdict / 摘要)
}
```

注册：`SubAgentRegistry::new()` 收集所有内置 SubAgent，
`register_subagents_as_tools(&mut tool_registry, &subagent_registry)` 把
它们包装成 `Tool` 注入主 agent 的 ToolRegistry。

实现两类：
- **InternalSubAgent**：内部跑一个新的 `harness-core::Agent` loop，独立
  conversation、独立模型、独立工具集。reviewer / doc-reader / 大多数后
  续 subagent 都是这一类。复用 `Agent::run_stream`，每条 `AgentEvent`
  都通过 `subagent` task-local 通道转发出去（详见下面"流式可视"段）。
- **SdkSubAgent**：外部 SDK 进程。ClaudeCode（`@anthropic-ai/claude-agent-sdk`）
  和 Codex（如果有 SDK）属此类。通过一段 Jarvis 内置的 Node/Python 包装
  脚本启动 SDK，**SDK 的事件流以 JSON Lines 写到 stdout**，Jarvis 解析
  每行并转成 `AgentEvent::SubAgentEvent` 转发回主 agent 与 UI。Per-invocation
  spawn（不是长驻 sidecar）—— 简单、与现有 `shell.exec` 模式一致。

## 流式可视：subagent 执行过程怎么传到 UI

用户的明确诉求："希望能看到对应 subagent 执行过程"。所以 subagent 不是
"跑完返回字符串"，而必须把 reasoning + 工具调用 + 结果**流式**回传。

新增 `harness-core::subagent` task-local 通道（与 `progress` / `plan`
通道平行）：

```rust
// crates/harness-core/src/subagent.rs (新增)
tokio::task_local! {
    static SUBAGENT_CHANNEL: mpsc::UnboundedSender<SubAgentFrame>;
}

pub struct SubAgentFrame {
    pub subagent_id: String,        // 唯一实例 id (uuid v7)
    pub subagent_name: String,      // "claude_code" / "review" / ...
    pub event: SubAgentEvent,
}

pub enum SubAgentEvent {
    Started { task: String, model: Option<String> },
    Delta { text: String },                  // LLM 文字输出片段
    ToolStart { name: String, args: Value }, // subagent 调用了某个工具
    ToolEnd { name: String, output: String },
    Status { message: String },              // SDK 自定义事件 (e.g. "Searching files...")
    Done { final_message: String },
    Error { message: String },
}
```

`Agent` loop 在 `tool_dispatch` 段把 `subagent` 通道注入 task-local，让
subagent 工具内部 emit。Loop 自身的 `tokio::select!` 加一个 arm 把 frames
转成 `AgentEvent::SubAgentEvent { frame }` 推到外层流。

主 agent 的 WS / SSE 消费者 (`apps/jarvis-web`) 收到这条 frame 后：

- **行内折叠卡片**：在主 agent 的消息流里渲染一张可折叠卡片
  ```
  ▸ subagent.claude_code · 执行中 · 已用 12s
    [展开] 看具体 ToolStart / Delta / ToolEnd 的滚动列表
  ```
  完成后变成 `✓ 完成` / `✗ 失败`，commentary / final_message 直接展示。
- **侧栏实时**（可选）：屏幕右侧有一个固定的"运行中的 subagent"小窗口，
  当下所有正在跑的 subagent 实例都列出来。

跨 subagent 串联：`SubAgentInput` 上的 `caller_chain: Vec<String>` 用于
v1.0 阻止递归（深度 ≥ 1 时不注册 `subagent.*` 工具进 ToolRegistry）；
但 frame 的 `subagent_id` 会在 chain 里保留，UI 可以画出嵌套关系（v1.1）。

## 默认内置的四个 SubAgent (v1.0)

### 1. `subagent.claude_code` — ClaudeCode 写代码

**SDK：** Anthropic 官方 [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
(也有 Python 版 `claude-agent-sdk`)。SDK 暴露 `query()` / `Agent` 等接口，
能拿到与 Claude Code CLI 等价的 agentic 能力（plan mode、Task 工具、
hooks、permission modes、settings.json 配置）。

**集成形态**：per-invocation 启动一段 Jarvis 内置的 Node 包装脚本，
脚本调用 SDK 跑一次任务并把每个事件以 JSON Lines 写到 stdout。Rust 这边
逐行解析、推到 `subagent` 通道。包装脚本固定结构：

```js
// crates/harness-subagents/sidecar/claude_code.mjs (Jarvis 内置)
import { query } from "@anthropic-ai/claude-agent-sdk";

const input = JSON.parse(await readStdin());
for await (const message of query({
  prompt: input.task,
  options: { cwd: input.workspace_root, permissionMode: "acceptEdits" },
})) {
  // message 类型：assistant text / tool_use / tool_result / system / result
  process.stdout.write(JSON.stringify({ kind: message.type, payload: message }) + "\n");
}
```

每条 stdout JSON 行 → 解析成 `SubAgentEvent::Delta` / `ToolStart` /
`ToolEnd` / `Done` 推入 `subagent` 通道。

工具说明文档强调：**它会改文件**。`requires_approval() = true`。

**前置条件**：用户机器需要 Node ≥ 18 + 装了 `@anthropic-ai/claude-agent-sdk`。
启动时 `which node` + 检查 sdk 是否能 import；缺失则不注册
`subagent.claude_code`，启动日志写一行 INFO，**不报错**（沿用 MCP / sqlite
等可选依赖的模式）。

环境变量：
- `JARVIS_SUBAGENT_CLAUDE_CODE_NODE` （默认 `node`）
- `JARVIS_SUBAGENT_CLAUDE_CODE_SDK_PATH` （可选；默认让 Node 自己 `import`，
  靠 `npm install -g` 解析）
- ANTHROPIC_API_KEY 走 SDK 自己的认证链（环境变量 / `~/.claude` settings
  / OAuth），Jarvis 不代管。

主 agent 用法：
```
subagent.claude_code({
  task: "把 fs.patch 工具的多文件拆分逻辑抽到独立函数",
  workspace_root: "/path/to/jarvis"
})
```

### 2. `subagent.codex` — Codex 写代码

**SDK 调研结果（v1.0 落地前必须确认）：**

OpenAI 官方 Codex CLI（`@openai/codex` npm 包，或 Cargo 安装的
`codex-cli`）目前主要以**命令行工具**形态发行，没有公开稳定的"嵌入式
SDK"暴露 agentic loop（截至 2026-05；落地前再 web check 一次）。

所以分两条路径，选其中之一：

**路径 A（推荐，零外部依赖）：Internal subagent，复用现有 Codex provider**

`crates/harness-llm/src/responses.rs` 已经有
`ResponsesProvider::codex(CodexAuth)` —— 走 `chatgpt.com/backend-api/codex/responses`
端点，ChatGPT 订阅 OAuth 鉴权。Jarvis 自己用这个 provider 起一个 Internal
subagent loop 即可：

- 工具集：`fs.{read,list,write,edit,patch}` + `shell.exec` + `code.grep` +
  `git.*`（与主 agent 写代码用的工具集对齐）
- System prompt：参考 Codex CLI 的开源实现（GitHub `openai/codex`），
  把它的 prompt 大致复刻一份；写到 `crates/harness-subagents/src/codex_prompt.rs`
  作为常量
- 模型：`JARVIS_SUBAGENT_CODEX_MODEL`，默认 `gpt-5-mini` / `gpt-5`
- 流式：直接复用 `Agent::run_stream`，frames 自动通过 `subagent` 通道
  转发出去（**和其它 Internal subagent 同一条路径**）

**优点**：零新依赖、UI 流式可视开箱即用、与 ClaudeCode 走两条不同的
集成路径正好对照。

**缺点**：不是 Codex CLI 一比一行为，可能与官方 Codex 工具的某些细节
（自定义 prompt 优化、特殊 tool semantics）不一致。

**路径 B（备选）：SDK 风格 sidecar，跑 `codex` CLI 的非交互模式**

如果 OpenAI 后续开了 SDK，或愿意 shell out 到 `codex exec` 类的非交互
入参，就走和 ClaudeCode 同一条 sidecar 模式。

**v1.0 决定**：先走路径 A，sidecar 占位为 v1.1。提案落地时如果
`@openai/codex` 在那时已经发了正式 SDK，再调整。

环境变量：
- `JARVIS_SUBAGENT_CODEX_MODEL`（默认 `gpt-5-mini`）
- `CODEX_HOME` / `CODEX_ACCESS_TOKEN`（继承现有 Codex provider 的认证链）

`requires_approval() = true`（写代码工具同级）。

> 选 ClaudeCode 还是 Codex？— 主 agent 自己决定（它知道当前任务上下文，
> 可以从 system prompt 里指引"涉及 Rust 用 ClaudeCode、涉及前端用
> Codex"等启发式策略）。

### 3. `subagent.read_doc` — 读文档 (便宜模型)

Internal。固定使用 `JARVIS_SUBAGENT_READER_MODEL` (默认
`claude-haiku-4-5-20251001` / `gpt-4o-mini` / `gemini-1.5-flash`，按当前
provider 自动选最便宜)。

工具集仅包含：`fs.read`, `fs.list`, `code.grep`, `http.fetch` (供读取
线上文档)。无写权限。

System prompt：
```
你是一个文档读取助理。任务是从给定路径或 URL 中提取信息回答用户问题。
- 只读：不要修改文件，不要执行 shell 命令。
- 简洁：回答直接给结论，必要时附上 path:line 引用。
- 拒绝：如果任务需要"修改"或"生成代码"，直接拒绝并提示用主 agent。
```

主 agent 用法：
```
subagent.read_doc({
  task: "找出 docs/proposals/work-orchestration.zh-CN.md 里关于 verification_plan 的描述",
  workspace_root: "/path/to/jarvis"
})
```

读文档用便宜模型，可以在长文档场景节省 80%+ token 成本。

### 4. `subagent.review` — 评审验收

Internal。是 reviewer subagent 的核心。

System prompt：
```
你是 reviewer，不是 implementer。绝不修改代码。
- 只读 + 验证类工具：fs.read / fs.list / code.grep / git.{status,diff,log,show} /
  shell.exec (仅运行测试)
- 严格按 verification_plan 逐项检查，给出 pass / fail + 评语 + 证据
- 模糊一律 fail，附评语让 work agent 修
- 决定时调用 requirement.review_verdict 工具
```

工具集：`fs.read`, `fs.list`, `code.grep`, `git.{status,diff,log,show}`,
`shell.exec`, `requirement.review_verdict` (新增，仅 reviewer 注册)。

调用入口：
- 主入口：`POST /v1/requirements/:id/review` (手动触发，本地验证用)
- 自动入口：`auto_mode::tick` 在 work outcome 翻 Review 时自动派发
  (前提：`req.acceptance_policy == Subagent` 且
  `JARVIS_REVIEW_MODE != off`)

#### Reviewer 的 Requirement 状态机改动

`harness-core::Requirement` 新增字段：

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AcceptancePolicy {
    #[default]
    Subagent,
    Human,
}

pub struct Requirement {
    // ... existing fields ...
    #[serde(default, skip_serializing_if = "AcceptancePolicy::is_default")]
    pub acceptance_policy: AcceptancePolicy,
}
```

`requirement.complete` 工具仍然只翻到 Review (不改) —— Done 仍由
**外部决定**：reviewer subagent 通过 `requirement.review_verdict` 触发，
或人工通过 UI 点击。

Auto-mode 流程：

```
work agent loop
  ↓ 完成 → requirement.complete → status = Review
  ↓
  if acceptance_policy == Subagent && JARVIS_REVIEW_MODE != off:
    spawn reviewer subagent
    verdict = reviewer.run(verification_plan, work_run_id)
    if verdict.pass:
      status = Done; activity.record(ReviewPassed)
    else:
      status = InProgress; activity.record(ReviewFailed { commentary })
      // 下次 work agent pickup 时，prompt 注入 "上次评审未通过：<commentary>"
  else:
    停在 Review，等人工
```

失败次数复用 `JARVIS_WORK_MAX_RETRIES`，超出后停在 Review 并写
`Activity::ReviewExhausted`。

## 建议补充的 SubAgent (v1.1+)

以下不在 v1.0 范围，但留口子方便后续按用户需求补：

| SubAgent | 用途 | 典型调用方 |
|---|---|---|
| `subagent.plan` | 接受模糊需求，输出 `verification_plan` + 拆解后的 Requirement 列表 | 用户在 chat 里说"我想加 X 功能"，主 agent 委派 plan subagent 出方案 |
| `subagent.triage` | 扫 TODO / FIXME / 失败 run，决定哪些值得变成 Requirement | 自动循环里在空闲 tick 跑，把候选写成 `triage_state=ProposedByScan` 的 Requirement |
| `subagent.summarize` | 汇总长会话或 PR diff，给出一段 summary | Web UI 上"对话太长" 折叠按钮、或 PR review 工作流 |
| `subagent.web_search` | 搜外部 web (fetch + 提取 + 结构化) | 主 agent 需要查最新文档/库时 |
| `subagent.test_runner` | 仅运行测试套件并报告失败用例 (subset of reviewer，但快、专注、可复用) | reviewer 内部委派；CI gate |
| `subagent.spec_writer` | 给 verification_plan 写一份"对手版本"，避免 work agent 自吹自擂 | reviewer 调用，作为评审清单的二级权威 |

## 配置

环境变量 (新增；同时更新 CLAUDE.md):
- `JARVIS_REVIEW_MODE` = `subagent` (默认) / `off` / `auto-pass`
- `JARVIS_REVIEW_MAX_ITERATIONS` = `5`
- `JARVIS_REVIEW_RUN_TIMEOUT_MS` = `300000`
- `JARVIS_SUBAGENT_CLAUDE_CODE_BIN` (默认 `claude`)
- `JARVIS_SUBAGENT_CODEX_BIN` (默认 `codex`)
- `JARVIS_SUBAGENT_READER_MODEL` (默认随主 provider 选最便宜)
- `JARVIS_DISABLE_SUBAGENTS` (any value disables all built-in subagents — 测试用)

每条 Requirement 维度的 `acceptance_policy` 字段 (UI 切换) 优先于
`JARVIS_REVIEW_MODE`：
- `JARVIS_REVIEW_MODE=off`：所有 Requirement 都人工验收
- `JARVIS_REVIEW_MODE=subagent` 且 `acceptance_policy=Human`：仍人工
- `JARVIS_REVIEW_MODE=subagent` 且 `acceptance_policy=Subagent`：默认路径

## Web UI 改动

- **Settings → Models → Subagents 标签页** (今天是 placeholder) 改成
  SubAgent 列表：每个 subagent 一行，展示 `name / description /
  enabled / model (或 binary path)`。可启用/停用。
- **RequirementDetail** 增加：
  - `Acceptance Policy` 切换 (Subagent / Human radio)
  - 评审区块：最近一次 verdict 的 pass/fail 徽章 + commentary +
    evidence 列表
- **看板卡片** 在"评审中"列上：
  - `pending` 灰 dot
  - `passed` 绿 ✓
  - `failed` 红 ✕ (hover 看 commentary)

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| ClaudeCode SDK 在用户机器上不存在（缺 Node 或缺 `@anthropic-ai/claude-agent-sdk` 包） | 启动时探测 `which node` + 试 import；缺失则不注册 `subagent.claude_code`，启动日志写一行 INFO，**不报错**。 |
| ClaudeCode SDK 升级破坏 JSON Lines 协议 | sidecar 脚本由 Jarvis 仓库版本管，pin SDK 版本；JSON 解析时遇到未知 `kind` → 当成 `Status` 透传，UI 显示原文。 |
| Codex 路径 A 复刻 prompt 与官方 Codex 行为漂移 | 接入时仔细对照 `openai/codex` 的 system prompt；写一份单元测试快照（Codex prompt 文本 + 工具集），上游有更新时手动同步。 |
| Sidecar 子进程被 kill 但 Jarvis 还在等 | `tokio::process::Command::kill_on_drop(true)` 确保 Jarvis 退出/超时时 sidecar 一并终止；Rust 端读 stdout 的 reader 用 `with_timeout` 包裹。 |
| 流式可视的 frame 流量太大冲爆 UI | `subagent` 通道 `mpsc::unbounded` 但 UI 端 throttle 渲染（每 50ms batch 一帧）；Delta 文本拼接、ToolStart/End 不丢。 |
| External subagent 写错文件 / 改了不该改的 | `requires_approval=true`，每次调用都走审批链；UI 上能看到 diff 才放行。 |
| Reviewer 通过 `shell.exec` 改文件 | 不注册 `fs.write/edit/patch`；reviewer system prompt 强约束；后续可加 shell 命令白名单。 |
| Reviewer 跟 work agent 共用同一份 verification_plan 容易自吹自擂 | v1.0 不解决，commentary 中提示"reviewer 看不出问题"；v1.1 用 `subagent.spec_writer` 出对手版本。 |
| Reviewer 卡死 / 死循环 | `JARVIS_REVIEW_MAX_ITERATIONS=5` + `JARVIS_REVIEW_RUN_TIMEOUT_MS`；超时按 fail 处理。 |
| Reader subagent 走错路径产生幻觉 | 系统提示里强约束"必须给 path:line 引用"；用户能立刻验证。 |
| 多个 subagent 并发争 token quota | provider 层面已经有 401 → refresh → retry once 机制；subagent 走的是同一套 LlmProvider，不需要额外队列。 |
| 子 subagent 引发递归 (subagent A 又调用 subagent B) | v1.0 禁止递归 — `SubAgentInput` 上加一个 `caller_chain: Vec<String>`，深度 ≥ 1 时不注册任何 `subagent.*` 工具进 ToolRegistry。 |

## 实施步骤 (拆分为多个 PR)

**Step 1：scaffolding + 流式通道**
- 创建 `crates/harness-subagents/` (空 crate + `SubAgent` trait +
  `SubAgentInput/Output/Frame/Event` 类型)
- `harness-core::subagent` task-local 通道（与 `progress` / `plan` 平行）
- `harness-core::Agent::run_stream` 加 `tokio::select!` arm，把 frames
  转成 `AgentEvent::SubAgentEvent` 推到外层流
- `harness-core::Requirement` 加 `acceptance_policy` 字段（默认
  `Subagent`、serde 忽略默认值）
- 一个测试用的 `EchoSubAgent`：拿到 task → emit Started + Delta×3 + Done
- 单元测试：legacy JSON 行加载仍 OK；EchoSubAgent 的 frame 序列符合预期
- **行为零变化**（EchoSubAgent 不默认注册）

**Step 2：内部 subagent — reader + reviewer + codex**
- `DocReaderSubAgent`：cheap-model + 只读工具集
- `ReviewerSubAgent`：与 work agent 共用 verification_plan，自带
  `requirement.review_verdict` 工具
- `CodexSubAgent`：复用 `harness-llm::ResponsesProvider::codex`，
  携带 codex-style system prompt（从 `openai/codex` 仓库复刻一份）
- 三者都通过 Internal 路径共享同一套流式实现（直接拿 `Agent::run_stream`
  的 events 翻译成 `SubAgentEvent` 推 channel）
- 单元测试：mock LlmProvider，验证 frame 序列、verdict 解析、refusal 路径

**Step 3：SDK sidecar — ClaudeCode**
- `ClaudeCodeSubAgent` + `crates/harness-subagents/sidecar/claude_code.mjs`
- 启动时 `which node` + 试 `import @anthropic-ai/claude-agent-sdk`，
  缺失则不注册（写一行 INFO，按 MCP 缺失工具的模式）
- Sidecar JSON Lines 协议：每行一个 `{ kind, payload }`
- Rust 端 `tokio::process::Command` spawn，逐行 parse stdout，转 `SubAgentEvent`
- 集成测试：fake sidecar 脚本输出固定 JSON 序列，验证 Rust 解析正确

**Step 4：自动评审接入 auto_mode**
- `crates/harness-server/src/review_runner.rs` 调用 `ReviewerSubAgent`
  完成 work outcome 后的派发
- `auto_mode::tick` 集成（pass→Done / fail→InProgress + commentary 注入
  下次 pickup prompt）
- REST 端点 `POST /v1/requirements/:id/review` 用于手动触发

**Step 5：Web UI**
- 主 agent 消息流：`AgentEvent::SubAgentEvent` 渲染成可折叠"subagent 卡片"，
  实时展示 ToolStart/ToolEnd/Delta/Done。完成后 collapse 成一行带绿/红
  状态的 summary。
- Settings → Models → Subagents 标签页（今天是 placeholder）改成
  SubAgent 列表
- RequirementDetail 评审区块 + acceptance_policy 切换
- 看板卡片评审 badge
- i18n 双语

**Step 6：文档**
- CLAUDE.md 更新（移除 "human-only acceptance gate" 措辞；新增
  SubAgent 一节描述这套机制 + 默认 4 个内置）
- README.md `Work Mode` 段加 reviewer + subagent 说明
- 本提案改 `状态：Adopted`

**Step 7（可选/v1.1）：sidecar Codex（如果届时 SDK 出现）**
- 占位，落地时再决定。

## 不做的事 (v1.0)

- 用户自定义 subagent (注册三方 subagent) — v1.1 通过插件或 MCP 风格
- subagent 之间的递归调用 — 显式禁止 (caller_chain 深度限制)
- subagent 的 streaming 输出 (主 agent 看不到 subagent 中间 token) —
  默认非流式，subagent 跑完一次性给 message
- subagent 的 cost 追踪 — 留到后续做 token-usage tracking 时一起
