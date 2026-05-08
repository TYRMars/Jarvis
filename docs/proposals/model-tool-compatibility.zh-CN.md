# Model & Tool Compatibility：多模型、工具生态与并行执行能力

**Status:** Proposed.
**Touches:** `harness-core` 扩展模型能力元数据与工具分类，
`harness-llm` 增加 provider profile / OpenAI-compatible adapter family，
`harness-tools` 做工具目录、风险分类与 capability packs，
`harness-mcp` 增强 MCP server registry / 过滤 / 健康检查，
`harness-subagents` 承接并行子智能体执行，
`harness-server` 提供 providers / tools / MCP / subagents 管理 API，
`apps/jarvis` 负责配置、凭据、运行时 provider 构造，
`apps/jarvis-web` 提供模型切换、工具市场、MCP 管理和并行运行可视化。

## Motivation

Jarvis 已经具备一个不错的最小 agent runtime：

- `ProviderRegistry` 可以按 `provider/model` 或 prefix rule 路由模型。
- `ProviderAdmin` 已经支持 Web UI 运行时新增 / 修改 provider。
- `harness-llm` 已有 OpenAI、OpenAI Responses、Codex、Anthropic、Google 等实现。
- `harness-tools` 已有文件、grep、git、shell、doc、project、requirement、todo、Codex / Claude Code run 等工具。
- `harness-mcp` 已能把外部 MCP server 的工具接进 Jarvis。
- `harness-subagents` 已有设计方向。

但这些能力还没有组合成一个面向用户的“强大工具与模型兼容性”体验：

- 用户希望自由切换 Nous Portal、OpenRouter、NVIDIA NIM、OpenAI、
  Hugging Face、本地 Ollama / LM Studio、以及 Kimi / Moonshot、MiniMax、
  Xiaomi MiMo 等国产模型。
- 不同模型的能力不同：tool calls、reasoning、vision、context window、
  structured output、parallel tool calls、prompt cache，并不能只靠字符串模型名处理。
- 工具数量会持续增长，必须有工具分类、风险、启用策略、MCP 健康检查和 UI 管理。
- Work 场景需要并行处理：主 Agent 拆任务，多个隔离 SubAgent 同时跑，
  最后汇总验证，而不是一个 loop 串行完成所有事。

本 proposal 目标是把 Jarvis 提升为“模型自由切换 + 工具生态开放 + 并行 Agent
执行”的能力平台。

## Product alignment

这不是新的顶层产品面，而是 Chat / Work / Doc 的运行时底座：

- **Chat**：用户随时切换模型、选择低成本/高智能/本地隐私模式。
- **Work**：根据任务类型自动路由模型和工具，必要时派生 SubAgents 并行执行。
- **Doc**：长上下文模型负责资料整理，便宜模型做摘要和格式转换。
- **Capability packs**：Coding、Office、Research、Cloud Ops 等能力包声明自己需要哪些工具与模型能力。

第一阶段以 Coding Work 为落点：OpenRouter / Nous Portal / NIM / 国产模型接入、
Codex / Claude Code 子智能体、MCP 工具管理、工具风险策略。

## Non-goals

- 不把每个模型厂商 SDK 都引进核心 crate。
- 不让 `harness-core` 读取 env、管理密钥、知道 provider 细节。
- 不默认开启高风险工具，例如 shell、写文件、git write、外部 subagent。
- 不承诺每个 OpenAI-compatible endpoint 都完全兼容所有功能。
- 不在第一版做完整工具市场计费、插件商店或云端多租户 marketplace。

## Design principles

1. **Provider profile over provider hardcode.**
   OpenAI-compatible 端点大多可以共用 transport，差异通过 profile 描述。

2. **Capability-aware routing.**
   模型不只是名字，还要声明能力：tool calls、streaming、reasoning、vision、
   context window、max output、json schema、parallel tools。

3. **Tools are products, not just functions.**
   每个工具要有 category、risk、approval policy、source、健康状态、文档入口。

4. **MCP is first-class.**
   第三方工具通过 MCP 接入后，应和内置工具一样出现在工具目录、权限策略和 UI 中。

5. **Parallelism is explicit and observable.**
   SubAgent 每个实例有 id、状态、模型、工具集、事件流和产物，不做黑盒后台线程。

6. **Composition root owns secrets.**
   `apps/jarvis` 管 provider construction、auth_store、config/env fallback；
   library crates 只接收构造好的 trait object。

## Capability model

新增模型能力元数据，用于 UI 展示、自动路由、fallback 和 tool compatibility。

```rust
pub struct ModelCapability {
    pub provider: String,
    pub model: String,
    pub display_name: Option<String>,
    pub family: Option<String>,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub input_modalities: Vec<Modality>,
    pub output_modalities: Vec<Modality>,
    pub supports_streaming: bool,
    pub supports_tool_calls: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_json_schema: bool,
    pub supports_reasoning: bool,
    pub supports_prompt_cache: bool,
    pub supports_images: bool,
    pub supports_embeddings: bool,
    pub cost_hint: CostHint,
    pub latency_hint: LatencyHint,
    pub privacy_hint: PrivacyHint,
}

pub enum Modality {
    Text,
    Image,
    Audio,
    Video,
}

pub enum CostHint {
    FreeLocal,
    Low,
    Medium,
    High,
    Unknown,
}

pub enum LatencyHint {
    Fast,
    Balanced,
    Slow,
    Unknown,
}

pub enum PrivacyHint {
    Local,
    FirstPartyCloud,
    ThirdPartyRouter,
    Unknown,
}
```

这些字段来自三个来源，优先级从高到低：

1. 用户配置显式覆盖。
2. Provider profile 内置 catalog。
3. 运行时探测或保守默认。

## Provider architecture

### ProviderProfile

新增 `ProviderProfile` 作为 provider kind 的声明，而不是在 `build_provider`
里不断加 match 分支。

```rust
pub struct ProviderProfile {
    pub kind: String,
    pub display_name: String,
    pub transport: ProviderTransport,
    pub default_base_url: Option<String>,
    pub auth: AuthKind,
    pub default_model: String,
    pub model_catalog: Vec<ModelCapability>,
    pub model_prefixes: Vec<String>,
    pub request_compat: RequestCompat,
}

pub enum ProviderTransport {
    OpenAiChatCompletions,
    OpenAiResponses,
    AnthropicMessages,
    GoogleGenerateContent,
    HuggingFaceInference,
    LocalAdapter,
}

pub enum AuthKind {
    ApiKeyHeader { header: String, scheme: Option<String> },
    Bearer,
    CodexOAuth,
    None,
}

pub struct RequestCompat {
    pub tool_call_style: ToolCallStyle,
    pub json_schema_style: JsonSchemaStyle,
    pub reasoning_style: ReasoningStyle,
    pub model_field_passthrough: bool,
}
```

这样 Nous Portal / OpenRouter / NIM / Moonshot / MiniMax / MiMo 等
如果走 OpenAI-compatible 协议，只需要一个 profile，而不是一个新 provider impl。

### Built-in profiles

第一批内置 profiles：

| kind | transport | 默认 base URL | 备注 |
|---|---|---|---|
| `openai` | OpenAI Chat Completions | `https://api.openai.com/v1` | API key |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` | reasoning / encrypted reasoning |
| `codex` | Responses-compatible | ChatGPT Codex backend | OAuth / Codex auth |
| `anthropic` | Anthropic Messages | Anthropic API | Claude 系列 |
| `google` | Google GenerateContent | Gemini API | Gemini 系列 |
| `openrouter` | OpenAI-compatible | `https://openrouter.ai/api/v1` | 多模型路由 |
| `nous` | OpenAI-compatible | Nous Portal URL | Nous 模型 |
| `nvidia-nim` | OpenAI-compatible | NIM endpoint | 企业 / self-host |
| `huggingface` | HF Inference | HF endpoint | Serverless / endpoint |
| `moonshot` | OpenAI-compatible | `https://api.moonshot.cn/v1` | Kimi / Moonshot |
| `minimax` | OpenAI-compatible | MiniMax endpoint | 国产模型 |
| `mimo` | OpenAI-compatible | Xiaomi MiMo endpoint | 国产模型 |
| `ollama` | OpenAI-compatible-ish | `http://localhost:11434/v1` | 本地 |
| `lmstudio` | OpenAI-compatible | `http://localhost:1234/v1` | 本地 |

具体 URL 可以由 config 覆盖。内置 profile 的目的不是锁死厂商，而是让用户在 UI
里选择时不必记住协议细节。

### Config shape

保持当前 `providers` map，但允许 `kind` 与 profile 字段：

```json
{
  "default_provider": "openrouter",
  "providers": {
    "openrouter": {
      "enabled": true,
      "kind": "openrouter",
      "default_model": "anthropic/claude-sonnet-4.5",
      "models": [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-5.4",
        "nousresearch/hermes-4"
      ]
    },
    "kimi": {
      "enabled": true,
      "kind": "moonshot",
      "default_model": "kimi-k2-thinking"
    },
    "nim": {
      "enabled": true,
      "kind": "nvidia-nim",
      "base_url": "https://integrate.api.nvidia.com/v1",
      "default_model": "meta/llama-3.3-70b-instruct"
    }
  }
}
```

`api_key` 仍不写入 config，走 `auth_store`。

## Model switching

### Request-level switching

当前 `provider` 字段、`provider/model` 写法和 prefix rule 保留。
新增 capability validation：

- 请求要求工具调用，但目标模型 `supports_tool_calls = false`：返回明确错误或自动 fallback。
- 请求开启 reasoning，但目标模型不支持：降级并记录 warning。
- 请求包含图片，但模型不支持 vision：拒绝或路由到 vision-capable fallback。

### Runtime picker

Web UI 的模型选择器展示：

- provider 分组。
- model 搜索。
- 能力 badge：tools、vision、reasoning、long context、local、router。
- cost / latency / privacy hint。
- “设为默认”与“仅本次会话使用”。

### Auto routing

新增 `ModelRoutePolicy`：

```rust
pub struct ModelRoutePolicy {
    pub default: ModelTarget,
    pub coding: Option<ModelTarget>,
    pub review: Option<ModelTarget>,
    pub summarization: Option<ModelTarget>,
    pub doc_reader: Option<ModelTarget>,
    pub vision: Option<ModelTarget>,
    pub local_private: Option<ModelTarget>,
    pub fallbacks: Vec<ModelTarget>,
}

pub struct ModelTarget {
    pub provider: String,
    pub model: String,
}
```

主 Agent 可继续用默认模型；SubAgents 和后台任务按 slot 使用不同模型。

## Tool catalog

Jarvis 应把所有工具统一成一个目录，无论来源是 built-in、MCP、plugin、subagent wrapper。

```rust
pub struct ToolMetadata {
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub category: ToolCategory,
    pub source: ToolSource,
    pub risk: ToolRisk,
    pub enabled: bool,
    pub requires_approval: bool,
    pub input_schema: serde_json::Value,
    pub output_shape: ToolOutputShape,
    pub health: ToolHealth,
}

pub enum ToolSource {
    Builtin,
    Mcp { server: String },
    Plugin { plugin: String },
    SubAgent { subagent: String },
}

pub enum ToolCategory {
    Search,
    Web,
    FileRead,
    FileWrite,
    CodeSearch,
    CodeEdit,
    Shell,
    Git,
    Project,
    Requirement,
    Todo,
    Doc,
    Memory,
    Skill,
    Cloud,
    Media,
    SubAgent,
    Other,
}

pub enum ToolRisk {
    ReadOnly,
    MetadataWrite,
    WorkspaceWrite,
    Shell,
    Network,
    ExternalSideEffect,
    SecretAccess,
}
```

`Tool` trait 本身可以保持不变；metadata 可以通过旁路 registry 存储：

```rust
pub struct ToolRegistryEntry {
    pub tool: Arc<dyn Tool>,
    pub metadata: ToolMetadata,
}
```

### Built-in tool expansion target

现有 built-ins 已覆盖一大块基础能力。目标不是凑数字，而是形成 40+ 个稳定、
可管理的工具，按能力包启用：

| Pack | 工具示例 |
|---|---|
| Core read | `time.now`, `echo`, `ask.text`, `workspace.context` |
| Web | `http.fetch`, `web.search`, `web.extract`, `browser.open` |
| Files | `fs.read`, `fs.list`, `fs.write`, `fs.edit`, `fs.patch`, `fs.stat`, `fs.search` |
| Code | `code.grep`, `triage.scan`, `project.checks`, `test.run` |
| Shell | `shell.exec`, `shell.background`, `shell.kill`, `shell.logs` |
| Git | `git.status`, `git.diff`, `git.log`, `git.show`, `git.add`, `git.commit`, `git.merge`, `git.branch` |
| Work | `project.*`, `requirement.*`, `roadmap.import`, `todo.*` |
| Doc | `doc.*`, `doc.draft.*`, `doc.export` |
| Learning | `memory.*`, `skill.*`, `learning.review` |
| SubAgents | `subagent.run`, `codex.run`, `claude_code.run`, `reviewer.run`, `doc_reader.run` |
| MCP | `mcp.list`, `mcp.call`, `mcp.health`, `mcp.reload` |

每个 pack 都可以在 config/UI 中启用、禁用、设风险策略。

## MCP compatibility

当前 config 已支持 legacy string 和 structured spec。本 proposal 增强为完整 MCP registry。

### McpServer model

```rust
pub struct McpServerConfig {
    pub name: String,
    pub enabled: bool,
    pub transport: McpTransport,
    pub env: BTreeMap<String, String>,
    pub allow_tools: Option<Vec<String>>,
    pub deny_tools: Vec<String>,
    pub alias: BTreeMap<String, String>,
    pub risk_overrides: BTreeMap<String, ToolRisk>,
    pub timeout_ms: Option<u64>,
    pub restart_policy: RestartPolicy,
}
```

### Requirements

- MCP server 启动失败不应导致 Jarvis 启动失败，除非被标记为 required。
- 每个 MCP server 有 health 状态：configured、starting、ready、failed、disabled。
- UI 可以 reload 单个 server。
- 远程工具命名保持 `<server>.<tool>`，alias 只改 local short name，不丢 source。
- schema 非 object 时按现有策略替换为空 object，但 health warning 要显示。
- 所有 MCP 工具进入同一 Tool Catalog 和 Approval Policy。

### MCP REST API

```text
GET    /v1/mcp/servers
POST   /v1/mcp/servers
PATCH  /v1/mcp/servers/:name
DELETE /v1/mcp/servers/:name
POST   /v1/mcp/servers/:name/reload
GET    /v1/mcp/tools
```

## Parallel SubAgents

并行执行不应只是暴露 `codex.run` 和 `claude_code.run` 两个工具。
需要一个统一的 `SubAgentRuntime`：

```rust
pub struct SubAgentSpec {
    pub name: String,
    pub description: String,
    pub model: ModelTarget,
    pub tool_pack: Vec<String>,
    pub max_iterations: u32,
    pub workspace_isolation: WorkspaceIsolation,
    pub can_write: bool,
}

pub struct SubAgentRun {
    pub id: String,
    pub spec_name: String,
    pub task: String,
    pub status: SubAgentStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub events: Vec<SubAgentEvent>,
    pub artifacts: Vec<ArtifactRef>,
}
```

### Execution policy

- 主 Agent 可调用 `subagent.run` 派生一个或多个子任务。
- 子 Agent 默认隔离 conversation、tool registry、iteration budget。
- 子 Agent 默认不能再派生子 Agent，除非 spec 允许。
- 并发上限默认 3，可配置。
- 子 Agent 的中间 tool calls 不污染主 conversation，只把 summary / artifacts 回传。
- UI 必须显示每个 SubAgent 的事件流、工具调用、耗时、最终结果。

### Batch mode

支持：

```json
{
  "tasks": [
    { "subagent": "doc_reader", "task": "阅读 API 文档，提取认证流程" },
    { "subagent": "codex", "task": "实现 provider profile loader" },
    { "subagent": "reviewer", "task": "检查方案中的安全漏洞" }
  ],
  "join": "summarize"
}
```

`join` 策略：

- `summarize`：主 Agent 汇总结果。
- `race`：第一个成功结果返回。
- `all_required`：任一失败则整体失败。
- `best_effort`：失败子任务作为 warning。

## Permission and safety

工具与模型兼容性越强，默认安全边界越重要。

### Policy matrix

| Risk | Default | Notes |
|---|---|---|
| ReadOnly | allow | `fs.read`, `git.diff`, `http.fetch` 可直接用 |
| MetadataWrite | allow / audit | TODO、Project metadata 可较宽松 |
| WorkspaceWrite | approval | `fs.edit`, `fs.patch`, doc 写入 |
| Shell | approval / sandbox | 默认关闭；开启也要 timeout / sandbox |
| Network | allow read / approval side effect | MCP / HTTP POST 需要分类 |
| ExternalSideEffect | approval | Slack、GitHub mutation、cloud mutation |
| SecretAccess | deny by default | 只能通过受控 credential provider |

### Provider safety

- Router provider（OpenRouter、Nous Portal 等）显示隐私提示：请求会经过第三方路由。
- Local provider（Ollama、LM Studio）显示 local badge。
- 企业 endpoint（NIM、自托管 OpenAI-compatible）允许设置 data boundary label。

## REST API

### Providers

现有 `/v1/providers` 保留，扩展字段：

```text
GET    /v1/providers
GET    /v1/providers/:name
POST   /v1/providers
PATCH  /v1/providers/:name
DELETE /v1/providers/:name
PUT    /v1/providers/default
GET    /v1/model-catalog
POST   /v1/providers/:name/probe
```

`probe` 做最小连通性测试：

- auth 是否有效。
- default model 是否能完成短请求。
- 是否支持 streaming。
- 是否支持 tool calls。

### Tools

```text
GET    /v1/tools
PATCH  /v1/tools/:name
GET    /v1/tool-packs
PATCH  /v1/tool-packs/:name
```

### SubAgents

```text
GET    /v1/subagents
POST   /v1/subagents/runs
GET    /v1/subagents/runs/:id
POST   /v1/subagents/runs/:id/cancel
```

WS frames：

- `provider_changed`
- `model_probe_completed`
- `tool_registry_changed`
- `mcp_server_status`
- `subagent_started`
- `subagent_delta`
- `subagent_tool_start`
- `subagent_tool_end`
- `subagent_done`
- `subagent_error`

## Web UI

### Settings / Providers

- Provider cards：OpenAI、OpenRouter、Nous、NIM、HF、Moonshot、MiniMax、MiMo、Ollama 等。
- Add provider wizard：选择 profile → 填 API key / base URL → probe → 保存。
- Model table：搜索、能力 badge、默认模型、可见性。
- Session model switch：Chat header 直接切换 provider/model。

### Settings / Tools

- Tool Catalog：按 category / source / risk 筛选。
- Built-in packs：Core、Coding、Work、Doc、Learning、Web、MCP、SubAgents。
- 单工具 enable/disable、risk override、approval rule。

### Settings / MCP

- MCP server 列表、健康状态、已暴露工具。
- 添加 server：stdio command 或 HTTP/SSE transport。
- allow/deny tools、alias、env var placeholder。
- reload / disable。

### Work / Parallel runs

- SubAgent rail：展示并行任务卡片。
- 每个卡片显示模型、工具集、耗时、最后事件、产物。
- 主 Agent 汇总时可展开每个子 Agent 的 trace。

## Configuration

```json
{
  "model_routing": {
    "default": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" },
    "coding": { "provider": "codex", "model": "gpt-5.4-codex" },
    "review": { "provider": "openrouter", "model": "openai/gpt-5.4-mini" },
    "doc_reader": { "provider": "kimi", "model": "kimi-k2-turbo-preview" },
    "fallbacks": [
      { "provider": "openai", "model": "gpt-5.4-mini" },
      { "provider": "ollama", "model": "qwen3:14b" }
    ]
  },
  "tool_packs": {
    "coding": { "enabled": true },
    "web": { "enabled": true },
    "subagents": { "enabled": true, "max_concurrency": 3 }
  }
}
```

环境变量只作为覆盖：

- `JARVIS_DEFAULT_PROVIDER`
- `JARVIS_DEFAULT_MODEL`
- `JARVIS_ENABLE_TOOL_PACKS=coding,web,subagents`
- `JARVIS_SUBAGENT_MAX_CONCURRENCY=3`
- `JARVIS_MCP_SERVERS=...` 继续支持 legacy。

## Rollout

### Phase 0：Provider profile catalog

- 新增 provider profile registry。
- 把 OpenRouter、Nous、NIM、Moonshot、MiniMax、MiMo、Ollama、LM Studio
  作为 OpenAI-compatible profiles。
- `/v1/model-catalog` 返回能力元数据。
- Web UI provider wizard 使用 profile。

验收：

- 用户无需手写 base URL 就能添加 OpenRouter / Kimi / NIM。
- `provider/model` 和 session model switch 都能工作。
- 不支持 tool calls 的模型在启用工具任务时给出明确提示。

### Phase 1：Tool Catalog

- `ToolMetadata` / ToolRegistryEntry。
- `/v1/tools` 与 Settings Tools 页面。
- Built-in tools 分类、风险、source。
- MCP tools 进入同一目录。

验收：

- UI 能看到内置工具和 MCP 工具。
- 用户能禁用单个工具。
- 高风险工具默认需要 approval。

### Phase 2：MCP 管理面

- MCP server health state。
- REST CRUD + reload。
- allow/deny/alias/risk override。
- server failure 不影响 Jarvis 启动。

验收：

- 添加一个 filesystem MCP server 后工具出现在 catalog。
- reload 单个 MCP server 不重启 Jarvis。
- schema 异常工具不会 crash registry。

### Phase 3：SubAgent 并行运行

- `SubAgentRuntime` + `subagent.run`。
- batch mode，max concurrency。
- WS frames + Web rail。
- 内置 `doc_reader`、`reviewer`、`codex`、`claude_code` spec。

验收：

- 主 Agent 可派生 2-3 个隔离子任务并行执行。
- UI 能实时看到每个子 Agent 的事件流。
- 子 Agent 失败不会吞掉其它子任务结果。

### Phase 4：Auto routing and fallback

- `ModelRoutePolicy`。
- 按 task slot 选模型。
- provider failure fallback。
- latency / cost telemetry 回写 provider snapshot。

验收：

- summarization 自动走便宜模型。
- coding 自动走 codex / configured coding model。
- provider 429 / 5xx 时按 fallback 链恢复，并在 UI 显示。

## Testing

Rust tests：

- Provider profile 解析与 config merge。
- ProviderRegistry capability validation。
- OpenAI-compatible request mapping。
- ToolMetadata 分类与 enable/disable。
- MCP allow/deny/alias。
- SubAgent batch join 策略。

Server tests：

- `/v1/providers` create/probe/list。
- `/v1/tools` 返回 built-in + MCP。
- `/v1/mcp/servers/:name/reload`。
- `/v1/subagents/runs` lifecycle。

Web tests：

- Provider wizard。
- Model picker capability badges。
- Tools settings filtering。
- MCP server add/reload。
- SubAgent rail event rendering。

E2E：

1. 添加 OpenRouter provider。
2. 切换模型运行一次 chat。
3. 添加 MCP server。
4. 启用 coding tool pack。
5. 主 Agent 派生 doc_reader + reviewer 并行任务。
6. 一个 provider 故障后 fallback 到备用模型。

## Open questions

- Model catalog 是否静态内置，还是支持从 OpenRouter / provider API 动态拉取？
- Nous Portal / NIM / MiniMax / MiMo 的 profile URL 和鉴权差异需要在落地前逐一验证。
- Tool risk 是否由工具作者声明，还是由 Jarvis 做规则推断？
- SubAgent 是否允许写同一 workspace，还是默认使用 worktree / temp branch 隔离？
- MCP HTTP/SSE transport 是否本阶段启用，还是先稳定 stdio？
