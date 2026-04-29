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

第一版推荐 WebSocket 长连接。Edge 主动连 Cloud，适合 NAT、家庭网络、企业内网和普通
Docker 部署。

```text
Edge -> Cloud: hello
Cloud -> Edge: hello_ack
Edge -> Cloud: heartbeat
Edge -> Cloud: capabilities
Cloud -> Edge: invoke_tool
Edge -> Cloud: tool_started
Edge -> Cloud: tool_delta
Edge -> Cloud: tool_finished
Edge -> Cloud: approval_required
Cloud -> Edge: approval_decision
```

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

### Phase 1：通用 Docker 与 Cloud / Edge 骨架

- 新增 `harness-cloud` crate；
- 定义模型、config、policy、WebSocket 消息类型；
- `apps/jarvis` 支持 `JARVIS_CLOUD_MODE=cloud | edge | off`；
- Cloud 模式暴露 `/v1/edge/ws`；
- Edge 模式连接 Cloud、注册节点、发送心跳；
- 不接厂商 SDK。

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

### Phase 5：厂商增强

优先级：

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
