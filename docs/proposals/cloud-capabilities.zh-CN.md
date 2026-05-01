# 云端能力包与端云协同

**状态：** Proposed
**涉及：** 新增 `crates/harness-cloud/`；`apps/jarvis` 增加云端配置与运行模式；
`harness-server` 增加云端节点 API / WebSocket 控制通道；`harness-store` 后续增加
节点、调用审计、云端资源元数据表；部署文档新增 Docker、Kubernetes 与主流云厂商模板。

## 背景

Jarvis 现在的核心架构很适合继续演进成“本地可运行、云端可托管、端侧可协作”的
agent runtime。当前 crate 边界里，`harness-core` 只负责 agent loop 和 trait，
不理解 HTTP、存储、MCP、provider 或部署环境。云端能力也应该延续这个原则：云服务
厂商、对象存储、IoT/MQTT、节点注册、远程工具调用都不进入 `harness-core`。

本 proposal 定义一个独立的 `harness-cloud` 包，把云端能力沉淀为可插拔抽象，并让
阿里云、AWS、Azure、腾讯云、华为云等厂商成为可选适配层。第一版目标不是“一次性
接完所有云 SDK”，而是先做稳定的通用端云协议和最小云端控制面，再逐步补厂商增强。

## 产品对齐

云端能力不是新的顶层产品入口，而是 Chat / Work / Doc 的部署与执行增强：

- **Chat：** 云端托管会话、跨设备访问、远程工具调用；
- **Work：** Cloud 调度 Edge 节点执行 Work unit，回传验证结果和 artifact；
- **Doc：** 云端保存资料、文档草稿、导出产物和引用来源；
- **基础能力：** Coding、日常办公、资料研究等 capability pack 可以按节点和权限选择
  可用工具。

因此 `harness-cloud` 只提供节点、传输、对象存储、策略和审计能力，不拥有产品状态。

## 借鉴 Multica 的 same-code two-shapes 部署形态

[Multica](https://github.com/multica-ai/multica) 把 cloud 与 self-host 做成了**同一份后端二进制 + 同一套 schema 的两种部署形态**——区别只在 daemon 端连的 URL 不同（`wss://api.multica.ai/v1/daemon` vs `ws://localhost:8080/v1/daemon`）。这正好对齐本 proposal "本地可运行、云端可托管、端侧可协作" 的目标，所以**不**重新发明部署形态，而是吸收 multica 已经验证的三个支撑点。

### 1. Reverse-WebSocket：Edge 主动连 Cloud（最关键的一条）

Daemon / Edge 节点**永远主动连 server**，server 不主动连 daemon。三个直接收益：

1. **NAT / 防火墙友好** — Edge 跑在用户笔记本 / 内网开发机上，不需要任何入站端口或公网 IP。
2. **协议同源** — cloud 与 self-host 用完全相同的 WS 帧（`runtime.register / task.claim / task.dispatch / task.progress / task.complete / task.fail`），Edge 二进制不需要"模式切换"，只是 URL 不同。
3. **认证统一** — `jarvis login` 拿到的 PAT 与 daemon-token 在两种部署里走同一条 header 校验路径。

→ 落地到本 proposal：`EdgeTransport` trait 的第一个实现就是"WebSocket transport"，**第一版同时承担两个角色**——本地单机用 loopback WS（agent loop 不再嵌死在 HTTP handler 里），未来 cloud 部署用远程 WS。两种形态共享同一套消息 envelope，详见下文 §端云协议。

### 2. 12-factor env 驱动 + 云增强能力一律 optional fallback

Multica 后端没有 `--cloud` / `--self-host` 编译开关，所有差异都在环境变量里：S3 / CloudFront / Resend / OAuth 一律 **optional fallback**——缺失就降级到本地存储 + 验证码打日志，self-host 用户不会被云依赖卡住。

→ 落地到本 proposal：本仓库 `CLAUDE.md` 已经把 `JARVIS_*` 环境变量列得很完整。本 proposal 新增的 `JARVIS_OBJECT_STORE` / `JARVIS_EDGE_CLOUD_URL` / 厂商 secrets 等**全部按 "缺失即降级到本地实现" 原则设计**——不让 self-host 必须配对象存储、不让本地开发必须配 OAuth、不让单机必须装 Redis。

### 3. 同一份后端 + 同一套 schema 跑两种形态

Multica 通过 `workspace.slug` + `member.role` + `X-Workspace-Slug` 头让一份 schema 同时支持：cloud 多 workspace 多租户、self-host 单 workspace 内部部署。**不为单租户做 schema 简化**——self-host 用户随时能"升级"成多团队部署，零数据迁移。

→ 落地到本 proposal：在下文 "核心模型" 之上**前置 Workspace 抽象**（详见 §核心模型 / Workspace 子节）。这是个早做成本低、晚做成本高的决策，**所有 cloud 路线的下游决策都依赖它存在**。

**核心心法**：cloud-first 的产品体验 ≠ cloud-first 的架构耦合。Multica 做对的事是 "两边用同一套代码"，本 proposal 跟做这点即可——既不被云依赖锁死，也不为未来的云形态买单。

## 目标

1. **云端能力独立成包。**
   新增 `harness-cloud`，承载节点注册、远程命令、对象存储、厂商适配、端云传输等
   抽象，不污染 `harness-core`。

2. **Cloud / Edge 能力统一建模。**
   云端 Jarvis 可以管理多个 Edge Jarvis 节点，查看状态、能力、工具清单，并把端侧
   工具包装成普通 `Tool` 供 agent loop 调用。

3. **厂商可插拔。**
   阿里云、AWS 等厂商通过 feature 或独立 adapter 接入。业务逻辑面向
   `CloudProvider`、`ObjectStore`、`EdgeTransport` 等 trait，而不是直接绑定某个 SDK。

4. **通用协议优先，厂商增强后置。**
   第一阶段使用 Docker + WebSocket + 通用数据库即可跑通；后续再接入 IoT Platform、
   AWS IoT Core、Azure IoT Hub、对象存储、日志、KMS、Terraform / K8s 模板。

5. **权限与审计从第一天存在。**
   端侧工具调用、文件访问、写操作、内网 HTTP 请求、shell 类工具必须能被策略控制，
   并留下审计记录。

非目标：

- 不把云厂商 SDK 引入 `harness-core`；
- 不在第一版实现完整多云资源编排平台；
- 不替代 Terraform、Pulumi、ACK、EKS、ECS 等部署工具；
- 不让 Edge 节点默认执行高风险工具；
- 不强制使用某一家云服务，通用 Docker / WebSocket 部署必须始终可用。

## 包边界

新增 crate：

```text
crates/
  harness-cloud/
    src/
      lib.rs
      model.rs          # EdgeNode, CloudRegion, Capability, ToolRoute
      provider.rs       # CloudProvider trait + local/generic impl
      transport.rs      # EdgeTransport trait
      websocket.rs      # 通用 WebSocket 控制通道
      mqtt.rs           # 后续：通用 MQTT transport
      object_store.rs   # S3-compatible object store abstraction
      policy.rs         # tool routing / permission policy
      audit.rs          # tool invocation audit event model
      remote_tool.rs    # Edge tool -> harness_core::Tool adapter
      providers/
        aliyun.rs       # feature = "aliyun"
        aws.rs          # feature = "aws"
        azure.rs        # feature = "azure"
        tencent.rs      # feature = "tencent"
        huawei.rs       # feature = "huawei"
```

`harness-cloud` 可以依赖：

- `harness-core`：使用 `Tool`、`ToolRegistry`、`BoxError`、`Result`；
- `serde` / `serde_json`：协议与配置；
- `tokio` / `async-trait`：异步 transport；
- 可选云 SDK：全部放 behind feature。

`harness-cloud` 不应该依赖：

- `apps/jarvis`；
- 具体 HTTP router 实现细节；
- `std::env`；
- UI 代码；
- 某个厂商的 SDK 作为默认依赖。

## 核心模型

```rust
pub struct EdgeNode {
    pub id: String,
    pub display_name: Option<String>,
    pub provider: CloudVendor,
    pub region: Option<String>,
    pub labels: Vec<String>,
    pub transport: EdgeTransportKind,
    pub status: EdgeNodeStatus,
    pub capabilities: EdgeCapabilities,
    pub last_seen_at: Option<String>,
}

pub enum CloudVendor {
    Local,
    Generic,
    Aliyun,
    Aws,
    Azure,
    Tencent,
    Huawei,
    Gcp,
    Oracle,
    Baidu,
    Volcengine,
    Cloudflare,
    Other(String),
}

pub struct EdgeCapabilities {
    pub tools: Vec<EdgeToolSpec>,
    pub resources: EdgeResources,
    pub supports_approval: bool,
    pub supports_streaming: bool,
}

pub struct EdgeToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
    pub risk: ToolRisk,
}
```

这些类型只描述 Jarvis 视角的节点与能力，不直接暴露厂商对象，例如 AWS Thing、
阿里云设备、Azure device twin。厂商 ID 可以放进 `metadata`，但核心调度不依赖它。

### Workspace 抽象（前置必要条件）

`harness_core` 当前只有 `Project` 概念。**在加任何 cloud / multi-tenant 字段之前**，需要先在 Project 之上垫一层 `Workspace`——否则后续要支持多团队、多租户时整张 schema 要重写。这是 multica 把 workspace.slug 做在第一版的原因。

最小骨架：

```rust
pub struct Workspace {
    pub id: String,           // UUID v4
    pub slug: String,         // URL 友好短 ID, e.g. "acme"
    pub name: String,         // 显示名
    pub settings: WorkspaceSettings,  // JSONB-equivalent
    pub created_at: String,   // RFC3339
    pub updated_at: String,
}

pub struct WorkspaceSettings {
    pub issue_prefix: Option<String>,        // e.g. "ACME" → "ACME-42"
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub allowed_repo_urls: Vec<String>,      // 白名单
    // future: agent system prompt, theme, etc.
}
```

**HTTP 路径与头**（与 multica 对齐）：

- URL 形如 `/{workspace-slug}/projects/...` 或带 `/v1/{workspace-slug}/...` 前缀
- 或者保留扁平 URL，要求所有写操作携带 `X-Workspace-Slug: <slug>` 头
- 推荐**同时支持**：URL 路径优先于 header；都缺失时返回 400

**"单租户" 也用同一套 schema**：本地单机部署默认创建一个 `slug = "default"` 的 workspace，所有现有 Project / Conversation / Requirement 落到它下面。后续无论 self-host 多团队、还是 cloud SaaS，都不需要 schema 迁移——只需要允许多 workspace 行存在。

**与 cloud 路线的关系**：cloud 控制面所有 API 都需要 workspace 维度（"看 acme workspace 的 nodes / 看 widget-co workspace 的 tool invocations"），所以 §API 草案 / §存储 / §配置 章节都隐含 workspace_id 列。本 proposal 不重复写每张表都加 `workspace_id` 这件事——视为 §核心模型 之后的全局前提。

**迁移策略**：当前数据库里没有 workspace 概念。引入时走 Phase 0：
1. 加 `workspace` 表 + 系统启动时自动 ensure 一行 `slug = "default"`
2. 给 `project` / `conversation` / `requirement` 等已有表加 nullable `workspace_id`，运行时缺省回填到 default workspace
3. 一个版本周期后改为 NOT NULL
4. API 路径加 workspace 前缀；旧路径作为过渡兼容（读 `X-Workspace-Slug` 或回落到 default）

## Provider 抽象

云厂商适配分成多个小 trait，而不是一个巨型 SDK 包装器。

```rust
#[async_trait]
pub trait NodeRegistry: Send + Sync {
    async fn register_node(&self, node: EdgeNode) -> Result<()>;
    async fn update_heartbeat(&self, node_id: &str, status: EdgeNodeStatus) -> Result<()>;
    async fn get_node(&self, node_id: &str) -> Result<Option<EdgeNode>>;
    async fn list_nodes(&self, filter: NodeFilter) -> Result<Vec<EdgeNode>>;
}

#[async_trait]
pub trait EdgeCommandBus: Send + Sync {
    async fn send_command(&self, node_id: &str, command: EdgeCommand) -> Result<String>;
    async fn complete_command(&self, command_id: &str, result: EdgeCommandResult) -> Result<()>;
}

#[async_trait]
pub trait ObjectStore: Send + Sync {
    async fn put(&self, key: &str, bytes: bytes::Bytes, content_type: Option<&str>) -> Result<ObjectRef>;
    async fn get(&self, key: &str) -> Result<bytes::Bytes>;
    async fn delete(&self, key: &str) -> Result<()>;
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn get_secret(&self, name: &str) -> Result<Option<String>>;
}
```

组合根在 `apps/jarvis` 中根据配置组装：

```rust
pub struct CloudRuntime {
    pub nodes: Arc<dyn NodeRegistry>,
    pub commands: Arc<dyn EdgeCommandBus>,
    pub objects: Option<Arc<dyn ObjectStore>>,
    pub secrets: Option<Arc<dyn SecretStore>>,
    pub policy: Arc<CloudPolicy>,
}
```

第一版可以只实现：

- `MemoryNodeRegistry`，用于测试；
- `StoreNodeRegistry`，基于 `ConversationStore` 之外的新表，后续接 `harness-store`；
- `WebSocketCommandBus`，基于 Jarvis 自己的 WS 长连接；
- `S3CompatibleObjectStore`，可兼容 AWS S3、MinIO、部分兼容 S3 API 的对象存储。

## 端云协议

第一版推荐 WebSocket 长连接。Edge 主动连 Cloud（reverse-WS，详见 §借鉴 Multica），
适合 NAT、家庭网络、企业内网和普通 Docker 部署。**第一版 in-proc loopback 就用这套
协议**——把 agent loop 从 HTTP handler 里拆出来，让 server 入队、本地 runtime 认领，
未来切到远程 transport 不需要改协议层。

### 协议帧分两组

第一组是**任务调度**（与 multica `daemon_ws.go` 命名对齐，方便对照参考实现）：

| 方向 | 帧 | 用途 |
|---|---|---|
| Edge → Cloud | `runtime.register` | 启动握手，声明 runtime_id 数组 + capabilities |
| Edge → Cloud | `runtime.heartbeat` | 心跳 + 负载汇报（idle / running / count） |
| Cloud → Edge | `task.dispatch` | 派发一个 RequirementRun（含 conversation_id / work_dir / session_id?） |
| Edge → Cloud | `task.claim` | （可选）显式认领，幂等去重 |
| Edge → Cloud | `task.progress` | 流式进度（AgentEvent::Delta / ToolStart / ToolEnd / PlanUpdate / ApprovalRequest） |
| Edge → Cloud | `task.complete` | 终止：成功，附 final conversation + result |
| Edge → Cloud | `task.fail` | 终止：失败，附 error 消息 |
| Cloud → Edge | `task.cancel` | 用户取消请求 |

第二组是**远程工具调用**（cloud 把 Edge 工具暴露给 agent 时使用，与上一组解耦）：

```text
Edge → Cloud: hello / hello_ack          # 兼容旧版协议名
Edge → Cloud: capabilities               # 工具清单上报
Cloud → Edge: invoke_tool
Edge → Cloud: tool_started
Edge → Cloud: tool_delta
Edge → Cloud: tool_finished
Edge → Cloud: approval_required
Cloud → Edge: approval_decision
```

### Envelope

所有帧用同一个 envelope，便于路由与版本兼容：

```json
{
  "v": 1,
  "type": "task.dispatch",
  "id": "msg_<ulid>",
  "ts": "2026-04-30T12:00:00Z",
  "workspace_slug": "default",
  "runtime_id": "rt_local_001",
  "payload": { /* 帧专属字段 */ }
}
```

`workspace_slug` 字段是 §Workspace 抽象 落地的体现——cloud 形态下同一个 transport
连接可以为多个 workspace 路由消息（取决于 PAT 范围）。

旧版 `hello / capabilities / invoke_tool` 等帧名在第二组中保留以向后兼容；新增的
`runtime.* / task.*` 命名空间用于第一组任务调度，未来废弃 `hello` 时只动第二组。



消息草案：

```json
{
  "type": "hello",
  "node_id": "edge-home-001",
  "token": "redacted",
  "version": "0.1.0",
  "capabilities": {
    "tools": [
      {
        "name": "fs.read",
        "description": "Read a file under the configured root",
        "parameters": {"type": "object"},
        "risk": "read_only"
      }
    ],
    "supports_approval": true,
    "supports_streaming": true
  }
}
```

工具调用：

```json
{
  "type": "invoke_tool",
  "call_id": "call_123",
  "tool": "fs.read",
  "args": {"path": "README.md"},
  "policy_context": {
    "conversation_id": "conv_456",
    "requested_by": "user_789"
  }
}
```

结果：

```json
{
  "type": "tool_finished",
  "call_id": "call_123",
  "ok": true,
  "output": "..."
}
```

### MCP 的关系

MCP 仍然是工具生态的桥。端云协议负责 Cloud 与 Edge Jarvis 节点之间的控制与调用；
Edge 节点本地可以继续通过 `harness-mcp` 连接 MCP server，再把远程 MCP 工具上报给
Cloud。Cloud 看到的只是带 node 前缀的工具：

```text
edge.home.fs.read
edge.home.github.search_issues
edge.office.db.query
```

`harness-core` 不需要知道这些工具来自本地、MCP、云端还是端侧。

## 远程工具适配

`harness-cloud` 提供 `RemoteEdgeTool`：

```rust
pub struct RemoteEdgeTool {
    node_id: String,
    remote_name: String,
    public_name: String,
    description: String,
    parameters: serde_json::Value,
    command_bus: Arc<dyn EdgeCommandBus>,
    policy: Arc<CloudPolicy>,
}
```

实现 `harness_core::Tool`：

```rust
#[async_trait]
impl Tool for RemoteEdgeTool {
    fn name(&self) -> &str { &self.public_name }
    fn description(&self) -> &str { &self.description }
    fn parameters(&self) -> serde_json::Value { self.parameters.clone() }

    async fn invoke(&self, args: serde_json::Value) -> Result<String, BoxError> {
        // 1. policy check
        // 2. send invoke_tool to edge
        // 3. await result or timeout
        // 4. return output or "tool error: ..."
    }
}
```

注册策略：

- Cloud 收到 Edge `capabilities` 后，把可用工具注册进一个云端 `ToolRegistry`；
- 工具名加前缀，避免碰撞；
- 节点下线时工具应标记 unavailable，或者 invoke 时返回可恢复错误；
- 高风险工具默认不注册，除非策略允许。

## 权限模型

端云协同的默认姿态是收紧权限。建议把工具风险分级：

| 风险 | 示例 | 默认 |
|---|---|---|
| `read_only` | `fs.read`、`fs.list`、`time.now` | 可注册，可按路径限制 |
| `network` | `http.fetch`、内网 API | 需要 allowlist |
| `write` | `fs.write`、配置修改 | 默认禁用或端侧确认 |
| `exec` | shell、部署命令、云助手命令 | 默认禁用，必须显式授权 |
| `cost` | 创建云资源、GPU job、发短信 | 必须审批和审计 |

策略示例：

```toml
[[edge.nodes]]
id = "home-mac-mini"
labels = ["home", "trusted"]
allowed_tools = ["fs.read", "fs.list", "time.now"]
fs_roots = ["/data/jarvis"]
require_approval = ["fs.write", "shell.exec"]

[[edge.routes]]
tool_prefix = "edge.home."
node_selector = { labels = ["home"] }
```

后续可以演进成独立规则引擎，但 v0 用静态配置就够。

## 云厂商支持矩阵

| 厂商 | 首选角色 | v0 支持 | 后续增强 |
|---|---|---|---|
| 阿里云 | 中国区主推云 | ECS / ACK 部署文档，OSS/S3-compatible，RDS | IoT Platform、SLS、KMS、云助手 |
| AWS | 海外主推云 | EC2 / ECS / EKS 部署文档，S3，RDS | IoT Core、CloudWatch、Secrets Manager、SSM |
| Azure | 企业客户 | AKS / Container Apps 部署文档，Blob，Postgres | IoT Hub、Key Vault、Azure Monitor |
| 腾讯云 | 中国区备选 | CVM / TKE 部署文档，COS，TencentDB | IoT Hub / IoT Explorer、CLS、KMS |
| 华为云 | 政企/工业 | ECS / CCE 部署文档，OBS，RDS | IoTDA、LTS、KMS |
| GCP | 通用海外部署 | GKE / Cloud Run 部署文档，Cloud Storage | Pub/Sub + 第三方 MQTT；不依赖已关停的 Cloud IoT Core |
| Oracle Cloud | 成本/企业 | VM / OKE 部署文档，对象存储 | 数据库与私有网络增强 |
| 百度智能云 | 中国区二级 | 云服务器 / CCE 部署文档 | IoT 与日志按需求补 |
| 火山引擎 | 中国区二级 | ECS / VKE 部署文档 | TOS、TLS、IoT 按需求补 |
| Cloudflare | 全球入口/relay | Tunnel、Workers/DO WebSocket relay 文档 | 零信任鉴权、边缘控制通道 |
| DigitalOcean / Linode / Hetzner / OVH / Scaleway / Fly.io | 轻量部署 | Docker Compose / K3s 文档 | 区域 Edge 节点、低成本 relay |

关键原则：

- 一线厂商可以有 adapter；
- 二线和轻量云优先走 `generic`；
- 对象存储尽量通过 S3-compatible 抽象覆盖；
- IoT/MQTT 适配只有在通用 WebSocket 协议稳定后再做。

## 配置

新增配置建议放在 `apps/jarvis` 的 composition root：

```env
JARVIS_CLOUD_MODE=off | cloud | edge
JARVIS_CLOUD_PROVIDER=generic | aliyun | aws | azure | tencent | huawei
JARVIS_CLOUD_REGION=cn-hangzhou

JARVIS_EDGE_ID=edge-home-001
JARVIS_EDGE_LABELS=home,trusted
JARVIS_EDGE_CLOUD_URL=wss://jarvis.example.com/v1/edge/ws
JARVIS_EDGE_TOKEN=...
JARVIS_EDGE_ALLOWED_TOOLS=fs.read,fs.list,time.now
JARVIS_EDGE_REQUIRE_APPROVAL=fs.write,shell.exec

JARVIS_OBJECT_STORE=s3-compatible | off
JARVIS_OBJECT_BUCKET=jarvis-artifacts
JARVIS_OBJECT_ENDPOINT=https://...
JARVIS_OBJECT_REGION=...
```

Library crate 只接收已解析的 config struct：

```rust
pub struct CloudConfig {
    pub mode: CloudMode,
    pub provider: CloudVendor,
    pub region: Option<String>,
    pub edge: Option<EdgeConfig>,
    pub object_store: Option<ObjectStoreConfig>,
}
```

## API 草案

`harness-server` 可以暴露最小云端控制面：

```text
GET    /v1/cloud/nodes
GET    /v1/cloud/nodes/:id
POST   /v1/cloud/nodes/:id/disable
GET    /v1/cloud/nodes/:id/tools
GET    /v1/cloud/tool-invocations
GET    /v1/edge/ws
```

`/v1/edge/ws` 是 Edge 节点连接 Cloud 的控制通道，不是用户聊天 WebSocket。

所有云端管理 API 都需要认证；未接入认证前，只在 localhost 或显式开发模式开放。

## 存储

不要把节点状态塞进 conversation JSON。建议后续在 `harness-store` 增加独立表：

```text
cloud_nodes(
  id,
  provider,
  region,
  labels_json,
  capabilities_json,
  status,
  created_at,
  updated_at,
  last_seen_at
)

cloud_tool_invocations(
  id,
  node_id,
  tool_name,
  args_json,
  result_status,
  result_excerpt,
  requested_by,
  conversation_id,
  created_at,
  completed_at
)
```

SQLite 仍然是默认开发后端，生产部署推荐 Postgres/MySQL。

## 部署目录

建议新增：

```text
deploy/
  docker/
    Dockerfile
    docker-compose.cloud.yml
    docker-compose.edge.yml
    example.env
  aliyun/
    ecs-compose.md
    ack/
    terraform/
  aws/
    ec2-compose.md
    ecs/
    eks/
    terraform/
  azure/
  tencent/
  huawei/
docs/
  deployment.md
  edge-cloud.md
  cloud-providers.md
```

第一批文档只保证 Docker Compose 能跑通；Kubernetes 和 Terraform 模板可以按厂商逐步补。

## 迭代计划

### Phase 0：Workspace 抽象 + slug 路由（前置基础）

**目的**：所有 cloud 路线的下游决策都依赖 workspace 存在；这一阶段与 Phase 1 解耦，**可以独立先做**，且不引入任何 cloud 依赖。

- 在 `harness_core` 新增 `Workspace` 类型 + `WorkspaceStore` trait；
- `harness-store` 5 个后端（json / memory / sqlite / postgres / mysql）实现 `WorkspaceStore`；启动时 ensure 一行 `slug = "default"`；
- 给 `project / conversation / requirement / todo` 等已有表加 nullable `workspace_id`，运行时缺省回填到 default workspace；
- `harness-server` 路由解析 `X-Workspace-Slug` 头（缺失则回落 default），所有现有 API 对 default workspace 行为保持向后兼容；
- Web UI 增加（隐藏的）workspace 切换器，单 workspace 时折叠不显示。

**验收**：现有所有 e2e 测试在不传 `X-Workspace-Slug` 头的情况下行为不变；新增一个测试覆盖"建第二个 workspace 隔离 project 列表"。

### Phase 1：In-proc reverse-WS + Cloud / Edge 骨架

**关键变化**：第一版**就**把 agent loop 从 HTTP handler 里拆出来——server 入队、本地 runtime 认领——但 transport 用 in-proc loopback WS（同进程内）。这样未来切到远程 transport 时不需要重写调度层。

- 新增 `harness-cloud` crate；
- 定义模型、config、policy、WebSocket 消息类型（envelope + `runtime.* / task.*` 帧）；
- 实现 `EdgeTransport` 的 `LoopbackTransport`（in-proc mpsc）和 `WebSocketTransport`（远程）两个 backend，**先用前者**；
- `apps/jarvis` 支持 `JARVIS_CLOUD_MODE=cloud | edge | off`，单机部署默认 `off`（隐式跑 loopback）；
- Cloud 模式暴露 `/v1/edge/ws`（即 reverse-WS 入口）；
- Edge 模式连接 Cloud、注册节点（携 workspace_slug 列表）、发送心跳；
- agent loop 改成"`server 入队 RequirementRun → runtime claim → runtime 跑 → runtime 上报`"形态；
- 不接厂商 SDK。

**验收**：单机模式 `JARVIS_CLOUD_MODE=off` 跑现有 e2e 不退化；额外验证 `cloud + edge` 双进程能本地起来、能跑通一次 RequirementRun（in-proc loopback 与远程 WS 走同一份消息处理代码）。

### Phase 2：远程工具调用闭环

- Edge 上报本地 `ToolRegistry` 中允许暴露的工具；
- Cloud 把 Edge 工具包装成 `RemoteEdgeTool`；
- agent 可以调用 `edge.<node>.<tool>`；
- 工具调用超时、下线、错误都以可恢复文本返回；
- 记录基础审计。

### Phase 3：策略与审批

- 增加静态 allowlist / denylist；
- 支持按 node label 路由；
- 高风险工具触发端侧审批；
- Web UI 展示节点、工具、调用记录。

### Phase 4：对象存储与产物

- 实现 `ObjectStore`；
- 先支持 S3-compatible；
- 工具大输出、附件、日志、导出物进入对象存储；
- 本地开发可用 MinIO。

### Phase 5：发布与厂商增强

发布形态（与厂商集成解耦，可任意阶段穿插）：

- **GHCR docker image 发布**：CI 加 `docker build` + `docker push ghcr.io/<org>/jarvis-server:<tag>`，与现有 5-triple cargo release 并行；
- **`docker-compose.selfhost.yml` 模板**：起 jarvis-server + 可选 postgres + 可选 minio（对象存储）；自托管用户一行 `docker compose up -d` 起来，所有云增强能力 env 缺失即降级到本地实现；
- **`scripts/install.sh --with-server`**：一键拉镜像 + 写 `.env` + 启动 compose 的脚本（参照 multica 的同名脚本）；
- **远程 `WebSocketTransport`**：把 Phase 1 留下的 in-proc loopback 切换成跨进程跨主机的远程 WS（实质只是配置项变更）；
- **远程 EdgeTransport hub**：一个 cloud server 同时管理多 edge runtime；可选 Redis 缓存空队列（multica `EmptyClaimCache` 的对应物）。**Redis 必须是 optional**——不带 Redis 也要能跑。

厂商集成优先级：

1. 阿里云：ECS/ACK 部署、OSS、SLS、IoT Platform；
2. AWS：EC2/ECS/EKS 部署、S3、CloudWatch、IoT Core、SSM；
3. Azure：AKS/Container Apps、Blob、IoT Hub；
4. 腾讯云 / 华为云：中国区备选与政企场景；
5. GCP / Oracle / 轻量云：保持 generic 部署为主。

## 风险与取舍

- **厂商 SDK 依赖膨胀。**
  用 feature gate 或拆 adapter crate，默认只编译 generic。

- **端侧工具权限过大。**
  默认不暴露写入、执行、成本类工具；策略与审计先于深度厂商集成。

- **节点在线状态与工具注册漂移。**
  心跳超时后工具不可用；invoke 时再次检查连接状态。

- **WebSocket 自研协议后续迁移 MQTT。**
  通过 `EdgeTransport` 抽象隔离协议，消息 envelope 尽量保持 transport-neutral。

- **多云适配范围过大。**
  文档和 generic 部署覆盖长尾云厂商；只有真实需求明确的厂商才做 SDK 级适配。

- **Workspace 抽象拖到有 cloud 用户后再加。**
  如果先发布单租户 self-host、有真实数据沉淀后再补 workspace 列，所有 `project / conversation / requirement / todo` 表都要做 NOT NULL 迁移 + API 路径加前缀 + 客户端兼容层。multica 把它做在第一版的原因正是这个。**对策**：Phase 0 与 Phase 1 解耦但前置完成；nullable workspace_id 的过渡期不超过 1-2 个 minor 版本。

- **云依赖被默认开启。**
  Redis / 对象存储 / OAuth / 邮件服务一旦在某个 Phase "默认必装"，self-host 用户就被卡住。**对策**：env 缺失时一律 fallback 到本地实现（参考 multica 的 S3 → backend_uploads volume / Resend → log dev-code / OAuth → 邮箱验证码）；CI 加 "无 env 启动" 烟测确保 fallback 路径不腐烂。

## 验收标准

v0 完成时应满足：

- `cargo check --workspace` 通过；
- `JARVIS_CLOUD_MODE=cloud` 能启动 Cloud 控制面；
- `JARVIS_CLOUD_MODE=edge` 能连接 Cloud 并注册节点；
- Cloud 能在节点列表里看到 Edge 的 labels、状态、工具清单；
- agent 能调用一个 Edge 只读工具并拿到结果；
- Edge 下线时，Cloud 侧远程工具返回清晰错误；
- 高风险工具不会默认暴露；
- Docker Compose 能启动一个 Cloud + 一个 Edge 的本地演示环境。
