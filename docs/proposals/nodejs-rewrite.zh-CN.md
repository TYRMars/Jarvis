# 用 Node.js 重写 Jarvis 服务端与 CLI

**状态：** Proposed（未开始）
**涉及：** 全量重写 `apps/jarvis`、`apps/jarvis-cli` 及 19 个 `harness-*`
crate（Rust → TypeScript）；`apps/jarvis-desktop`（Tauri → Electron）；
`apps/jarvis-web`（保留，仅改接入点）；`apps/jarvis-ios`（保留 Swift 原生，
仅对齐 API）。

> 这是一份**大跨度、长周期**的重构提案。核心结论先行：**不做一次性重写**，
> 以「`/v1` HTTP/SSE/WS 契约」为防火墙，用**绞杀者（strangler）模式**逐切片
> 迁移，全程对前端/iOS/桌面客户端无感。

---

## 1. 背景与目标

Jarvis 当前是一个 Rust Cargo workspace：运行时无关的 `harness-core` 为叶子，
其余 crate 插入实现 HTTP / provider / 存储 / MCP。该设计本身很干净，但团队希望：

- **统一技术栈到 Node.js / TypeScript**，与前端（React 19）同源，降低协作与
  招聘门槛；
- **消灭 `ts_rs` 代码生成链**——服务端改 TS 后，前后端可直接共享一份类型；
- **桌面端从 Tauri 切到 Electron**，与 Node 服务端同运行时，简化打包与分发；
- **iOS 端保持 Swift 原生**（仓库已有 `apps/jarvis-ios/`），仅消费新服务端 API。

### 目标

1. 行为等价：迁移后 `/v1` REST + SSE + WS + MCP 契约与现状**逐字节对齐**，
   现有 Web / iOS 客户端零改动即可工作。
2. 保留架构铁律：**`core` 包不依赖 HTTP / provider / 存储 / MCP**；库包不读
   `process.env`，只有 `apps/jarvis` 组合根装配。
3. 可回退：迁移期间 Node 与 Rust 服务可并存，未迁移路由代理回 Rust。

### 非目标

- 不借机做产品功能扩张（迁移与新功能解耦，先等价、后演进）。
- 不追求 Node 端 CPU 性能超越 Rust（服务整体 I/O bound，瓶颈在 LLM 调用）。

---

## 2. 范围矩阵

| 组件 | 现状 | 处理 | 说明 |
|---|---|---|---|
| 服务端（19 crate + `apps/jarvis`）| Rust，~115K 行 | **重写 → Node/TS** | 工作量大头 |
| CLI（`apps/jarvis-cli`）| Rust，~1.5K 行 | **重写 → Node/TS** | `commander`，可选 `ink` 做 TUI |
| Web（`apps/jarvis-web`）| React 19 + Vite，~70K 行 | **保留** | 改 base URL + 引用共享类型包 |
| iOS（`apps/jarvis-ios`）| SwiftUI 原生 | **保留 Swift** | 仅对齐 `/v1` 契约，不重写 |
| 桌面（`apps/jarvis-desktop`）| Tauri（Rust 壳）| **替换 → Electron** | 主进程内嵌 Node 服务 |
| `ts_rs` codegen | 9 文件 / 29 类型 | **删除** | 改 `packages/shared-types` |

---

## 3. 现状盘点（要搬的体量）

服务端 Rust 约 **115K 行**，体量集中在三块——迁移排期必须围绕它们：

| 模块 | 行数 | 性质 |
|---|---|---|
| `harness-server` | 44.8K | ~30 个 `*_routes.rs`，HTTP/WS/SSE，最大单点风险 |
| `harness-tools` | 18.0K | 内置工具（fs/shell/git/grep/http/memory/requirement…）|
| `harness-store` | 14.4K | JSON-file + SQLite/PG/MySQL 后端 |
| `apps/jarvis` | 9.4K | 组合根（读 env、装配、子命令）|
| `harness-core` | 8.7K | agent loop + trait（承重墙）|
| `harness-llm` | 8.5K | OpenAI / Anthropic / Google / Responses(Codex) |
| `harness-project` | 3.6K | Work 域值类型 + store trait |
| `harness-memory` | 2.8K | 滑窗 + 摘要记忆 |
| `harness-subagents` | 2.4K | 子代理注册 + 派发 |
| 其余 11 个 crate | 各 0.2–1.8K | requirement / channel / skill / plugin / learning / automation / cloud / workflow / router / mcp / observability |

客户端契约面（迁移的**对齐基线**）：Web 端有 **58 个 service 文件**，全部走
`/v1/*` REST + SSE + WebSocket；服务端仅 29 个类型经 `ts_rs` 暴露。契约清晰、
面收敛——这正是绞杀者迁移可行的前提。

---

## 4. 总体策略：契约即防火墙 + 绞杀者迁移

### 4.1 为什么不 big-bang

115K 行、契约面广（REST + SSE + WS + MCP + OAuth + 4 个 LLM provider），
一次性切换的「不可用窗口」极长、回归不可控。

### 4.2 契约即防火墙

Web 与 iOS 客户端都只依赖 `/v1` 的 **HTTP + SSE + WS** 契约。只要新 Node 服务
在每条路由上与 Rust 行为一致，客户端就**无需任何改动**。因此：

- 把「现有 Rust 服务的请求→响应/SSE 帧/WS 帧」录成**黄金样本**；
- Node 实现以黄金样本为验收标准（详见 §10）。

### 4.3 绞杀者迁移（strangler）

1. 起一个 Node 网关服务，默认把所有 `/v1/*` **反向代理回现有 Rust 服务**；
2. 按**垂直切片**（chat → tools → work → 周边域）逐组用 Node 原生实现替换代理；
3. 每替换一组，摘掉对应代理转发；
4. 全部迁完后，撤掉代理、下线 Rust。

整个过程前端只指向**一个** base URL，客户端无感；任何一组出问题可快速切回代理。

---

## 5. 目标架构（monorepo + 包映射）

工具链：**pnpm workspace + Turborepo**，`crate → package` 一一映射，保留边界。

```
packages/
  core/          # Agent loop, Conversation, Message, Tool/LlmProvider/Memory/
                 # Approver 接口, plan/progress/approval 通道（纯 TS，零框架）
  shared-types/  # 取代 ts_rs：zod schema + 推导类型，前后端共享
  llm/  router/  mcp/  memory/  tools/  store/
  channel/  project/  requirement/  observability/
  skill/  subagents/  plugin/  learning/  automation/  cloud/  workflow/
  server/        # 传输层：HTTP/WS/SSE 路由 + buildServer(appState)
apps/
  jarvis/        # 唯一组合根：读 env、装配 tools/stores/provider；
                 # 子命令 serve / mcp-serve / init / login / status / workspace
  jarvis-cli/    # 终端 agent（commander，可选 ink）
  jarvis-web/    # 保留；改 base URL + 引用 shared-types
  jarvis-ios/    # 保留 Swift；仅对齐 /v1 契约
  jarvis-desktop # Electron；主进程内嵌 server 包
```

**铁律落地手段：**

- `core` 及所有库包是**框架无关的纯 TS**，绝不 import HTTP 框架；
- 用 ESLint `no-restricted-globals` / `no-process-env` 禁止库包读 `process.env`，
  只有 `apps/jarvis` 例外；
- 用 Nest module 图（或 Turbo 的 package 依赖约束）强制 crate 边界，避免
  `core → server` 的反向依赖。

---

## 6. 技术选型与依赖映射

### 6.1 服务端框架（待最终拍板，见 §12）

库层（`core/llm/tools/store/...`）**一律纯 TS**，不绑框架。框架只活在 `server`
包。两个候选：

- **推荐：NestJS（跑在 Fastify adapter 上）。** 现架构重 DI、强 trait 抽象
  （`Tool`/`LlmProvider`/`Memory`/`Approver` 一接口多实现、`connect(url)` 按
  scheme 选后端），与 Nest 的 IoC 容器 + 自定义 provider token + module 图几乎
  1:1；`@Sse()` 装饰器天然承接 agent 的事件流；跑在 Fastify 内核上不牺牲性能。
  代价是学习曲线与样板。
- **备选：纯 Fastify。** 更轻、对流式/WS 完全显式控制、少魔法、起步快；代价是
  DI / 模块边界要自己维护。

> 关键事实：该选择**只影响 `server` 包**。库包无论选谁都是纯 TS，可后期切换。

### 6.2 依赖映射

| Rust（现状）| Node 等价 | 备注 |
|---|---|---|
| `axum` + `tower` | Fastify（裸用或经 Nest adapter）| |
| `tokio` / `async-stream` / `tokio::select!` | `async/await` + **async generator** | 流式 loop 核心 |
| `reqwest` | `undici` / 原生 `fetch` | |
| LLM provider 手写 | 官方 SDK `openai` / `@anthropic-ai/sdk` / `@google/genai` | 省大量 wire 转换 |
| `rmcp`（MCP）| `@modelcontextprotocol/sdk` | client+server 现成 |
| `sqlx` | Drizzle（或 `better-sqlite3` / `pg` / `mysql2`）| JSON 后端用 `fs` |
| `ts-rs` | **删除** → `shared-types`（zod）| 前后端同源 |
| `serde` + 手写 JSON Schema | **zod** | 校验 + 类型 + tool JSON Schema 三合一 |
| `ignore`（gitignore 遍历）| `ignore` + `globby`；`code.grep` 可直调 ripgrep | |
| `tiktoken-rs` | `js-tiktoken` / `gpt-tokenizer` | token 估算 |
| `portable-pty` | `node-pty` | `/v1/workspace/terminal` |
| `diffy` | `diff` / `parse-diff` | `fs.patch` |
| `blake3`/`sha2`/`hmac`/`aes` | `node:crypto`（blake3 用 `hash-wasm`）| 渠道签名、摘要指纹 |
| `clap` / `dialoguer` | `commander` + `prompts`（可选 `ink`）| CLI |
| `include_dir!` | `@fastify/static` 服务 dist；Electron 直接 `loadFile` | |
| `tracing` + OTel | `pino` + `@opentelemetry/sdk-node` | |
| `tauri` | `electron` + `electron-builder` | |

---

## 7. 客户端策略

### 7.1 Web（保留）

React 19 + Vite SPA 不重写。改动仅三处：
1. base URL 指向 Node 服务（迁移期指向网关）；
2. `src/types/generated/`（29 个 ts_rs 类型）切到 `packages/shared-types`；
3. 删除 `make ts-codegen` 链路。

### 7.2 iOS（保留 Swift 原生）

`apps/jarvis-ios` 已是 SwiftUI 原生应用，**不重写**。它与 Web 一样只依赖 `/v1`
REST + SSE + WS 契约——只要 Node 服务严守契约（§4.2），iOS 端零改动。迁移期
iOS 指向网关即可。后续若要新增能力，遵循「先服务端契约、后客户端消费」。

### 7.3 Mac 桌面（Tauri → Electron）

- 加载方式：Tauri 的 `frontendDist: ../jarvis-web/dist` → Electron `loadFile(dist/index.html)`；
- 服务端宿主：**Electron 主进程直接 `import` 并启动 `server` 包**（同为 Node 运行时，
  省掉 Tauri 的 sidecar 二进制分发）；亦可降级为子进程模式；
- 窗口：复用 `1280×860`、标题 `Jarvis`；
- IPC：`@tauri-apps/api` → Electron `ipcMain/ipcRenderer` + preload bridge；
- 前端适配点：`apps/jarvis-web/src/services/desktop.ts` 重写桥接层；
- 打包：`electron-builder`（macOS dmg/zip，后续可扩 Win/Linux）。

### 7.4 CLI（Rust → Node）

`jarvis-cli` 在进程内驱动 `core` 的 Agent（不走 HTTP），provider 由 env 构造。
Node 版用 `commander` 实现 REPL + `--no-interactive` 管道模式（单轮、AlwaysDeny），
保留审批门、slash 命令、项目上下文加载。TUI 可选 `ink`。

---

## 8. 关键难点与对策（决定成败）

1. **流式 agent loop**（`run` / `run_stream`）。Rust 用 `async_stream` +
   `tokio::select!` 合流工具结果 / plan / progress / approval。Node 用 **async
   generator** 产出 `AgentEvent`，辅助通道用 `AsyncIterable` 或轻量事件总线合并。
   必须锁死的不变量：恰好一个 `Done`（携带完整 `Conversation`）或 `Error`；
   **工具错误捕获后转文本** `tool error: {e}` 让模型自愈；首次 LLM 调用前按需
   注入 system prompt。→ Phase 1 第一件事，写测试钉死。

2. **沙箱安全**（`sandbox::resolve_under` 拒绝绝对路径 + `..`）。安全敏感，用
   `path.resolve` + 前缀校验重写并补全测试；`fs.write/edit/patch`、`shell.exec`
   的 **opt-in + 审批门** 一并照搬。

3. **审批门 / WS 每连接 approver**。`ChannelApprover` 把 `PendingApproval` 经
   通道抛给传输层；WS 每 socket 独立 approver，`tool_call_id → 决议` 用
   `Map<id, callback>` 复刻；agent 在 await 前先 yield `ApprovalRequest`。

4. **Codex / ChatGPT OAuth**（`codex_auth.rs`）。解析 `auth.json`、401→refresh→
   retry once、并发 refresh 合流、原子改写——逻辑原样移植，安全且易错，需专测。

5. **MCP 双向**。client 把远程工具适配成 `Tool`（`<prefix>.<name>`）；server 用
   `--mcp-serve` 走 stdio 暴露本地 registry。用官方 SDK，比 Rust 版更省事。

6. **存储后端**。`connect(url)` 按 scheme 选后端；保留 `__memory__.` 前缀过滤、
   文件名百分号编码、原子 `tmp+rename`、`list()` 行为。SQL 后端按实际使用情况
   取舍（很可能 P1 只需 JSON + SQLite）。

7. **性能热点**。grep 用 ripgrep 二进制；token 估算用 wasm/JS tiktoken；blake3
   用 wasm。其余 I/O bound，Node 无压力。

8. **摘要记忆**（`SummarizingMemory`）。三级查找（内存槽 → 持久层 → LLM）、BLAKE3
   指纹、`__memory__.summary:<hash>` 合成行、`tools:[]` + 固定温度的摘要调用——
   行为照搬。

---

## 9. 分阶段路线图

> 依赖顺序：core → llm/memory/tools/store → server → apps。每阶段结束时前端均
> 可用（未迁移路由代理回 Rust）。规模用 T 恤尺寸（S/M/L/XL）粗估。
>
> **可执行任务清单（issue-ready）见 [nodejs-rewrite-tasklist.zh-CN.md](nodejs-rewrite-tasklist.zh-CN.md)**——
> 把每个 Phase 下的路线图展开成约 90 个带验收/依赖/规模/label 的任务。

| Phase | 内容 | 规模 |
|---|---|---|
| **0 地基** | pnpm + Turbo + tsconfig/eslint/vitest；`shared-types`；CI（typecheck+lint+test，对标「clippy 即门禁」）；Fastify/Nest 空壳 + **全量代理回 Rust**，前端切到 Node 端口验证全绿 | M |
| **1 core 承重墙** | Message/Conversation/Tool/LlmProvider/Memory/Approver 接口；`Agent.run` + `runStream`（async generator）；plan/progress/approval 通道；审批门。用假 provider + echo 工具把不变量写成测试 | L |
| **2 Chat 垂直切片** | `llm`（先 OpenAI+Anthropic，官方 SDK）+ `memory`（滑窗）+ `store`（JSON ConversationStore）；打通 `/v1/chat/completions[/stream]` + `/v1/chat/ws`，**前端聊天页切 Node**，摘掉对应代理 | L |
| **3 tools + MCP** | 按「读→写→exec→条件工具」批次：always-on（echo/time/http/grep/git/workspace.context/plan.update…）→ `fs.*`+沙箱 → `shell.exec` → MCP（含 `--mcp-serve`）→ 条件工具（requirement/doc/memory/todo/subagent…）。每批摘代理 | XL |
| **4 Work/Project 域** | `project`+`requirement` + 全部 project/requirement/comment/label/roadmap 路由 + `auto_mode` 自动循环 + worktree + workflow runtime。路由量大，逐组对照写契约测试 | XL |
| **5 周边域** | channels（WeCom/Feishu/DingTalk inbound + OAuth + 签名，安全敏感）、skills、plugins、market、learning、automation、observability、diagnostics、provider-admin、agent-profiles。可并行分人 | XL |
| **6 provider/路由/记忆补全** | Google、Responses/Codex OAuth；`router` 智能路由（HeuristicClassifier）；`SummarizingMemory`（含持久层）；SQL 后端按需 | L |
| **7 apps** | `apps/jarvis` 组合根全功能（含 init/login/status/workspace 子命令）；`jarvis-cli`；**Electron 桌面**（替 Tauri，主进程内嵌 server）；iOS/Web 改 base URL | L |
| **8 收尾** | 拆代理、下线 Rust；性能/压测对照；OTel；重写 CLAUDE.md；Web `types/generated` 切 `shared-types`、删 codegen | M |

里程碑节奏建议：Phase 2 完成即有**端到端可演示**（聊天走 Node）；Phase 4 完成
即覆盖核心业务（Work 看板/自动化）；Phase 8 才允许下线 Rust。

---

## 10. 测试与验收

- **黄金样本契约测试（核心手段）**：迁移每条路由前，用现有 Rust 服务录一组
  请求→响应/SSE 帧/WS 帧 样本；Node 实现逐字段对齐，尤其：
  - SSE 每个 `data:` 是一个 `AgentEvent` JSON；
  - WS 帧协议（`user`/`reset`/`resume`/`new`/`approve`/`deny`）；
  - 「未配置 store → 503」模式；`__memory__.` 前缀过滤。
- **前端回归网**：58 个 service + 现有 vitest 套件天然覆盖客户端契约。
- **专项单测**：agent loop 不变量、沙箱拒绝、审批门、OAuth refresh、摘要指纹。
- **CI 门禁**：typecheck + eslint（含库包禁 `process.env`）+ vitest，对标现有
  「clippy `-D warnings` 即门禁」。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `harness-server` 44K 行单点过大 | Phase 4/5 切片 + 契约测试拆解 |
| 流式语义偏差 → mid-stream 400 / 前端挂死 | Phase 1 钉死不变量 + 黄金样本 |
| OAuth / 渠道签名移植出错难排查 | 专项测试 + 与 Rust 版对拍 |
| Node CPU 性能弱于 Rust | 热点用二进制/wasm；整体 I/O bound 影响小 |
| 迁移周期长、团队疲劳 | 绞杀者保证每阶段都有可演示成果，可随时回退 |
| Electron 包体 + 安全（contextIsolation 等）| 遵循 Electron 安全基线，preload bridge 收口 |

---

## 12. 待定决策（需团队拍板）

1. **服务端框架**：NestJS-on-Fastify（推荐，贴现架构）vs 纯 Fastify（更轻）。
2. **迁移方式**：确认采用绞杀者增量（Node+Rust 并存一段时间）。
3. **范围裁剪**：`jarvis-cli` 与 SQL（PG/MySQL）后端是否本轮迁移，还是 P1 只保
   JSON + SQLite。
4. **桌面优先级**：Electron 是本轮（Phase 7）还是服务端稳定后再做。
5. **iOS 协同**：是否在迁移期同步建立 iOS 的契约测试，防止服务端等价性回归
   时殃及 iOS。
