# OTel 原生 LLM/Agent Eval Harness 埋点体系

**状态：** Proposed
**涉及：** `harness-core`、`harness-llm`、`harness-tools`、`harness-mcp`、
`harness-subagents`、`harness-server`、`harness-store`、`apps/jarvis`、
未来 `crates/harness-eval`。

## 背景

Jarvis 的核心价值不是只把一次 LLM 调用包成接口，而是提供一个可以运行工具、维护
会话、处理审批、连接 MCP、流式返回事件，并最终面向 Chat / Work / Docs 复用的
Agent harness。随着能力变多，仅靠日志很难回答下面这些问题：

- 某个模型升级后，agent 是否更容易错误调用工具？
- 某类任务的失败是模型问题、工具 schema 问题、权限审批问题，还是工作区上下文不足？
- SSE / WebSocket 里用户感觉“慢”，到底慢在首 token、工具执行、模型尾延迟，还是存储？
- `max_iterations` 命中率是否上升，是否意味着 agent loop 需要更好的收敛策略？
- MCP remote tools 是否比 builtin tools 更不稳定？
- Claude Code / Codex / reviewer 这类 SubAgent 是否真的提高成功率，还是只增加了成本和延迟？
- 一次产品改动是否真正提高了 coding / doc / work 场景的 pass rate？

本 proposal 定义一套 **OpenTelemetry 原生** 的观测和评估体系：Jarvis 自身发出标准
OTel trace、metric、event，eval runner 复用同一套运行链路，把测试样例、裁判分数和
运行事实落到同一条 trace 上。这样线上观测、离线回归、CI gate 和产品健康面板可以共用
数据模型。

## 设计原则

1. **`harness-core` 仍然保持运行环境无关。**
   core 可以发 `tracing` spans/events，但不能初始化 exporter、读取环境变量、依赖具体
   OTLP 后端，也不能知道 HTTP、Provider、MCP 或存储实现。

2. **以 OTel 语义约定为默认语言。**
   优先使用 OpenTelemetry GenAI semantic conventions 的 `gen_ai.*` 字段；Jarvis
   自己的扩展字段统一放在 `jarvis.*` 命名空间。

3. **内容采集默认关闭。**
   prompt、response、tool args、文件内容、shell 输出默认只记录长度、hash、token 估计和
   artifact id。开发环境可以 opt-in 采集内容，生产环境必须经过脱敏和采样。

4. **Jarvis 自己保留一份本地可用的指标事实库。**
   OTel 后端负责链路观测；Jarvis 的看板、eval history、baseline、回归趋势默认写本地
   JSON 文件，并沿用现有 store 抽象，后续可切到 SQLite / Postgres / MySQL。

5. **eval 是 trace 的读者，不是另一套运行时。**
   eval runner 调用同一个 `Agent` / provider / tool registry，不复制 agent loop。它只负责
   组织 dataset、注入 expected metadata、执行 judge、写入分数。

6. **平台可替换。**
   Jarvis 只依赖 OTel SDK / `tracing` / OTLP exporter。后端可以是 Collector + Tempo，
   Phoenix、Langfuse、OpenLIT、SigNoz 或其他兼容系统。

## 非目标

- 不在第一阶段实现完整 LLM observability SaaS UI。
- 不把 OpenTelemetry Collector 嵌入 Jarvis 进程。
- 不把所有 prompt / response 全量写入 span attributes。
- 不为 eval 单独发明一个不能与线上 trace 对齐的数据格式。
- 不让 `harness-core` 依赖 Axum、sqlx、MCP SDK 或任意 provider crate。

## 目标体验

开发者运行本地 Jarvis：

```bash
JARVIS_OTEL_ENABLED=1 \
JARVIS_OTEL_ENDPOINT=http://127.0.0.1:4317 \
RUST_LOG=info \
cargo run -p jarvis
```

再启动本地观测栈：

```bash
docker compose -f infra/otel/docker-compose.yml up
```

一次 Chat 请求在 trace UI 中显示：

```text
http.request POST /v1/chat/ws
  jarvis.agent.run
    jarvis.agent.iteration
      gen_ai.chat
      gen_ai.tool.call fs.read
    jarvis.agent.iteration
      gen_ai.chat
    store.conversation.save
```

一次委派给外部 SubAgent 的请求显示：

```text
http.request POST /v1/chat/ws
  jarvis.agent.run
    jarvis.agent.iteration
      gen_ai.chat
      gen_ai.tool.call subagent.claude_code
        jarvis.subagent.run claude_code
          jarvis.subagent.process claude
          claude_code.interaction
            claude_code.llm_request
            claude_code.tool
              claude_code.tool.execution
```

一次 eval case 显示：

```text
jarvis.eval.suite coding-smoke
  jarvis.eval.case fix-rust-test-001
    jarvis.agent.run
      gen_ai.chat
      gen_ai.tool.call rg.search
      gen_ai.tool.call fs.patch
      gen_ai.tool.call project.checks
    jarvis.eval.judge deterministic
    jarvis.eval.score
```

## 总体架构

```text
Jarvis process
  apps/jarvis
    initializes tracing subscriber, OTLP exporter, sampling and redaction
  harness-server
    creates HTTP / SSE / WS root spans
  harness-core
    emits agent loop spans and AgentEvent-correlated events
  harness-llm
    emits provider request spans and token metrics
  harness-tools / harness-mcp
    emits tool invocation spans
  harness-subagents
    emits delegated agent spans, forwards frames, propagates trace context
  harness-store
    emits store operation spans
  harness-eval
    runs suites and emits eval spans / metrics

OTLP
  OpenTelemetry Collector
    processors: batch, memory_limiter, attributes/redaction, tail_sampling
    exporters: Tempo/Jaeger/Phoenix/Langfuse/OpenLIT/Prometheus
```

## Crate 级设计

### `harness-core`

职责：

- 在 `Agent::run` 和 `Agent::run_stream` 中创建 agent run span。
- 每次 LLM 调用前后创建 iteration span。
- 在工具调用前后发 `ToolStart` / `ToolEnd` 对齐的 tracing events。
- 记录 loop outcome：iterations、finish reason、是否命中 max iterations、错误类型。
- 不初始化 OTel exporter。

建议新增内部辅助：

```rust
pub struct RunTelemetry {
    pub run_id: String,
    pub conversation_id: Option<String>,
    pub transport: Option<String>,
    pub profile: Option<String>,
    pub capture_content: bool,
}
```

短期可以不把它暴露到 public API，而是先通过 `tracing::Span::current()` 继承上层字段。
如果后续需要跨进程或 eval 注入 case id，再把它变成 `RunOptions` 的一部分。

### `harness-llm`

职责：

- 在每个 provider 的 `complete` / `complete_stream` 外创建 `gen_ai.chat` span。
- 记录 provider、model、base url host、streaming、finish reason、token usage。
- streaming 需要记录：
  - first chunk latency
  - first content delta latency
  - finish latency
  - tool call fragment count
  - accumulator finalise reason

Provider errors 仍然映射为 `harness_core::Error::Provider(String)`，span 上记录
`error.type` 和经过脱敏的错误摘要。

### `harness-tools`

职责：

- 在 builtin tool invoke 外创建 `gen_ai.tool.call` span。
- 记录 tool name、tool group、root scope、read/write risk、参数 schema hash、参数大小。
- 对 `fs.*`、`shell.*`、`http.fetch` 做额外风险字段。
- 工具返回内容默认不写 span，只记录 output bytes 和 output hash。
- 对 `claude_code.run` / `codex.run` 这类 CLI sub-agent tool，创建黑盒
  `jarvis.subagent.process` child span，并记录进程、退出码、stdout/stderr 大小。

### `harness-mcp`

职责：

- `McpClient::connect` 记录 server connect span。
- `register_into` 记录 remote tool list 数量、prefix、schema hash。
- `RemoteTool::invoke` 记录 remote call span。
- MCP tool error 作为 tool span 的 error status，同时保留原有行为：向模型返回可读错误文本。

### `harness-subagents`

职责：

- 对每次 `SubAgent::invoke` 创建 `jarvis.subagent.run` span。
- 在 `SubAgentTool` 包装层把主 agent 的 `gen_ai.tool.call subagent.<name>` span
  与内部 `jarvis.subagent.run` span 串起来。
- 对 internal subagent 复用 `Agent::run_stream`，让 subagent 内部 LLM / tool spans
  自然成为 `jarvis.subagent.run` 的子 span。
- 对 CLI / SDK sidecar subagent，在启动进程时注入 W3C `TRACEPARENT` / `TRACESTATE`。
- 解析外部 agent 的 stdout JSON Lines 时，把 `SubAgentEvent` 同步转成 span events。
- 记录 subagent 类型、版本、模型、sandbox、审批模式、caller chain、artifact id。

SubAgent 分三类处理：

| 类型 | 例子 | 观测方式 |
| --- | --- | --- |
| internal | `subagent.codex`、`subagent.review`、`subagent.read_doc` | Jarvis 自己发完整 OTel；内部 LLM/tool spans 可见 |
| streaming CLI / SDK sidecar | `subagent.claude_code` | Jarvis 发 wrapper span，同时把 `TRACEPARENT` 传给 CLI；如果外部 agent 支持 OTel，则接入同一 trace |
| black-box CLI tool | `claude_code.run`、`codex.run` | Jarvis 只观测进程级 span、输入/输出大小、退出码、耗时、diff/artifact |

Claude Code 当前支持 OpenTelemetry metrics/logs，并可通过 beta tracing 导出 spans。
Jarvis 对 Claude Code 的最佳路径是 `both`：Jarvis 发 `jarvis.subagent.run` wrapper
span，同时把 `TRACEPARENT` 注入 Claude Code 子进程，让 Claude Code 原生 spans 挂到
同一 trace。Codex 官方文档目前没有明确公开等价的 OTel exporter 说明；Jarvis 对 Codex
的优先路径仍是 internal subagent，这样可以获得完整 trace。如果用户选择 `codex.run`
CLI 黑盒路径，则只保证进程级观测。

### `harness-server`

职责：

- HTTP / SSE / WebSocket 创建 root span。
- 记录 transport、route、status、conversation id、workspace id、project id、profile id。
- WebSocket 每个 user turn 创建 child span，而不是把整个 socket 生命周期当作一个不可读的大 span。
- SSE / WS 记录断连、取消、客户端 backpressure。

### `harness-store`

职责：

- 对 conversation、workspace、project、requirement、permission 等存储操作记录 span。
- 记录 backend、operation、rows affected、payload bytes、latency、错误类型。
- 不记录消息正文，除非显式开启开发模式内容采集。
- 新增 observability / eval 持久化 store，默认 JSON-file，SQL backend 与现有 store
  一样通过 URL scheme 选择。

### `apps/jarvis`

职责：

- 唯一读取 OTel 相关环境变量。
- 初始化 `tracing_subscriber`、OTLP exporter、metrics exporter、sampling。
- 配置资源属性：service name、version、runtime、deployment environment。
- 配置 redaction layer。
- 把 observability 状态暴露给 `doctor` / server info。

建议新增环境变量：

| Env | 默认值 | 含义 |
| --- | --- | --- |
| `JARVIS_OTEL_ENABLED` | unset | 任意值开启 OTLP exporter |
| `JARVIS_OTEL_ENDPOINT` | `http://127.0.0.1:4317` | OTLP gRPC endpoint |
| `JARVIS_OTEL_PROTOCOL` | `grpc` | `grpc` 或 `http/protobuf` |
| `JARVIS_OTEL_SERVICE_NAME` | `jarvis` | OTel service.name |
| `JARVIS_OTEL_ENV` | `local` | deployment.environment.name |
| `JARVIS_OTEL_SAMPLE_RATIO` | `1.0` local, `0.05` prod | head sampling ratio |
| `JARVIS_OTEL_CAPTURE_CONTENT` | unset | opt-in 采集 prompt / response / args |
| `JARVIS_OTEL_CONTENT_MAX_BYTES` | `4096` | 单字段内容采集上限 |
| `JARVIS_OTEL_REDACT_KEYS` | built-in list | 额外脱敏 key，逗号分隔 |
| `JARVIS_OTEL_EXPORT_TIMEOUT_MS` | `3000` | exporter flush timeout |
| `JARVIS_OTEL_SUBAGENT_PROPAGATE` | `1` | 向支持的外部 subagent 注入 trace context |
| `JARVIS_OTEL_SUBAGENT_VENDOR_NATIVE` | `1` | 允许配置外部 agent 自身 OTel exporter |

SubAgent 相关环境变量：

| Env | 默认值 | 含义 |
| --- | --- | --- |
| `JARVIS_SUBAGENT_OTEL_MODE` | `wrapper` | `wrapper` / `native` / `both` |
| `JARVIS_CLAUDE_CODE_OTEL_NATIVE` | unset | 为 Claude Code 子进程开启官方 OTel |
| `JARVIS_CLAUDE_CODE_OTEL_TRACES` | unset | 为 Claude Code 子进程开启 beta traces |
| `JARVIS_CODEX_OTEL_NATIVE` | unset | 预留；Codex 官方支持明确后再接 |

推荐模式：

- `wrapper`：只由 Jarvis 观测 subagent wrapper。最安全，适合默认生产。
- `native`：外部 agent 自己直接发 OTel。适合 Claude Code 企业环境已有统一 Collector。
- `both`：Jarvis wrapper + 外部 agent 原生 OTel，靠 `TRACEPARENT` 合并 trace。适合调试。

## 本地数据存储

OTel trace 后端不是 Jarvis 产品看板的唯一数据源。Jarvis 需要一份自己可控、可迁移、
可离线查看的指标和 eval 事实库，用来支持：

- Work Overview / Harness Health 看板；
- eval run history、baseline、regression gate；
- SubAgent 对比分析；
- 没有 Collector / Tempo / Jaeger 时的本地开发体验；
- 将来把指标摘要挂到 Project / Requirement / Run 页面。

默认存储：本地 JSON-file，与现有 `harness-store` 的 JSON backend 习惯一致。SQL backend
与 conversation / project / requirement store 一样，通过 URL scheme 切换。

建议新增两个 trait，定义在 `harness-core`，实现放在 `harness-store`：

```rust
#[async_trait]
pub trait ObservabilityStore: Send + Sync {
    async fn append_run(&self, run: &ObservedRun) -> Result<(), BoxError>;
    async fn append_span_summary(&self, span: &ObservedSpanSummary) -> Result<(), BoxError>;
    async fn append_metric_point(&self, point: &MetricPoint) -> Result<(), BoxError>;
    async fn list_runs(&self, filter: ObservabilityFilter) -> Result<Vec<ObservedRun>, BoxError>;
    async fn dashboard(&self, window: TimeWindow) -> Result<DashboardSnapshot, BoxError>;
}

#[async_trait]
pub trait EvalStore: Send + Sync {
    async fn save_suite_run(&self, run: &EvalSuiteRun) -> Result<(), BoxError>;
    async fn save_case_result(&self, result: &EvalCaseResult) -> Result<(), BoxError>;
    async fn save_baseline(&self, baseline: &EvalBaseline) -> Result<(), BoxError>;
    async fn load_baseline(&self, id: &str) -> Result<Option<EvalBaseline>, BoxError>;
    async fn list_case_results(&self, filter: EvalFilter) -> Result<Vec<EvalCaseResult>, BoxError>;
}
```

`harness-store::StoreBundle` 后续增加：

```rust
pub observability: Arc<dyn ObservabilityStore>,
pub evals: Arc<dyn EvalStore>,
```

### URL 与默认路径

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `JARVIS_OBSERVABILITY_STORE_URL` | `json:.jarvis/observability` | 指标、run summary、dashboard rollup |
| `JARVIS_EVAL_STORE_URL` | `json:.jarvis/evals` | eval suite/case/baseline |
| `JARVIS_OTEL_ARTIFACT_STORE_URL` | `json:.jarvis/otel-artifacts` | prompt/response/tool output/diff 等 artifact |

如果未设置这些变量，但设置了 `JARVIS_DB_URL`，有两种模式：

- 默认仍用本地 JSON，避免把高频观测点直接写进用户的主业务 DB。
- 设置 `JARVIS_OBSERVABILITY_USE_MAIN_STORE=1` 时，复用 `JARVIS_DB_URL` 对应 backend。

### JSON-file 布局

```text
.jarvis/
  observability/
    runs/
      2026-05-08/
        <run_id>.json
    spans/
      2026-05-08/
        <trace_id>.jsonl
    metrics/
      2026-05-08.jsonl
    rollups/
      hour/
        2026-05-08T10.json
      day/
        2026-05-08.json
    dashboards/
      latest.json
  evals/
    suites/
      <suite_run_id>.json
    cases/
      <suite_run_id>/
        <case_id>.json
    baselines/
      <baseline_id>.json
    reports/
      <suite_run_id>.json
  otel-artifacts/
    prompt/
    response/
    tool_output/
    subagent_frame/
    diff/
```

写入策略沿用 JSON-file store：

- 单 record 一个 JSON 文件或 JSONL 追加文件；
- 重要 record 使用 `<path>.tmp` + rename 原子写；
- id 到文件名做 percent-encode；
- list API 对小规模本地开发可直接扫描目录，SQL backend 用索引查询；
- 长文本只写 artifact，不进入 run summary。

### SQL 表形状

SQL backend 保持和 JSON 字段一一对应，便于迁移：

| 表 | 说明 |
| --- | --- |
| `observed_runs` | 一次 agent/subagent/eval run 的摘要 |
| `observed_span_summaries` | span 摘要，不保存大内容 |
| `observed_metric_points` | counter/histogram/gauge 的落点或预聚合值 |
| `observability_rollups` | hour/day rollup，服务看板快速读取 |
| `eval_suite_runs` | 一次 suite 执行 |
| `eval_case_results` | 每个 case 的 judge 分数、trace id、artifact id |
| `eval_baselines` | baseline JSON |
| `otel_artifacts` | artifact metadata，内容可在文件或对象存储 |

SQL 字段建议：

```text
id, trace_id, span_id, parent_span_id, run_id, conversation_id,
project_id, workspace_hash, kind, name, started_at, ended_at,
duration_ms, outcome, attributes_json, metrics_json, artifact_ids_json
```

`attributes_json` 保留 JSON blob 是刻意选择：OTel / GenAI 字段会演进，第一阶段不值得
为每个 attribute 建列。看板常用字段再单独建索引列，例如 `project_id`、`name`、
`kind`、`outcome`、`started_at`。

### 写入节奏

OTel exporter 和本地 store 是两条路径：

```text
tracing span/event
  -> OTLP exporter -> Collector / Tempo / Jaeger
  -> ObservabilityRecorder -> local JSON / SQL summaries
```

`ObservabilityRecorder` 不保存完整 trace，只保存产品看板需要的摘要：

- run summary；
- tool/subagent/provider 调用摘要；
- token / latency / error metric points；
- eval score；
- artifact metadata。

推荐异步批量写入：

- run 结束时写 `ObservedRun`；
- span 结束时写 `ObservedSpanSummary` 到 bounded channel；
- 每 5-10 秒 flush metric points；
- 进程退出时 best-effort flush；
- channel 满时丢弃低优先级 span summary，但保留 run/eval 结果。

## 看板设计

Jarvis 自带看板不是替代 Grafana，而是面向产品决策的“Agent 能力健康中心”。Grafana
适合查底层 trace；Jarvis 看板回答“能力是否变好、哪类任务退化、该调哪里”。

### 信息架构

建议在 Work Overview 增加一个 `Harness Observability` 页面或 tab，并在现有
`HarnessEvolutionPanel` / `HealthCenter` 上挂核心摘要。

页面分为 6 块：

| 区块 | 目标问题 | 关键数据 |
| --- | --- | --- |
| Overview | Jarvis 最近是否健康？ | success rate、p95 latency、eval pass rate、cost、error rate |
| Agent Loop | 主 agent 是否收敛？ | iterations、max_iterations hit、tool calls/run、finish reasons |
| LLM Providers | 模型/Provider 哪个慢或贵？ | token、first token、duration、finish reason、provider errors |
| Tools & MCP | 哪个工具不稳定？ | tool error rate、invalid args、permission denied、MCP timeout |
| SubAgents | Claude Code / Codex / reviewer 是否值得用？ | subagent success、duration、files changed、native trace linked、over-delegation |
| Evals & Regressions | 最近改动是否让能力退化？ | suite pass rate、failed cases、baseline delta、judge scores |

### 第一屏 KPI

第一屏只展示高信号指标：

| Card | 计算方式 | 状态阈值 |
| --- | --- | --- |
| Harness score | 加权分：成功率、eval、latency、tool errors、subagent errors | `>=80 ok`，`60-79 warn`，`<60 danger` |
| Run success rate | successful runs / total runs | `<95% warn`，`<85% danger` |
| Eval pass rate | latest suite pass rate | 低于 baseline 2pp warn |
| p95 latency | agent run p95 | 高于 baseline 20% warn |
| Tool error rate | failed tool calls / tool calls | `>5% warn` |
| SubAgent lift | SubAgent runs pass rate - no-subagent baseline | `<0 warn` |

### SubAgent 看板

SubAgent 区块需要专门设计，因为它不是普通工具调用。推荐表格：

| 列 | 说明 |
| --- | --- |
| SubAgent | `claude_code` / `codex` / `review` / `read_doc` |
| Kind | `internal` / `cli_streaming` / `cli_blackbox` |
| Runs | 调用次数 |
| Success | 成功率 |
| Median / p95 | 耗时 |
| Files changed | 平均修改文件数 |
| Tool calls | 子 agent 内部工具调用数，如可得 |
| Native trace | 外部原生 OTel 挂接率 |
| Lift | 对比无 SubAgent baseline 的 pass rate delta |
| Cost | token / estimated cost，如可得 |

点击某一行进入 drilldown：

- 最近 20 次 subagent run；
- trace id / run id；
- caller agent run；
- task hash 和 artifact link；
- frames timeline；
- files changed；
- error / timeout / exit code；
- 对应 eval case，如果这次 run 来自 eval。

### Eval 对比视图

Eval 页面支持四种比较：

| 比较 | 用途 |
| --- | --- |
| model vs model | 选 provider/model |
| no-subagent vs subagent | 证明 SubAgent 是否提升能力 |
| Claude Code vs Codex | 比较外部/内部 coder |
| branch vs baseline | PR/版本回归 |

展示：

- suite pass rate trend；
- case failure heatmap；
- judge score distribution；
- latency/cost scatter plot；
- failed case 列表，按 severity 排序；
- 每个 failed case 链接 trace 和 artifacts。

### 数据 API

新增 server routes：

| Route | 返回 |
| --- | --- |
| `GET /v1/observability/dashboard?window=24h` | `DashboardSnapshot` |
| `GET /v1/observability/runs?kind=agent&limit=50` | run 列表 |
| `GET /v1/observability/subagents?window=7d` | SubAgent 聚合 |
| `GET /v1/observability/tools?window=7d` | tool 聚合 |
| `GET /v1/evals/suites` | suite run 列表 |
| `GET /v1/evals/suites/:id` | suite 详情 |
| `GET /v1/evals/cases/:id` | case history |
| `GET /v1/evals/baselines` | baseline 列表 |

这些 route 读取 `ObservabilityStore` / `EvalStore`，不直接查询 Collector。需要 trace 深挖时，
UI 只展示 trace id，并按配置跳转到 Jaeger / Tempo / Phoenix / Langfuse。

### DashboardSnapshot shape

```json
{
  "window": "24h",
  "generated_at": "2026-05-08T10:00:00Z",
  "overview": {
    "harness_score": 86,
    "run_success_rate": 0.97,
    "eval_pass_rate": 0.91,
    "p95_latency_ms": 42000,
    "tool_error_rate": 0.03,
    "subagent_lift": 0.08
  },
  "agent_loop": {
    "runs": 128,
    "avg_iterations": 3.2,
    "max_iterations_hit_rate": 0.01,
    "finish_reasons": {"stop": 120, "error": 6, "max_iterations": 2}
  },
  "subagents": [
    {
      "name": "claude_code",
      "kind": "cli_streaming",
      "runs": 18,
      "success_rate": 0.89,
      "p95_duration_ms": 380000,
      "native_trace_link_rate": 0.94,
      "lift": 0.11
    }
  ],
  "regressions": [
    {
      "suite": "coding-smoke",
      "case_id": "coding-smoke-001",
      "baseline_score": 1.0,
      "latest_score": 0.0,
      "trace_id": "..."
    }
  ]
}
```

## Trace 规范

### Span 命名

| Span | 产生位置 | 说明 |
| --- | --- | --- |
| `http.request` | `harness-server` | HTTP request root |
| `ws.connection` | `harness-server` | WebSocket 连接生命周期 |
| `ws.turn` | `harness-server` | WebSocket 单轮用户输入 |
| `jarvis.agent.run` | `harness-core` | 一次 agent loop |
| `jarvis.agent.iteration` | `harness-core` | 一轮 LLM + tool dispatch |
| `gen_ai.chat` | `harness-llm` | 一次 provider completion |
| `gen_ai.tool.call` | `harness-core` 或 tool wrapper | 一次工具调用 |
| `mcp.client.connect` | `harness-mcp` | 连接外部 MCP server |
| `mcp.tool.list` | `harness-mcp` | 拉取 remote tool list |
| `jarvis.subagent.run` | `harness-subagents` | 一次 SubAgent 调用 |
| `jarvis.subagent.process` | `harness-subagents` / `harness-tools` | 一个外部 agent CLI 进程 |
| `jarvis.subagent.frame` | `harness-subagents` event | 一个 `SubAgentEvent` |
| `store.operation` | `harness-store` | 存储读写 |
| `jarvis.eval.suite` | `harness-eval` | 一个 eval suite |
| `jarvis.eval.case` | `harness-eval` | 一个 eval case |
| `jarvis.eval.judge` | `harness-eval` | 一次裁判 |

### 公共 attributes

所有 Jarvis span 都建议携带：

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `jarvis.run.id` | string | 单次 agent run id |
| `jarvis.conversation.id` | string | 会话 id，如果有 |
| `jarvis.workspace.id` | string | 工作区 id，如果有 |
| `jarvis.project.id` | string | 项目 id，如果有 |
| `jarvis.profile.id` | string | agent profile id，如果有 |
| `jarvis.transport` | string | `http` / `sse` / `ws` / `cli` / `eval` |
| `jarvis.tenant.id` | string | 多租户环境使用 |
| `jarvis.user.hash` | string | 用户 id hash，不记录原始 id |
| `jarvis.capture_content` | bool | 本 run 是否允许内容采集 |

### `jarvis.agent.run`

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `jarvis.agent.max_iterations` | int | 配置的最大轮数 |
| `jarvis.agent.iterations` | int | 实际轮数 |
| `jarvis.agent.finish_reason` | string | `stop` / `tool_calls` / `length` / `error` / `max_iterations` |
| `jarvis.agent.hit_max_iterations` | bool | 是否命中上限 |
| `jarvis.agent.tools.available.count` | int | registry 中工具数量 |
| `jarvis.agent.system_prompt.hash` | string | system prompt hash |
| `jarvis.agent.system_prompt.bytes` | int | system prompt 字节数 |
| `jarvis.agent.input.messages.count` | int | 输入消息数量 |
| `jarvis.agent.output.messages.count` | int | 输出后消息数量 |
| `jarvis.subagent.calls.count` | int | run 内 subagent 调用次数 |
| `jarvis.subagent.max_depth` | int | run 内最大 subagent 深度 |

Events：

| Event | 说明 |
| --- | --- |
| `jarvis.agent.system_prompt.injected` | 自动注入 system prompt |
| `jarvis.agent.iteration.start` | 进入新 iteration |
| `jarvis.agent.iteration.end` | iteration 完成 |
| `jarvis.agent.tool_dispatch.start` | 开始并发或顺序工具派发 |
| `jarvis.agent.tool_dispatch.end` | 工具派发完成 |

### `gen_ai.chat`

优先采用 OTel GenAI semantic conventions，Jarvis 扩展只放 `jarvis.*`。

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `gen_ai.provider.name` | string | `openai` / `anthropic` / `google` / `ollama` / `codex` |
| `gen_ai.request.model` | string | 请求模型 |
| `gen_ai.response.model` | string | 响应模型，如果 provider 返回 |
| `gen_ai.operation.name` | string | `chat` |
| `gen_ai.request.temperature` | double | 如适用 |
| `gen_ai.request.max_tokens` | int | 如适用 |
| `gen_ai.response.finish_reasons` | string[] | finish reason |
| `gen_ai.usage.input_tokens` | int | 输入 token |
| `gen_ai.usage.output_tokens` | int | 输出 token |
| `jarvis.llm.base_url.host` | string | base url host，不记录完整 URL path/query |
| `jarvis.llm.stream` | bool | 是否 streaming |
| `jarvis.llm.first_chunk_ms` | double | streaming 首个 chunk 延迟 |
| `jarvis.llm.first_content_delta_ms` | double | 首个文本 delta 延迟 |
| `jarvis.llm.tool_call.count` | int | 返回 tool call 数 |
| `jarvis.llm.retry.count` | int | provider 内部重试次数 |

默认不采集 message content。允许采集时，用 events 而不是 attributes：

| Event | 字段 |
| --- | --- |
| `gen_ai.system.message` | `content`, `content.hash`, `content.bytes` |
| `gen_ai.user.message` | `content`, `content.hash`, `content.bytes` |
| `gen_ai.assistant.message` | `content`, `content.hash`, `content.bytes` |
| `gen_ai.tool.message` | `content`, `content.hash`, `content.bytes`, `tool_call_id` |

### `gen_ai.tool.call`

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `gen_ai.tool.name` | string | 工具名 |
| `gen_ai.tool.description` | string | 可选，开发环境使用 |
| `jarvis.tool.group` | string | `fs` / `http` / `git` / `project` / `mcp` |
| `jarvis.tool.origin` | string | `builtin` / `mcp` / `plugin` / `subagent` |
| `jarvis.tool.args.bytes` | int | 参数 JSON 字节数 |
| `jarvis.tool.args.hash` | string | 参数 hash |
| `jarvis.tool.schema.hash` | string | JSON schema hash |
| `jarvis.tool.output.bytes` | int | 输出字节数 |
| `jarvis.tool.output.hash` | string | 输出 hash |
| `jarvis.tool.success` | bool | 是否成功 |
| `jarvis.tool.error.recoverable` | bool | 错误是否作为文本返回给模型 |
| `jarvis.permission.mode` | string | `ask` / `auto` 等 |
| `jarvis.permission.decision` | string | `allow` / `ask` / `deny` |

工具特定字段：

| Tool | Attribute | 说明 |
| --- | --- | --- |
| `fs.read` | `jarvis.fs.path.hash` | 文件路径 hash |
| `fs.read` | `jarvis.fs.bytes` | 读取字节数 |
| `fs.write` / `fs.patch` | `jarvis.fs.write.enabled` | 是否允许写 |
| `shell.exec` | `jarvis.shell.command.hash` | 命令 hash |
| `shell.exec` | `jarvis.shell.exit_code` | 退出码 |
| `http.fetch` | `http.request.method` | 请求方法 |
| `http.fetch` | `url.domain` | 域名，不记录完整 URL |
| `http.fetch` | `http.response.status_code` | 状态码 |
| MCP remote | `jarvis.mcp.server.prefix` | MCP prefix |

### `jarvis.subagent.run`

`jarvis.subagent.run` 表示一次被主 agent 委派出去的子任务。它既适用于
`harness-subagents` 的 `subagent.<name>` 工具，也适用于 `harness-tools` 中更黑盒的
`claude_code.run` / `codex.run`。

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `jarvis.subagent.id` | string | 单次 subagent invocation id |
| `jarvis.subagent.name` | string | `claude_code` / `codex` / `review` / `read_doc` |
| `jarvis.subagent.kind` | string | `internal` / `cli_streaming` / `cli_blackbox` / `sdk_sidecar` |
| `jarvis.subagent.vendor` | string | `anthropic` / `openai` / `jarvis` |
| `jarvis.subagent.model` | string | 子 agent 模型，如可得 |
| `jarvis.subagent.caller_chain` | string[] | 调用链，用于递归防护和 UI 嵌套 |
| `jarvis.subagent.depth` | int | 当前嵌套深度 |
| `jarvis.subagent.requires_approval` | bool | 外层调用是否审批 |
| `jarvis.subagent.workspace.hash` | string | workspace root hash |
| `jarvis.subagent.task.hash` | string | 委派任务 hash |
| `jarvis.subagent.task.bytes` | int | 委派任务字节数 |
| `jarvis.subagent.frames.count` | int | 发出的 `SubAgentEvent` 数 |
| `jarvis.subagent.tool_calls.count` | int | 子 agent 内部工具调用数，如可得 |
| `jarvis.subagent.files_changed.count` | int | 子 agent 修改文件数，如可得 |
| `jarvis.subagent.outcome` | string | `success` / `error` / `timeout` / `cancelled` |
| `jarvis.subagent.native_otel.enabled` | bool | 外部 agent 是否开启原生 OTel |
| `jarvis.subagent.trace_context.propagated` | bool | 是否向子进程注入 `TRACEPARENT` |

Events：

| Event | 说明 |
| --- | --- |
| `jarvis.subagent.started` | 对应 `SubAgentEvent::Started` |
| `jarvis.subagent.delta` | 文本 delta，默认只记录 bytes/hash |
| `jarvis.subagent.tool_start` | 子 agent 内部工具开始 |
| `jarvis.subagent.tool_end` | 子 agent 内部工具结束 |
| `jarvis.subagent.status` | 子 agent 状态消息 |
| `jarvis.subagent.done` | 子 agent 完成 |
| `jarvis.subagent.error` | 子 agent 出错 |

### `jarvis.subagent.process`

CLI / SDK sidecar 进程 span。Claude Code streaming CLI 和黑盒 `codex.run` 都用它。

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `process.command` | string | 只记录 basename，如 `claude` / `codex` |
| `process.command_args.count` | int | argv 数量 |
| `jarvis.process.cwd.hash` | string | cwd hash |
| `jarvis.process.exit_code` | int | 退出码 |
| `jarvis.process.signal` | string | 被 signal 结束时记录 |
| `jarvis.process.timeout_ms` | int | 超时设置 |
| `jarvis.process.stdout.bytes` | int | stdout 字节数 |
| `jarvis.process.stderr.bytes` | int | stderr 字节数 |
| `jarvis.process.stdout.truncated` | bool | stdout 是否截断 |
| `jarvis.process.stderr.truncated` | bool | stderr 是否截断 |
| `jarvis.process.traceparent.injected` | bool | 是否注入 trace context |

Claude Code 原生 spans 不强行改名，保留官方命名，例如 `claude_code.interaction`、
`claude_code.llm_request`、`claude_code.tool`。Jarvis 只要求这些 spans 与
`jarvis.subagent.process` 共享同一 trace，并通过 parent context 挂到同一棵树下。

### `store.operation`

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `db.system.name` | string | `sqlite` / `postgresql` / `mysql` / `memory` / `json_file` |
| `db.operation.name` | string | `save` / `load` / `list` / `delete` |
| `db.collection.name` | string | `conversations` / `projects` / `requirements` |
| `jarvis.store.payload.bytes` | int | 序列化 payload 字节数 |
| `jarvis.store.rows` | int | 影响行数 |

## Metrics 规范

### Agent metrics

| Metric | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `jarvis.agent.runs` | counter | `transport`, `profile`, `outcome` | agent run 数 |
| `jarvis.agent.duration` | histogram | `transport`, `profile`, `outcome` | 端到端耗时 |
| `jarvis.agent.iterations` | histogram | `transport`, `profile` | 每次 run 的 iteration 数 |
| `jarvis.agent.max_iterations.hit` | counter | `transport`, `profile` | 命中最大轮数 |
| `jarvis.agent.tool_calls` | histogram | `transport`, `profile` | 每次 run 工具调用数 |

### LLM metrics

| Metric | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `jarvis.llm.requests` | counter | `provider`, `model`, `stream`, `outcome` | LLM 请求数 |
| `jarvis.llm.duration` | histogram | `provider`, `model`, `stream` | LLM 总延迟 |
| `jarvis.llm.first_token.duration` | histogram | `provider`, `model` | 首 token 延迟 |
| `jarvis.llm.input_tokens` | counter | `provider`, `model` | 输入 token |
| `jarvis.llm.output_tokens` | counter | `provider`, `model` | 输出 token |
| `jarvis.llm.tool_calls` | counter | `provider`, `model`, `tool_name` | 模型请求工具次数 |

### Tool metrics

| Metric | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `jarvis.tool.calls` | counter | `tool_name`, `origin`, `outcome` | 工具调用数 |
| `jarvis.tool.duration` | histogram | `tool_name`, `origin` | 工具耗时 |
| `jarvis.tool.args.bytes` | histogram | `tool_name` | 参数大小 |
| `jarvis.tool.output.bytes` | histogram | `tool_name` | 输出大小 |
| `jarvis.tool.permission.denied` | counter | `tool_name`, `mode` | 权限拒绝 |
| `jarvis.tool.invalid_args` | counter | `tool_name` | 参数 schema 错误 |

### SubAgent metrics

| Metric | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `jarvis.subagent.runs` | counter | `name`, `kind`, `vendor`, `outcome` | SubAgent 调用数 |
| `jarvis.subagent.duration` | histogram | `name`, `kind`, `vendor` | SubAgent 总耗时 |
| `jarvis.subagent.frames` | counter | `name`, `event_type` | SubAgentFrame 数 |
| `jarvis.subagent.tool_calls` | counter | `name`, `tool_name`, `outcome` | 子 agent 内部工具调用 |
| `jarvis.subagent.process.duration` | histogram | `name`, `command`, `outcome` | 外部进程耗时 |
| `jarvis.subagent.process.exit` | counter | `name`, `command`, `exit_code` | 外部进程退出码 |
| `jarvis.subagent.files_changed` | histogram | `name`, `kind` | 每次调用修改文件数 |
| `jarvis.subagent.native_otel.linked` | counter | `name`, `vendor` | 成功挂接外部原生 trace 的次数 |

### Eval metrics

| Metric | 类型 | 标签 | 说明 |
| --- | --- | --- | --- |
| `jarvis.eval.cases` | counter | `suite`, `scenario`, `outcome` | eval case 数 |
| `jarvis.eval.score` | histogram | `suite`, `scenario`, `judge`, `score_name` | 分数 |
| `jarvis.eval.pass_rate` | gauge | `suite`, `scenario`, `model` | pass rate |
| `jarvis.eval.regression` | counter | `suite`, `scenario`, `baseline` | 回归数 |
| `jarvis.eval.cost.tokens` | counter | `suite`, `model`, `direction` | eval token 成本 |

## Eval Harness 设计

建议新增 `crates/harness-eval`，再提供一个 `jarvis eval` CLI 子命令。

### Dataset schema

使用 JSONL，便于版本管理和增量追加：

```json
{
  "id": "coding-smoke-001",
  "suite": "coding-smoke",
  "scenario": "rust-test-fix",
  "input": {
    "messages": [
      {"role": "user", "content": "Fix the failing message serialization test"}
    ],
    "workspace_fixture": "fixtures/rust-message-test",
    "profile": "coding"
  },
  "expected": {
    "must_call_tools": ["workspace.context", "rg.search", "fs.patch", "project.checks"],
    "must_not_call_tools": ["fs.write"],
    "subagents": {
      "allowed": ["codex", "claude_code", "review"],
      "must_call": [],
      "max_calls": 1
    },
    "final_contains": ["test", "cargo"],
    "max_iterations": 8
  },
  "judges": [
    {"type": "deterministic", "name": "tool_sequence"},
    {"type": "deterministic", "name": "workspace_diff"},
    {"type": "llm", "name": "answer_quality", "model": "gpt-4o-mini"}
  ],
  "tags": ["coding", "tool-use", "regression"]
}
```

### Eval case lifecycle

1. Load dataset case.
2. Prepare isolated workspace fixture.
3. Build `ToolRegistry` using the same composition path as `apps/jarvis`。
4. Create `jarvis.eval.case` span with case id、suite、scenario、model、profile。
5. Run `Agent::run` or `Agent::run_stream`。
6. Persist trace id、final conversation、tool timeline、workspace diff、command outputs as artifacts。
7. Execute deterministic judges。
8. Execute optional LLM judges。
9. Emit `jarvis.eval.score` events and metrics。
10. Compare against baseline and produce CLI / JSON / HTML report。

### Judge types

| Judge | 说明 |
| --- | --- |
| `exact_final` | final answer exact / regex match |
| `contains` | final answer 包含关键内容 |
| `tool_sequence` | 工具调用顺序、必须调用、禁止调用 |
| `tool_args` | 工具参数结构、路径范围、命令风险 |
| `subagent_selection` | 是否选择了合适的 SubAgent，是否过度委派 |
| `subagent_trace` | SubAgent wrapper span、frames、外部 process span 是否齐全 |
| `workspace_diff` | diff 是否符合 golden patch 或 semantic rule |
| `command_result` | 检查命令是否通过 |
| `trace_shape` | span 是否齐全，例如必须有 `gen_ai.tool.call` |
| `latency_budget` | p95 或单 case latency 是否超预算 |
| `cost_budget` | token / 请求次数是否超预算 |
| `llm_judge` | 使用裁判模型打分 |

### Eval score attributes

优先使用 OTel GenAI evaluation 字段：

| Attribute | 类型 | 说明 |
| --- | --- | --- |
| `gen_ai.evaluation.name` | string | judge 名 |
| `gen_ai.evaluation.score.value` | double | 数值分 |
| `gen_ai.evaluation.score.label` | string | `pass` / `fail` / `warn` |
| `gen_ai.evaluation.explanation` | string | 简短解释，避免长文本 |
| `jarvis.eval.case.id` | string | case id |
| `jarvis.eval.suite` | string | suite |
| `jarvis.eval.scenario` | string | 场景 |
| `jarvis.eval.dataset.version` | string | dataset 版本 |
| `jarvis.eval.baseline.id` | string | baseline id |
| `jarvis.eval.artifact.id` | string | 长内容 artifact id |

### Baseline

Baseline 不应该只存一个 pass rate。建议每个 suite 保存：

```json
{
  "id": "main-2026-05-07",
  "git_ref": "main",
  "dataset_version": "2026.05.07",
  "model": "gpt-4o-mini",
  "summary": {
    "pass_rate": 0.86,
    "p95_latency_ms": 38000,
    "avg_input_tokens": 8200,
    "avg_output_tokens": 1200,
    "tool_error_rate": 0.03,
    "max_iterations_hit_rate": 0.01
  },
  "cases": {
    "coding-smoke-001": {
      "outcome": "pass",
      "scores": {"tool_sequence": 1.0, "answer_quality": 0.82}
    }
  }
}
```

CI gate 示例：

- pass rate 不能比 baseline 低超过 2 个百分点。
- p95 latency 不能比 baseline 高超过 20%。
- tool invalid args rate 不能高于 5%。
- `max_iterations` hit rate 不能高于 3%。
- P0 smoke cases 必须 100% pass。

## 内容采集与安全

### 默认采集策略

| 数据 | 默认 | 说明 |
| --- | --- | --- |
| system prompt | hash + bytes | 不记录正文 |
| user message | hash + bytes | 不记录正文 |
| assistant response | hash + bytes | 不记录正文 |
| tool args | hash + bytes + selected safe fields | 不记录完整 JSON |
| tool output | hash + bytes + artifact id | 不记录正文 |
| subagent task | hash + bytes | 不记录正文 |
| subagent frames | event type + hash + bytes | 不记录 delta / tool result 正文 |
| file path | hash + basename 可选 | 不记录绝对路径 |
| shell command | hash + argv count | 开发模式可记录 |
| HTTP URL | domain + scheme | 不记录 path/query |
| API key / token | 永远脱敏 | 不允许 opt-in 明文 |

### Redaction

内置敏感 key：

```text
authorization, api_key, apikey, access_token, refresh_token, token,
password, passwd, secret, cookie, set-cookie, private_key, client_secret
```

规则：

- JSON object 中 key 命中敏感词时替换为 `[REDACTED]`。
- 字符串中匹配常见 token 形态时替换。
- URL query 全部移除。
- 环境变量不进入 span attributes，除非在 allowlist 中。
- panic / error chain 进入 span 前也走脱敏。

### Artifact 存储

长内容写入 artifact store，span 只记录：

| Attribute | 说明 |
| --- | --- |
| `jarvis.artifact.id` | artifact id |
| `jarvis.artifact.kind` | `prompt` / `response` / `tool_output` / `diff` |
| `jarvis.artifact.sha256` | 内容 hash |
| `jarvis.artifact.bytes` | 内容大小 |
| `jarvis.artifact.redacted` | 是否已脱敏 |

Artifact store 第一阶段可以是本地 `.jarvis/eval-artifacts/`，后续再接对象存储。

## 开源栈建议

### 默认本地开发栈

```text
Jarvis -> OTLP -> OpenTelemetry Collector -> Jaeger
                                      -> Prometheus
       -> json:.jarvis/observability
       -> json:.jarvis/evals
```

优点：轻、启动快、适合调 span shape；即使没启动 Collector，Jarvis 看板仍能从本地 JSON
读到 run/eval 摘要。

### 长期自建栈

```text
Jarvis -> OTLP -> OpenTelemetry Collector
                 -> Tempo
                 -> Prometheus
                 -> Loki
                 -> Grafana dashboards
       -> sqlite/postgres/mysql observability stores
       -> sqlite/postgres/mysql eval stores
```

优点：标准、可控、适合把 traces / metrics / logs 统一到 Grafana，同时 Jarvis 产品看板
保留自己的 query path。

### LLM 工作台选项

| 方案 | 用法 |
| --- | --- |
| Phoenix + OpenInference | AI trace debug、eval dataset、RAG/agent 分析 |
| Langfuse | prompt、dataset、trace、score 工作台 |
| OpenLIT | OTel-native LLM observability 和 eval |
| Opik | trace + eval + prompt optimization |
| Helicone | OpenAI-compatible gateway 侧观测 |

Jarvis 不应绑定任何一个平台 SDK。必要时在 Collector 或 exporter 层做适配。

## 实施计划

### Phase 0：文档和字段冻结

- 合并本 spec。
- 根据当前 OTel GenAI semantic conventions 校对字段。
- 冻结 `jarvis.*` 字段命名。
- 添加一份 `docs/observability/fields.md` 作为字段 registry。

验收：

- spec 可拆成 issue。
- 字段名没有与 OTel 标准冲突。

### Phase 1：Trace skeleton

- 在 workspace deps 加：
  - `opentelemetry`
  - `opentelemetry_sdk`
  - `opentelemetry-otlp`
  - `tracing-opentelemetry`
- `apps/jarvis` 初始化 OTLP exporter。
- `harness-server` 创建 request / ws turn spans。
- `harness-core` 创建 `jarvis.agent.run` 和 `jarvis.agent.iteration`。
- `harness-llm` 创建 `gen_ai.chat`。
- `harness-core` 或 tool wrapper 创建 `gen_ai.tool.call`。
- `harness-subagents` 创建 `jarvis.subagent.run`。
- `claude_code.run` / `codex.run` 创建 `jarvis.subagent.process`。
- 对外部 SubAgent 子进程注入 `TRACEPARENT` / `TRACESTATE`。
- 新增 `ObservabilityStore` / `EvalStore` trait skeleton。
- 新增 JSON-file backend，默认路径 `.jarvis/observability` / `.jarvis/evals`。

验收：

- 本地 Jaeger / Tempo 能看到完整请求 trace。
- 不启动 Collector 时，本地 JSON store 仍能写入 run summary。
- internal subagent 的内部 `gen_ai.chat` / `gen_ai.tool.call` 出现在
  `jarvis.subagent.run` 下。
- Claude Code 开启原生 OTel 时，官方 `claude_code.*` spans 能挂到同一 trace。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 未开启 `JARVIS_OTEL_ENABLED` 时行为与现在一致。

### Phase 2：Metrics

- 增加 agent / llm / tool counters 和 histograms。
- 把 metric points / run summary 写入 `ObservabilityStore`。
- 增加 `/v1/observability/dashboard`、`/runs`、`/subagents`、`/tools`。
- Collector 导出 Prometheus。
- 增加 Grafana dashboard JSON。
- `doctor` 显示 exporter 状态。

验收：

- 能按 model、tool、transport 看 p95 latency 和错误率。
- 能看到 token 用量趋势。
- Web UI 能读取本地 JSON store 并显示第一版 Harness Observability 看板。

### Phase 3：Eval runner

- 新增 `crates/harness-eval`。
- 新增 `jarvis eval run --dataset path --model name --report out.json`。
- 支持 deterministic judges。
- 记录 eval spans 和 score metrics。
- 支持 isolated workspace fixture。
- suite/case/baseline 写入 `EvalStore`。
- 支持按 `subagent_policy` 运行同一 suite：
  - `none`：禁止所有 SubAgent；
  - `internal`：只允许 internal SubAgent；
  - `external`：允许 Claude Code / Codex CLI；
  - `auto`：按产品默认策略。

验收：

- 至少有 `coding-smoke`、`tool-use-smoke`、`streaming-smoke` 三个 suite。
- 至少有 `subagent-selection-smoke` suite，对比不用 SubAgent、Codex internal、
  Claude Code external 三种路径。
- CI 能运行 smoke suite。
- eval report 中包含 trace id。
- Eval 页面能列出 suite run、case result 和 baseline delta。

### Phase 4：LLM judge 和 baseline

- 支持 LLM judge。
- 支持 baseline 文件。
- 支持 regression gate。
- 支持 HTML report。

验收：

- PR 可以输出 pass rate、latency、cost、回归 case 列表。
- 可以对比两个 model / provider。

### Phase 5：产品健康面板

- Web UI Work Overview 接入指标摘要。
- 完成 Harness Observability 页面：
  - run success rate
  - tool error rate
  - max iterations hit rate
  - p95 first token latency
  - eval pass rate
  - recent regressions
  - SubAgent lift / success / cost
- 支持点击 dashboard 卡片进入 run / trace / eval case drilldown。

验收：

- 用户能在 UI 中看到“Jarvis 最近是否变聪明或变差”。
- 用户能判断 Claude Code / Codex / reviewer 这类 SubAgent 是否值得继续启用。

## 测试策略

### Unit tests

- span attribute builder 不泄露敏感字段。
- redaction 对 nested JSON 生效。
- hash / bytes 计算稳定。
- provider usage 解析正确。
- streaming first chunk / finalise 指标正确。

### Integration tests

- 使用 in-memory exporter 捕获 spans。
- 跑一次 fake provider + fake tool agent run。
- 断言必须出现：
  - `jarvis.agent.run`
  - `jarvis.agent.iteration`
  - `gen_ai.chat`
  - `gen_ai.tool.call`
- 断言 tool error 不会中断 loop，而是作为文本返回给模型。

### E2E tests

- 启动 Jarvis + Collector + Jaeger。
- 发 WebSocket 多轮请求。
- 通过 OTLP test receiver 或 trace API 验证 trace shape。
- 运行 eval smoke suite。

## Eval Harness 迭代：trial / grader / transcript

参考 Anthropic 对 agent eval 的拆解，Jarvis 的 eval 不应只存最终
`pass/fail`。评测对象是“模型 + agent harness + tool/subagent 编排”的组合，
因此每个 case 需要记录：

- `suite_kind`：`capability` / `regression` / `smoke` / `other`。
  - capability suite 用于衡量新能力爬坡，低通过率可接受。
  - regression suite 用于发布门禁，目标应接近 100%。
- `trial_index` / `trial_count`：支持非确定性 agent 的重复试验。
  - `pass@k`：同一任务多次 trial 至少成功一次。
  - `pass^k`：同一任务多次 trial 每次都成功，用于稳定性判断。
- `grader_results`：按 grader 类型结构化记录判断来源。
  - deterministic test
  - static analysis
  - state check
  - tool call
  - transcript review
  - LLM rubric
  - human review
- `transcript_artifact_id`：失败时必须能回看 transcript / tool timeline /
  subagent timeline，避免把 task 模糊、grader bug、infra flake 误判成 agent 能力问题。
- `failure_class`：`agent_error` / `grader_bug` / `ambiguous_task` /
  `infra_flake` / `safety_refusal` / `unknown`。

第一版实现：

- core 增加 `EvalSuiteKind`、`EvalGraderKind`、`EvalGraderVerdict`、
  `EvalFailureClass`、`EvalGraderResult`。
- JSON eval store 支持按 `suite_kind` 过滤 case result。
- server 增加 `GET /v1/evals/summary`：
  - capability / regression pass rate
  - pass@k / pass^k
  - grader kind 分布
  - failure class 分布
  - transcript 覆盖数
- Work Overview 的 Harness 可观测性面板增加 Eval 成熟度指标。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| OTel GenAI 语义仍在演进 | `jarvis.*` 字段隔离，定期校对官方 spec |
| 内容泄露 | 默认关闭内容采集，强制 redaction，生产禁用明文 token |
| span cardinality 爆炸 | 路径、用户、prompt 使用 hash；tool name/model 这类低基数字段才做标签 |
| 性能开销 | 默认不开 exporter；batch export；大内容 artifact 化 |
| eval LLM judge 不稳定 | deterministic judges 优先，LLM judge 只做辅助分 |
| 平台锁定 | 只发 OTLP，不在 core crates 依赖平台 SDK |

## 参考资料

- OpenTelemetry GenAI spans:
  <https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/>
- OpenTelemetry GenAI agent spans:
  <https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/>
- OpenTelemetry GenAI attributes registry:
  <https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/>
- OpenTelemetry Collector:
  <https://github.com/open-telemetry/opentelemetry-collector>
- Claude Code monitoring:
  <https://docs.anthropic.com/en/docs/claude-code/monitoring-usage>
- Codex docs:
  <https://developers.openai.com/codex>
- Grafana Tempo:
  <https://grafana.com/docs/tempo/latest/>
- Jaeger:
  <https://www.jaegertracing.io/>
- Phoenix / OpenInference:
  <https://github.com/Arize-ai/phoenix>
- Langfuse:
  <https://github.com/langfuse/langfuse>
- OpenLIT:
  <https://github.com/openlit/openlit>
- promptfoo:
  <https://github.com/promptfoo/promptfoo>
- DeepEval:
  <https://github.com/confident-ai/deepeval>
- Anthropic, Demystifying evals for AI agents:
  <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
