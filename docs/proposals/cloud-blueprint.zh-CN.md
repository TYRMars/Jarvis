# Cloud / Edge 落地蓝图

> 本文件是 **Jarvis Product** 看板中 Cloud 路线 10 条 Requirement 的仓库内镜像。
> 看板是动态状态，本文档是版本化交底；任何 PR 标题 / 验收 / 依赖的变更必须双向同步。
>
> 相关提案：
> - [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md) —— 云端能力包与端云协同的顶层设计、厂商矩阵、风险取舍。

## 术语

- **Tenant**：本蓝图及对应看板 Requirement 使用的术语，指多租户隔离边界。它与 `cloud-capabilities.zh-CN.md` 中的 **Workspace** 概念同源（对应 multica 的 `workspace.slug`），只是看板行文统一使用 Tenant。代码实现时以 `Tenant` / `TenantStore` 作为值类型与 trait 名。
- **Cloud / Edge**：Cloud 是控制面（调度、节点管理、远程工具注册），Edge 是执行面（跑在用户笔记本、内网、ECS/EC2 上的 agent runtime）。两者通过同一套 WebSocket 协议通信。

---

## Phase 0：多租户前置（Tenant 抽象）

所有 Cloud 路线的下游决策都依赖 Tenant/Workspace 存在；Phase 0 与 Phase 1 解耦，可以独立先做，且不引入任何 cloud SDK。

### PR-0.1 — harness-core::tenant 值类型 + TenantStore trait

**范围**
- 新增 `crates/harness-core/src/tenant.rs`，定义：
  - `Tenant { id, slug, name, settings, archived, created_at, updated_at }`
  - `TenantSettings { issue_prefix?, default_provider?, default_model?, allowed_repo_urls }`
  - `TenantStore: save / load / find_by_slug / list / archive / delete`
- `crates/harness-core/src/lib.rs` 导出 + 文档说明。

**术语决议**
现有 `harness_core::workspace`（per-session task_local 工作目录）保持不变。本 PR 引入的 **Tenant** 是多租户隔离边界。文档与代码注释里两个词必须严格区分，避免后续读者混淆。

**验收**
- `cargo check -p harness-core --no-default-features` 通过。
- 单元测试覆盖 slug 校验（与 `project::validate_slug` 同款规则）+ UUID 生成 + 空 slug 拒绝。

**依赖**：无前置；可独立先做。

---

### PR-0.2 — 5 个 TenantStore 后端实现 + ensure default tenant

**范围**
- `crates/harness-store/` 下 5 个文件各加 TenantStore 实现：`memory.rs / json_file.rs / sqlite.rs / postgres.rs / mysql.rs`。
- 启动时 `ensure_default_tenant()` 写入 `slug = "default"` 的 tenant（已存在则跳过）。
- SQL 后端加 `UNIQUE INDEX` 在 `slug` 上；JSON / memory 后端写时唯一性检查。
- `harness_store::connect(url)` 返回值扩展，组合根能拿到 `Arc<dyn TenantStore>`。

**验收**
- 每个后端各一个 `first_start_creates_default_tenant` 测试。
- 重复启动幂等性（不重复创建 default）。
- slug 冲突写入返回 backend-specific 冲突错误。

**依赖**：PR-0.1。

---

### PR-0.3 — AppState.tenants + X-Tenant-Slug 中间件 + default 回落

**范围**
- `crates/harness-server/src/state.rs`：`AppState` 加 `tenants: Option<Arc<dyn TenantStore>>` + `with_tenant_store` 装配。
- 新增 `crates/harness-server/src/tenant_resolver.rs`：axum middleware
  - 读 `X-Tenant-Slug` header，缺失即用 `default`。
  - `slug → tenant_id` 解析（命中存储一次，可加 in-memory cache）。
  - 解析失败（slug 不存在）→ 404 `{error: "unknown tenant"}`。
  - 成功后把 `Tenant { id, slug }` 注入 `request.extensions`。
- `lib.rs::router` 在所有 `/v1` 路由上挂中间件。

**兼容性**
旧客户端不带头时全部走 default tenant，行为完全不变。这是本阶段最关键的 invariant。

**验收**
- 现有 e2e（不带头）全绿。
- 新增测试：带未知 slug → 404；带已知 slug → handler 拿得到正确 tenant_id；缺失头 → handler 拿到 default。

**依赖**：PR-0.2（要从 store 解析 slug）。

---

### PR-0.4 — Project/Conversation/Requirement/Doc/Todo/Permission 加 nullable tenant_id

**范围**
- 6 个 `harness-core` 值类型加 `tenant_id: Option<String>`：`Project / Conversation (or ConversationMetadata) / Requirement / DocProject / TodoItem / PermissionRule`。
- `harness-store` 5 后端各 6 张表 schema 加 nullable `tenant_id` 列 + 上下迁移脚本（SQL 后端）/ 字段（JSON / memory）。
- handler 写入时：从 request extension 取 `tenant_id` 回填到值类型；读取时按 `tenant_id` 过滤（未带头 → default tenant 范围）。
- broadcast event 也带 `tenant_id` 字段，WS 订阅按 `tenant_id` 过滤。

**不在范围**
`NOT NULL` 约束**本 PR 不加**——保留 1–2 minor 版本过渡期，让旧数据缓慢回填，再切硬约束。

**验收**
- 每张表迁移上下来回。
- 旧客户端不带头读到的数据 ⊆ default tenant 范围。
- 跨 tenant 隔离：在 tenant A 创建 project，tenant B 列表里看不到。
- WS broadcast 不会跨 tenant 泄漏。

**依赖**：PR-0.3。

---

### PR-0.5 — REST /v1/tenants 端点 + Web UI 隐藏切换器

**范围**
- 新增 `crates/harness-server/src/tenants_routes.rs`：`GET / POST / PATCH / DELETE /v1/tenants` + `GET /v1/tenants/:slug`。
- `apps/jarvis-web/src/services/tenants.ts`：tenants list / create hook。
- 切换器组件：**只在 tenant 数量 > 1 时显示**——单 tenant 部署用户根本看不到 tenant 概念。
- 切换器写入 `localStorage["jarvis.activeTenantSlug"]`，所有 fetch 自动加 `X-Tenant-Slug` 头。

**验收**
- 全新启动只有 default tenant，UI 完全不暴露。
- 创建第二个 tenant 后切换器自动出现。
- 切到 tenant B 后，所有看板视图（projects / requirements / docs / todos）都按 tenant B 范围渲染。

**依赖**：PR-0.4。

---

## Phase 1：端云骨架（In-proc reverse-WS + Cloud / Edge）

第一版就把 agent loop 从 HTTP handler 里拆出来——server 入队、本地 runtime 认领——但 transport 先用 in-proc loopback（同进程内 mpsc）。未来切到远程 transport 时不需要重写调度层。

### PR-1.1 — harness-cloud crate scaffold

**范围**
- 新增 `crates/harness-cloud/`：`Cargo.toml` 加入 workspace `members`。
- 占位文件：
  - `src/lib.rs`
  - `src/model.rs`（`EdgeNode / EdgeCapabilities / EdgeToolSpec / CloudVendor / EdgeNodeStatus` 等类型，与 `cloud-capabilities.zh-CN.md` 对齐）
  - `src/transport.rs`（`EdgeTransport` async trait 占位）
  - `src/envelope.rs`（envelope schema 占位）
- 依赖：`harness-core.workspace = true`、`serde / tokio / async-trait`；不引入任何云 SDK。

**验收**
- `cargo check --workspace` 通过。
- `cargo clippy -p harness-cloud --all-targets -- -D warnings` 通过。
- 不被任何 binary 强制依赖（feature gate 只是把它编译进 workspace）。

**依赖**：无前置；与 Phase 0 解耦，可并行。

---

### PR-1.2 — runtime.* / task.* 协议帧 + LoopbackTransport

**范围**
- `harness-cloud::envelope`：定义统一 envelope `{v: 1, type, id, ts, tenant_slug, runtime_id, payload}`，含 serde + 版本兼容兜底（未知 type → `Unknown` 变体）。
- 8 种 payload 类型：
  - `runtime.register / runtime.heartbeat`
  - `task.dispatch / task.claim / task.progress / task.complete / task.fail / task.cancel`
- `LoopbackTransport`：单进程内 mpsc 实现 `EdgeTransport`，server 端入队 / runtime 端 claim 走同一进程的两条 channel。

**验收**
- 序列化 round-trip 单元测试覆盖所有 8 种 payload。
- `LoopbackTransport` 端到端测试：dispatch 一条 task → runtime 处理 → progress 流回 → complete 终止。
- 未知 type / 未知字段不 panic（forward-compat）。

**依赖**：PR-1.1。

---

### PR-1.3 — Agent loop 拆到 LocalRuntime（最大改动；surgical refactor）

**范围**
抽出 `harness-cloud::LocalRuntime` 服务，承担 `agent.run_stream(snapshot)` 的角色。改造 4 处现有调用点：
- `crates/harness-server/src/routes.rs:372` (`chat_completions_stream`)
- `crates/harness-server/src/routes.rs:1233` (`handle_client_frame` 第一处)
- `crates/harness-server/src/routes.rs:1665` (`handle_client_frame` 第二处)
- `crates/harness-server/src/routes.rs:1801` (`handle_client_frame` 第三处)

改造模式：
1. handler 不再直接 `agent.run_stream(snapshot)`
2. 而是 `runtime.dispatch(task.dispatch payload)` 入队
3. 透传 `runtime.progress / complete / fail` 事件流给 client

**不变量**
- HTTP / WS 客户端看到的事件流形状完全不变（`AgentEvent` / WS frame 一字未改）。
- approval / permission gate 仍然工作。
- `session_id / work_dir` 复用语义不变。

**验收**
- 现有 chat / requirement run / WS approval / permission e2e 测试**全部不退化**。
- 新增测试："事件跨 runtime 边界"完整性（progress 不丢、`ToolStart / ToolEnd` 配对、`Done` 终止）。
- benchmark：单 turn 增加的延迟 < 5ms（loopback mpsc 应该接近零成本）。

**依赖**：PR-1.2。

> **风险缓解建议**：这是 Phase 1 风险最高的 PR，建议拆成以下 3 个子 PR 串行合入：
> 1. [a] 抽 `LocalRuntime` 接口；
> 2. [b] `routes.rs:372` 单点改造；
> 3. [c] `handle_client_frame` 三处改造。

---

### PR-1.4 — WebSocketTransport（loopback 的远程兄弟）

**范围**
- `harness-cloud::WebSocketTransport`：实现远程 `EdgeTransport`，复用 PR-1.2 同一套 envelope / payload / 消息处理代码，**仅 URL + 鉴权层不同**。
- `apps/jarvis` 加 `JARVIS_CLOUD_MODE=cloud | edge | off`；`off`（默认）走 `LoopbackTransport`，`cloud` 暴露 `/v1/edge/ws`，`edge` 主动连 `JARVIS_EDGE_CLOUD_URL`。
- daemon-token / PAT 鉴权走同一条 header 校验路径（cloud / self-host 两种部署等价）。

**验收**
- `JARVIS_CLOUD_MODE=off` 启动行为与 PR-1.3 之后完全一致。
- 本机两进程：A 跑 `JARVIS_CLOUD_MODE=cloud`，B 跑 `JARVIS_CLOUD_MODE=edge` 连 A，能跑通一条 `RequirementRun`。
- 心跳超时后 server 标记 runtime offline，新任务不再派发到它。
- 鉴权失败返回 401，不泄漏 internal state。

**依赖**：PR-1.3。

---

### PR-1.5 — cloud-blueprint.zh-CN.md 文档 + CI 矩阵

**范围**
- 新增本文档 `docs/proposals/cloud-blueprint.zh-CN.md`：看板镜像（同样的 PR 拆分 + 验收 + 依赖图）。
- 更新 `docs/proposals/README.md` 索引页，加 cloud-blueprint 条目；交叉引用 `cloud-capabilities.zh-CN.md`。
- CI：在 `cargo check / clippy` 矩阵加 `--features cloud` 维度（即使默认未启用也要保证编译通过）。
- `README.md` 的 `Architecture` 段落补一句 "optional cloud / edge runtimes via harness-cloud"。

**验收**
- CI 绿。
- 蓝图文档与本 Project 看板上的 10 条 Requirement 一一对账（任何 PR 标题 / 验收变更要双向同步）。

**依赖**：与 PR-1.4 并行，不阻塞 Phase 1 收尾。

---

## 依赖图

```text
PR-0.1 ──→ PR-0.2 ──→ PR-0.3 ──→ PR-0.4 ──→ PR-0.5
                                              (Phase 0 收尾)

PR-1.1 ──→ PR-1.2 ──→ PR-1.3 ──→ PR-1.4
   ↑                                  ↓
   └──────────────────────────────────┘
        PR-1.5 与 PR-1.4 并行
```

- Phase 0 与 Phase 1 之间无强制依赖，可并行推进。
- Phase 0 是 Cloud 路线的前置基础，但本身不引入任何 cloud 依赖。
- Phase 1 内部 PR-1.3 是风险最高的 surgical refactor，建议再拆子 PR。

---

## 验收总表

| PR | 关键验收项 |
|---|---|
| PR-0.1 | `cargo check -p harness-core --no-default-features` 绿；slug / UUID / 空 slug 单元测试覆盖。 |
| PR-0.2 | 5 后端各一个 `first_start_creates_default_tenant` 测试；幂等；slug 冲突报错。 |
| PR-0.3 | 现有 e2e（不带头）全绿；未知 slug → 404；已知 slug → 正确 tenant_id。 |
| PR-0.4 | 每张表迁移可上可下；旧客户端数据 ⊆ default tenant；WS 不跨 tenant 泄漏。 |
| PR-0.5 | 单 tenant UI 不暴露切换器；多 tenant 自动出现；切 tenant 后视图隔离。 |
| PR-1.1 | `cargo check --workspace` 绿；`cargo clippy -p harness-cloud` 绿；无 binary 强制依赖。 |
| PR-1.2 | 8 种 payload round-trip 测试；LoopbackTransport e2e；未知 type 不 panic。 |
| PR-1.3 | 现有 e2e 全部不退化；事件跨边界完整性；单 turn 延迟 < 5ms。 |
| PR-1.4 | `off` 模式行为不变；cloud+edge 双进程跑通 RequirementRun；心跳离线；401 不泄漏状态。 |
| PR-1.5 | CI 绿（含 `--features cloud`）；本文档与看板 10 条 Requirement 一一对账。 |

---

## 与 `cloud-capabilities.zh-CN.md` 的对照

| 维度 | `cloud-capabilities.zh-CN.md` | `cloud-blueprint.zh-CN.md`（本文档） |
|---|---|---|
| 定位 | 顶层设计、产品对齐、厂商矩阵、风险取舍 | 落地执行、PR 拆分、验收明细、依赖关系 |
| 术语 | 使用 **Workspace**（与 multica 对齐） | 使用 **Tenant**（与看板 Requirement 对齐） |
| 范围 | Phase 0 ~ Phase 5 全图景 | 仅 Phase 0 / Phase 1 的 10 条 Requirement |
| 变更源 | 产品/架构决策变更时更新 | 看板 Requirement 标题/验收/依赖变更时双向同步 |

如需查看后续阶段（Phase 2+ 远程工具调用闭环、Phase 3 策略与审批、Phase 4 对象存储、Phase 5 厂商增强），请回到 [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md)。
