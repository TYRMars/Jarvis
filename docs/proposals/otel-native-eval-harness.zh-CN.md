# OTel 原生 LLM/Agent Eval Harness 埋点体系

**状态：** Proposed
**涉及：** `harness-core`、`harness-llm`、`harness-tools`、`harness-mcp`、
`harness-server`、`harness-store`、`apps/jarvis`、未来 `crates/harness-eval`。

## 背景

Jarvis 的核心价值不是只把一次 LLM 调用包成接口，而是提供一个可以运行工具、维护
会话、处理审批、连接 MCP、流式返回事件，并最终面向 Chat / Work / Docs 复用的
Agent harness。随着能力变多，仅靠日志很难回答下面这些问题：

- 某个模型升级后，agent 是否更容易错误调用工具？
- 某类任务的失败是模型问题、工具 schema 问题、权限审批问题，还是工作区上下文不足？
- SSE / WebSocket 里用户感觉“慢”，到底慢在首 token、工具执行、模型尾延迟，还是存储？
- `max_iterations` 命中率是否上升，是否意味着 agent loop 需要更好的收敛策略？
- MCP remote tools 是否比 builtin tools 更不稳定？
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

4. **eval 是 trace 的读者，不是另一套运行时。**
   eval runner 调用同一个 `Agent` / provider / tool registry，不复制 agent loop。它只负责
   组织 dataset、注入 expected metadata、执行 judge、写入分数。

5. **平台可替换。**
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

### `harness-mcp`

职责：

- `McpClient::connect` 记录 server connect span。
- `register_into` 记录 remote tool list 数量、prefix、schema hash。
- `RemoteTool::invoke` 记录 remote call span。
- MCP tool error 作为 tool span 的 error status，同时保留原有行为：向模型返回可读错误文本。

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
```

优点：轻、启动快、适合调 span shape。

### 长期自建栈

```text
Jarvis -> OTLP -> OpenTelemetry Collector
                 -> Tempo
                 -> Prometheus
                 -> Loki
                 -> Grafana dashboards
```

优点：标准、可控、适合把 traces / metrics / logs 统一到 Grafana。

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

验收：

- 本地 Jaeger / Tempo 能看到完整请求 trace。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 未开启 `JARVIS_OTEL_ENABLED` 时行为与现在一致。

### Phase 2：Metrics

- 增加 agent / llm / tool counters 和 histograms。
- Collector 导出 Prometheus。
- 增加 Grafana dashboard JSON。
- `doctor` 显示 exporter 状态。

验收：

- 能按 model、tool、transport 看 p95 latency 和错误率。
- 能看到 token 用量趋势。

### Phase 3：Eval runner

- 新增 `crates/harness-eval`。
- 新增 `jarvis eval run --dataset path --model name --report out.json`。
- 支持 deterministic judges。
- 记录 eval spans 和 score metrics。
- 支持 isolated workspace fixture。

验收：

- 至少有 `coding-smoke`、`tool-use-smoke`、`streaming-smoke` 三个 suite。
- CI 能运行 smoke suite。
- eval report 中包含 trace id。

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
- 展示 harness health：
  - run success rate
  - tool error rate
  - max iterations hit rate
  - p95 first token latency
  - eval pass rate
  - recent regressions

验收：

- 用户能在 UI 中看到“Jarvis 最近是否变聪明或变差”。

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
