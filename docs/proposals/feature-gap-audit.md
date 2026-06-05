# Feature Gap Audit — 功能迭代缺口审计

> **Date:** 2026-06-05
> **Method:** 每条提案都到代码里 grep / 读文件核实，**不信** `README.md` 表格里的
> `Status` 标记（经常滞后于实际落地）。下表按"未迭代程度"从重到轻排，每项附代码证据。
> **重要发现:** README 状态表严重滞后 —— 标 `Proposed` 的有一半其实已落地。本次同步
> 已把 `docs/proposals/README.md` 的状态列校正，并补全了 6 个缺失的提案行。

---

## P0 — 完全未开始（0%）

高产品价值、零基础设施。新做一块独立 PR 即可。

### 1. 客户端 SDK · [client-sdks.md](client-sdks.md)
- **现状:** 仓库无 `clients/`、无 `crates/jarvis-client`、server 未输出 OpenAPI。TS/Python SDK 全部空白。
- **缺口:** `clients/typescript/`、`clients/python/`、server 端 `GET /v1/openapi.json`(utoipa)、版本端点。
- **建议落点:** 先在 `harness-server` 加 OpenAPI emission，再据此生成两个 SDK 包；命名空间按 `product-design` 用 `chat` / `work` / `doc` / `capabilities`。

### 2. 项目连接器 · [project-connectors.zh-CN.md](project-connectors.zh-CN.md)
- **现状:** 无 `harness-connectors`、无 `ProjectConnector` trait；接外部 tracker 完全没做，目前只有本地 `roadmap.import`(扫描 `docs/proposals/`)。
- **缺口:** `ProjectConnector` trait + GitHub/Jira/Linear/Notion 实现、`ConnectorAccount` / `ProjectBinding` / `RequirementBinding` 模型、connector store(memory/json/sql)、`connector.*` 工具、Web UI 绑定面板。
- **建议落点:** 先做 GitHub Issues 单连接器走通"导入→需求→回写状态"闭环，再抽 trait 泛化。

---

## P1 — 只有数据模型/骨架，核心闭环缺失（30–60%）

数据结构已铺好，**只差把循环跑起来**，启动成本相对低、ROI 高。

### 3. 自进化 Agent · [self-improving-agent.zh-CN.md](self-improving-agent.zh-CN.md)
- **已有:** `harness-learning` 数据模型齐全 —— `SkillUsageEvent`、`MemoryItem`、`SkillLifecycle`(含 `curator_may_mutate` 守卫)；`/v1/learning/skill-usage` 路由。
  - 证据: `crates/harness-learning/src/lib.rs`(`//! The Reviewer fork and the Curator are deliberately left to later phases` — 自己也承认未做)。
- **缺口:** 后台 `LearningReviewer` fork 复盘循环、`Curator` 定时任务(归档/标记 stale)、`skill.manage` 工具(patch/archive/restore)、Memory/Skill 召回注入 system prompt 的完整链路。

### 4. OTel-native Eval Harness · [otel-native-eval-harness.zh-CN.md](otel-native-eval-harness.zh-CN.md)
- **已有(比想象中多):** span 埋点已接入 —— `crates/harness-core/src/agent.rs` 发 `jarvis.agent.run` / `jarvis.agent.iteration` / `gen_ai.tool.call`；`ObservabilityStore` 有 json_file 实现；dashboard 路由 `/v1/observability/{dashboard,runs,tools,subagents,direction,exporter,health}` + `/v1/evals/{summary,cases}` 读侧齐全。
  - 证据: `crates/harness-server/src/observability_routes.rs:27-46`。
- **缺口:** eval **runner/grader** —— 没有跑评测套件并写 `EvalCaseResult` 的执行引擎(dashboard 只读不产)、没有 `jarvis eval` CLI 子命令、没有 grader 调用 LLM 打分的逻辑。

### 5. 端云协同 Cloud/Edge · [cloud-blueprint.zh-CN.md](cloud-blueprint.zh-CN.md) + [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md)
- **已有:** Tenant 多租户(Phase 0)—— `crates/harness-core/src/tenant.rs` + `TenantStore` + 各后端；`harness-cloud` transport/envelope/loopback/websocket 骨架。
- **缺口:** `LocalRuntime` 拆解(agent loop 仍内嵌 HTTP handler)、`/v1/edge/ws` 路由、远程工具调用闭环(`RemoteEdgeTool` 仅 stub)、`JARVIS_CLOUD_MODE` 解析、Phase 2+ 全部。

### 6. Symphony 常驻编排 · [symphony-inspired-orchestration.zh-CN.md](symphony-inspired-orchestration.zh-CN.md)
- **已有:** worktree + `auto_mode` 单步推进 + `reconcile_runs_for_conversation`。
- **缺口:** tracker adapter(`IssueTrackerAdapter` / `NormalizedIssue` 不存在)、`WORKFLOW.md` 完整 YAML front-matter 解析(目前只有字符串 seed)、retry queue + 指数退避 + stall detection、常驻 orchestrator tick 循环。
- **关联:** 与 P0-2(项目连接器)的 tracker 部分高度重叠 —— 建议合并设计。

---

## P2 — 部分落地，缺后续阶段（33–67%）

主体已用，补 Phase 2/3 即可闭环。

### 7. 模型/工具兼容 · [model-tool-compatibility.zh-CN.md](model-tool-compatibility.zh-CN.md)
- **已有:** `ProviderProfile` 目录(14 内置) + `ToolMetadata` + `/v1/providers` + `/v1/tools` + MCP 路由。
- **缺口:** 动态模型目录(OpenRouter API 拉取)、工具 Capability Packs 启停 UI、`ModelRoutePolicy` 自动路由(coding/review/doc slots)、`subagent.batch` join 策略(summarize/race/all_required)验证。

### 8. 渠道插件 · [channel-plugins.md](channel-plugins.md)
- **已有:** `ChannelBinding` / `ChannelInstance` store + `ChannelAdapter` registry + plugin manifest 的 `channel_adapters` 解析；WeCom/Feishu/DingTalk 仅枚举占位。
- **缺口:** `PluginManager` 真正 spawn/supervise/stop adapter(现仅解析配置不执行)、WS 协议 `user.source` 字段、`JARVIS_CHANNEL_TOKEN` 鉴权、Rust `harness-channel-sdk`(外部 adapter 开发)。

### 9. Web 多会话异步运行 · [web-multi-session-runs.zh-CN.md](web-multi-session-runs.zh-CN.md)
- **已有(Phase 0–2):** per-conversation socket(`conversationSockets.ts`) + run 状态机(`lifecycleSlice.ts`) + surface snapshot 保存恢复 + 后台 run registry(`chatRuns.ts` seq 补帧)。
- **缺口(Phase 3):** 全局 Running 面板(列出所有 active runs)、sidebar 当前工具摘要、系统通知(run 完成/等待审批)、多 tab `BroadcastChannel` 去重。

### 10. 会话执行上下文条 · [session-execution-context.zh-CN.md](session-execution-context.zh-CN.md)
- **已有(Phase 1):** 只读执行条(`SessionExecutionShoulder.tsx`) + 详情抽屉(`SessionExecutionDrawer.tsx`) + 聚合 hook(`useConversationWorkContext.ts`)。
- **缺口:** WS 实时更新(`requirement_run_*` / `activity_appended` frame 订阅入 store)、后端 `GET /v1/conversations/:id/work-context` 聚合接口(现纯前端派生)、抽屉操作按钮(继续/停止/重验/标记完成)。

---

## P3 — 基本完成，仅余边角（80%+）

### 11. CLI · [cli.md](cli.md)
- **已有:** REPL(流式+多轮+审批门禁) + `--no-interactive` pipe + slash 命令(`/mode` `/model` `/policy` `/save` …) + 项目上下文。
- **缺口:** Work/requirement 子命令(目前 Chat-only)、ratatui TUI、Windows 支持。

### 12. Tauri 桌面端 · [tauri-desktop-client.zh-CN.md](tauri-desktop-client.zh-CN.md)
- **已有:** Tauri 壳 + sidecar 生命周期管理(`sidecar.rs` 起 `jarvis serve` + 健康检查 + 复用现有 server) + IPC 命令 + macOS DMG 发布 CI。
- **缺口:** 异步后台 run 注册表(`SessionRunRegistry` + `/v1/conversations/:id/runs` 不存在)、系统托盘菜单、自动更新、代码签名/公证。

### 13. 沙箱 · [sandboxing.md](sandboxing.md)
- **已有:** `Sandbox` enum(bubblewrap / sandbox-exec)+ `ShellLimits`(CPU/内存/fd/进程数)。
- **缺口:** 容器后端(Docker/Podman)—— 原提案就规划为未来 cut，非紧急。

### 14. Onboarding · [onboarding.md](onboarding.md)
- **已有:** `init` / `login` / `logout` / `status` 子命令 + config 文件 + per-provider auth store(0600) + 多平台 release CI(linux/macos/windows × arm/x64)。
- **缺口:** `install.sh` 一键脚本、Homebrew tap 分发(可能属独立 repo)。

---

## 推荐迭代顺序

1. **P0-2 项目连接器 (GitHub 单连接器先行)** —— 产品价值最高，且与 P1-6 Symphony 的 tracker 需求合并，一箭双雕。
2. **P1-4 Eval runner** —— 观测/dashboard 已就位，补一个 suite runner + `jarvis eval` 就能形成"改动→评测→回归"闭环，护住后续所有迭代质量。
3. **P1-3 自进化 Agent 的 Curator 循环** —— 数据模型已齐，落一个后台 tick 即点亮自我成长。
4. **P0-1 客户端 SDK** —— 先加 server OpenAPI emission(顺带利好所有外部集成)，再生成 TS/Python。
5. **P2 三项 Web/兼容收尾** —— 用户可感知的体验补全，成本低。

---

## 已完整落地（README 状态曾滞后，本次已校正）

`prompt-caching` · `token-estimation` · `sandboxing(v0)` · `codex-provider` · `declarative-workflows` ·
`subagents` · `persistent-todos` · `permission-modes(含 Web UI)` · `new-session-resource-manager` ·
`chat-sidebar-project-groups` · `web-ui` · `work-orchestration(Phase 0–6.5)`
