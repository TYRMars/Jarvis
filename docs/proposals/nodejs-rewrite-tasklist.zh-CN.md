# Node.js 重写 · 执行任务清单

**状态：** P0–P7 基本完成，端到端可运行（`jarvis serve` / `jarvis mcp-serve` / `jarvis-cli`）。
全量 typecheck + eslint + test 绿：**21 个包，1617 测试**。
**框架定档（0.6）：** 纯 Fastify（NestJS 装饰器与现 `node --experimental-strip-types`
+ `erasableSyntaxOnly` 工具链不兼容，留待将来若需 DI 再换）。

**已落地的包（packages/，括号内为测试数）：**
- 运行时核心：`core`(21)、`llm`(156，OpenAI/Anthropic/Google/Responses+Codex/capability/fallback/profile 全 provider)、
  `router`(24)、`memory`(41，SlidingWindow + Summarizing)、`store`(156，全域 JSON+内存后端 + connectAll)、
  `tools`(227，echo/time/http/grep/git/workspace/fs.*/shell + requirement.*/doc.*/learning.memory.*/todo.* 条件工具 + registerBuiltins)、
  `mcp`(28，client+server stdio)。
- Work/Project 域：`project`(75)、`workflow`(20)；`server` 内含 kanban CRUD + 审计时间线 + auto_mode 调度器（全守卫）+ workflow 执行引擎 + worktree。
- 周边域：`channel`(49)、`skill`(75)、`learning`(84)、`automation`(36)、`observability`(31)、`subagents`(60)、`plugin`(28)、`agent-profile`(29)、`todo`(30)。
- HTTP 服务：`server`(405) — chat completions/SSE/WS（per-socket ChannelApprover）+ conversations CRUD +
  projects/requirements(approve/reject/runs/review)/comments/labels/work + skills/automation/observability/diagnostics/
  provider-admin/learning/subagents/channels(CRUD+inbound 签名校验+oauth)/doc/memories/permissions/plugins/agent-profiles/todos/workspace(files/find/diff)。
- 组合根：`jarvis-app`(17，env 解析 + 装配全部 provider/store/tool + serve/mcp-serve/init/login/status/workspace 子命令 + 系统提示切换 + 项目上下文加载) 与 `jarvis-cli`(25，REPL + `--no-interactive` 管道)。

**真正延后（明确未做）：** terminal PTY（需 `node-pty`）；`memory.*` agent-markdown 记忆工具 + git/iCloud 同步；
GitHub connectors；tasks 路由；market 实时 HTTP 拉取；SQL 后端（P6.7，sqlite/postgres/mysql，JSON 后端已覆盖功能）；
前端 base-URL 切换 + `shared-types`（P7.9，属客户端改线）；Electron（P7.6–7.8）/ iOS（P7.10）客户端；
P8 下线 Rust（当前 Rust 与 Node 并存，不单方面删除）。

**配套：** [nodejs-rewrite.zh-CN.md](nodejs-rewrite.zh-CN.md)（设计与策略）。本文件是
其路线图的**可执行展开**——每个顶层任务可直接建一个 issue。

---

## 如何使用这份清单

- **Milestone**：每个 Phase = 一个 GitHub Milestone（`P0 地基` … `P8 收尾`）。
- **Issue**：每个顶层任务（如 `1.7`）= 一个 issue；标题用任务标题，正文把 `↳`
  子项粘成验收 checklist。
- **Label 约定**：
  - 阶段：`phase:0` … `phase:8`
  - 规模：`size:S`（<1d）/ `size:M`（1–3d）/ `size:L`（3–7d）/ `size:XL`（拆子任务）
  - 领域：`area:core` `area:llm` `area:tools` `area:store` `area:server`
    `area:web` `area:desktop` `area:cli` `area:ios` `area:infra`
  - 风险：`risk:high`（流式/沙箱/OAuth/签名等易错点）
- **依赖**：用 issue 正文的 `依赖: #xx` 或 task-list 关联表达。
- **完成定义（DoD，全局）**：typecheck + eslint（库包禁 `process.env`）+ vitest
  全绿；若替换了某 Rust 路由，对应**黄金样本契约测试**通过且代理转发已摘除。

### 关键路径（必须串行的承重链）

```
P0 地基 → P1 core(loop+通道+审批) → P2 Chat(provider+store+SSE/WS) → P3 tools
                                                                      ↘ P4 Work
P5 周边域 / P6 provider补全 可在 P3 后并行 → P7 apps(组合根+Electron+CLI) → P8 下线 Rust
```

规模合计粗估：**L/XL 任务集中在 P3（tools 18K）、P4（Work）、P5（周边域）**，
排期重心放这三段。

---

## P0 — 地基与网关代理 `phase:0`

> 目标：monorepo 跑起来 + 全量代理回 Rust，前端切到 Node 端口全绿。

- [x] **0.1** 初始化 pnpm workspace + 根 `tsconfig`/`eslint` `size:M` `area:infra`（用 node `--experimental-strip-types` 取代 Turbo/vitest；`prettier` 暂缺）
- [ ] **0.2** 共享测试配置（已落地 node:test）+ **CI workflow**（typecheck / lint / test，对标 `make lint`）仍待补 `size:M` `area:infra`
- [x] **0.3** ESLint 规则：库包禁 `process.env`（`no-restricted-properties`），仅 `apps/jarvis` 白名单 `size:S` `area:infra`
- [ ] **0.4** 建 `packages/shared-types` 骨架（zod schema + `z.infer` 导出） `size:S` `area:infra`
- [ ] **0.5** `server` 空壳：`/health` + **反向代理中间件**把 `/v1/*` 全转 Rust `size:M` `area:server` `risk:high`（`/health` 已有；代理中间件待补）
  - ↳ 验收：前端 base URL 指向 Node 端口，所有页面行为与直连 Rust 一致
- [x] **0.6** 框架选型 spike → **定档纯 Fastify**（理由见状态栏） `size:M` `area:server`

---

## P1 — harness-core 承重墙 `phase:1` `area:core`

> 目标：agent loop + 通道 + 审批门，全部不变量有测试。这是整个项目的地基。

- [x] **1.1** `Message` / `Conversation` 类型 + 序列化（对齐 OpenAI wire、externally-tagged role） `size:M`
- [x] **1.2** `Tool` 接口 + `ToolRegistry`（namespaced、同名覆盖语义） `size:S`
- [x] **1.3** `LlmProvider` 接口（`complete` + `completeStream`） `size:S`
- [x] **1.4** `Memory` 接口（`compact`） `size:S`
- [x] **1.5** `Approver` 接口 + `AlwaysApprove` / `AlwaysDeny` / `ChannelApprover` `size:M`
- [x] **1.6** plan / progress / approval 通道（per-invocation，`AsyncLocalStorage`） `size:M` `risk:high`
- [x] **1.7** `Agent.run`（阻塞循环：complete → 派发工具 → loop 到非 ToolCalls / max_iter） `size:L` `risk:high`
- [x] **1.8** `Agent.runStream`（async generator → `AgentEvent`：Delta / ToolStart / ToolEnd / Done / Error） `size:L` `risk:high`
  - ↳ 验收：恰好一个 `Done`（携带完整 `Conversation`）或一个 `Error` ✅
- [x] **1.9** 不变量测试套件 `size:M` `risk:high`
  - ↳ 工具错误捕获转文本 `tool error: {e}`；首调前按需注入 system prompt；审批 Deny 写合成 `tool denied` 消息 ✅
- [x] **1.10** 测试夹具：假 provider + echo 工具 `size:S`

---

## P2 — Chat 垂直切片（首个端到端可演示） `phase:2`

> 目标：聊天全链路走 Node，摘掉 chat 相关代理。

- [x] **2.1** `llm`：OpenAI provider（`complete` + SSE 流；arguments JSON-string；`StreamAccumulator` 按 index 重组；工具名 sanitize/restore；`prompt_cache_key`） `size:L` `area:llm` `risk:high`
- [ ] **2.2** `llm`：Anthropic provider（system 上提；`tool_use`/`tool_result` 块；`max_tokens` 必填；typed SSE） `size:L` `area:llm` `risk:high`
- [x] **2.3** `memory`：`SlidingWindowMemory` + turn 分组不变量（不拆 tool 对、保留 system/最近轮、cache-breakpoint 感知） `size:M` `area:memory`
- [x] **2.4** `store`：`connect(url)` + JSON-file + 内存 `ConversationStore`（原子 tmp+rename、文件名百分号编码；`__` 内部 id 由 server 层过滤） `size:M` `area:store`
- [x] **2.5** `server`：`POST /v1/chat/completions`（阻塞 → `{message,iterations,history}`） `size:M` `area:server`
- [x] **2.6** `server`：`POST /v1/chat/completions/stream`（SSE，每 `data:` 一个 `AgentEvent`） `size:M` `area:server` `risk:high`
- [x] **2.7** `server`：`GET /v1/chat/ws`（多轮 + per-socket `ChannelApprover` + 帧协议 user/reset/resume/new/approve/deny） `size:L` `area:server` `risk:high`
  - ↳ 验收：turn-in-progress 守卫、未知 approval id 报错、persisted 模式存 `Done.conversation` ✅（其余 Rust 已演进的帧如 fork/hitl/skills 留待后续）
- [x] **2.8** `server`：持久化会话 CRUD（`/v1/conversations*`，503-when-unconfigured、`__` 内部 id 拒绝/隐藏） `size:M` `area:server`
- [~] **2.9** token 估算接入 memory `size:S` `area:memory`（char-ratio + json-aware 估算器已落地并接入；`js-tiktoken` 精确估算器留作后续可插拔精度提升）
- [ ] **2.10** 前端聊天页切 Node + 摘 chat 代理 + 黄金样本对齐 `size:M` `area:web` `risk:high`（待 apps/* 纳入 workspace + 代理层就绪）

---

## P3 — 工具 + MCP `phase:3` `area:tools`

> 目标：18K 行工具按「读→写→exec→条件」批次迁移，每批摘对应代理。

### 批次 A — 只读、always-on

- [ ] **3.1** `echo` / `time.now` / `http.fetch`（GET/POST，body 截断 ~256KiB） `size:S`
- [ ] **3.2** `code.grep`（正则、gitignore-aware；用 `ignore`+`globby` 或直调 ripgrep；max_results+64KiB 预算） `size:M`
- [ ] **3.3** `git.{status,diff,log,show}`（只读、typed schema、arg 校验拒 `-`前缀/null/换行） `size:M` `risk:high`
- [ ] **3.4** `workspace.context` + `project.checks`（只读快照 / 命令建议，零执行） `size:M`
- [ ] **3.5** `plan.update` / `triage.scan_candidates` / `ask.text` / `exit_plan` `size:M`

### 批次 B — 写 + exec（沙箱 + 审批门）

- [ ] **3.6** `sandbox::resolve_under` 等价（拒绝绝对路径 + `..`）+ 测试 `size:M` `risk:high`
- [ ] **3.7** `fs.read` / `fs.list`（always-on） `size:S`
- [ ] **3.8** `fs.write` / `fs.edit`（唯一性校验替换）/ `fs.patch`（多文件 unified diff、原子、拒二进制/重命名） `size:L` `risk:high`
  - ↳ 验收：opt-in + 审批门生效；越界路径拒绝
- [ ] **3.9** `shell.exec`（`sh -c`/`cmd /C`、沙箱 cwd、stdout/stderr 各截 64KiB、超时杀） `size:M` `risk:high`

### 批次 C — MCP 桥

- [ ] **3.10** MCP client（`@modelcontextprotocol/sdk`：connect → list → `RemoteTool` 适配，`<prefix>.<name>`，drop 杀子进程） `size:L` `area:mcp`
- [ ] **3.11** MCP server（`--mcp-serve` stdio 暴露本地 registry；非 object schema 替 `{}`；错误转 `is_error`） `size:M` `area:mcp`

### 批次 D — 条件工具（store 就绪后接入）

- [ ] **3.12** `todo.{list,add,update,delete}`（ungated） `size:S`
- [ ] **3.13** `memory.*` + `learning.memory.*`（写/同步/删审批） `size:L`
- [ ] **3.14** `register_builtins(BuiltinsConfig)` 装配入口 + 选择性注册 `size:M`
  - ↳ 注：`requirement.*` / `doc.*` / `roadmap.import` / `subagent.*` 随对应 store（P4/P5）落地后接入

---

## P4 — Work / Project 域 `phase:4`

> 目标：看板 + 审计时间线 + 自动循环 + workflow，逐组对照写契约测试。

- [ ] **4.1** `project` 值类型 + `ProjectStore` trait + JSON 后端 `size:M` `area:store`
- [ ] **4.2** `requirement` 值类型 + `RequirementStore` + `ActivityStore` `size:M` `area:store`
- [ ] **4.3** `projects` 路由 `size:M` `area:server`
- [ ] **4.4** `requirements` 路由（CRUD + `triage_state` + `depends_on` + 状态变更写 Activity） `size:L` `area:server`
- [ ] **4.5** `approve` / `reject` / `runs` / `review` 端点 `size:M` `area:server`
- [ ] **4.6** `comments` / `labels` 路由 `size:M` `area:server`
- [ ] **4.7** `roadmap.import`（工具 + `/v1/roadmap/import`；幂等 marker、zh-CN 合并、Status 映射） `size:M` `area:tools`
- [ ] **4.8** `auto_mode` tick + 守卫（triage/assignee/depends_on topo/in-flight/retries/Review-Human 跳过） `size:L` `risk:high` `area:server`
- [ ] **4.9** acceptance policy（`Subagent` 自动 Review→Done / `Human` 滞留 / reviewer auto-accept 开关） `size:M` `area:server`
- [ ] **4.10** worktree（`off`/`per_run`/`per_unit`；auto 升级 `off`→`per_run`） `size:M` `area:server`
- [ ] **4.11** `workflow` 值类型 + store + `/v1/workflows*` + `workflow_runtime`（Agent/Pipeline/Phase/Parallel） `size:L` `area:server`
- [ ] **4.12** `/v1/work/{overview,quality}` 聚合（容忍部分 store 缺失） `size:M` `area:server`
- [ ] **4.13** 接入 `requirement.*` 工具（从 3.14 延期项） `size:M` `area:tools`
- [ ] **4.14** Work 相关黄金样本对齐 + 摘代理 `size:M` `risk:high`

---

## P5 — 周边域（可并行分人） `phase:5` `area:server`

- [ ] **5.1** channels：store + `ChannelAdapter` registry + `/v1/channels` CRUD + `/kinds` `size:L`
- [ ] **5.2** channels inbound：WeCom/Feishu/DingTalk callback + **签名校验**（`node:crypto` aes/hmac/sha） `size:L` `risk:high`
- [ ] **5.3** channels OAuth：WeCom-app identity（`/oauth/{start,callback}`） `size:M` `risk:high`
- [ ] **5.4** skills：`SKILL.md` 发现 + 激活选择器 + `/v1/skills*`（reload/lifecycle/archive） `size:L` `area:skill`
- [ ] **5.5** plugins：`plugin.json` + `PluginManager` install/uninstall + `/v1/plugins*` `size:L` `area:plugin`
- [ ] **5.6** market：`/v1/market/{mcp,skills,skills/install}` `size:M`
- [ ] **5.7** learning：skill-usage telemetry + `/v1/learning/*` `size:M` `area:learning`
- [ ] **5.8** automation：`AutomationTask` + `ScheduleSpec` + `/v1/automations*` + runtime `size:M` `area:automation`
- [ ] **5.9** observability：`Eval*`/`Observed*` + `/v1/observability/*` + `/v1/evals/*`（read）+ OTel span `size:L` `area:observability`
- [ ] **5.10** diagnostics：`/v1/diagnostics/*` + worktree orphans 清理 `size:M`
- [ ] **5.11** provider-admin：`/v1/providers*` + provider registry `size:M`
- [ ] **5.12** agent-profiles：`/v1/agent-profiles` `size:S`
- [ ] **5.13** doc-projects：`DocProject` + append-only draft + `/v1/doc-projects*`；接 `doc.*` 工具 `size:M`
- [ ] **5.14** memories（phase-1）+ memory sync routes + `memory.sync*`/`icloud` 工具 `size:M`
- [ ] **5.15** workspace：`/v1/workspace/{list,read,find,diff/*,commit,pr}` + terminal PTY（`node-pty`）+ `/v1/workspaces` registry `size:L`
- [ ] **5.16** permissions：路由 + 五种权限模式规则引擎 `size:M`
- [ ] **5.17** subagents：`SubAgent` trait + registry + 内置（review/claude_code/codex/reader/batch）+ runs ledger + `/v1/subagents*`；接 `subagent.*` 工具 `size:XL` `area:subagents` `risk:high`

---

## P6 — provider / 路由 / 记忆 补全 `phase:6`

- [ ] **6.1** Google Gemini provider（systemInstruction、functionCall/Response、`gem_<i>` id 合成、SSE） `size:L` `area:llm`
- [ ] **6.2** Responses provider（openai-responses：instructions、function_call item、typed streaming） `size:L` `area:llm` `risk:high`
- [ ] **6.3** Codex auth（`auth.json` 解析、401→refresh→retry once、并发合流、原子改写）+ codex provider `size:L` `area:llm` `risk:high`
- [ ] **6.4** `capability_validating` / `fallback` / `profile` provider 包装 `size:M` `area:llm`
- [ ] **6.5** router：`RoutingProvider` + `HeuristicClassifier` + `Tier` + env 装配 `size:M` `area:llm`
- [ ] **6.6** `SummarizingMemory`（三级查找、BLAKE3 指纹、持久层 `__memory__.summary:`、reserve 头距、固定温度） `size:L` `area:memory` `risk:high`
- [ ] **6.7** SQL 后端（`sqlite` 必做；`postgres`/`mysql` 按需）+ `connect()` 分支 `size:L` `area:store`

---

## P7 — apps（组合根 + 客户端） `phase:7`

- [ ] **7.1** `apps/jarvis` 组合根：env 解析 + 装配全部 tools/stores/provider `size:L` `area:cli` `risk:high`
- [ ] **7.2** 系统提示切换（coding vs general）+ 项目上下文加载（AGENTS.md/CLAUDE.md/AGENT.md，8KiB 截断） `size:M`
- [ ] **7.3** 子命令 `serve` / `mcp-serve` / `init` / `login` / `status` / `workspace` `size:L`
- [ ] **7.4** 工具门控 env（`JARVIS_ENABLE_*`）+ 权限模式 env + worktree env `size:M`
- [ ] **7.5** `jarvis-cli`：REPL + `--no-interactive` 管道（单轮 AlwaysDeny）+ 审批门 + slash 命令 + 项目上下文（可选 `ink` TUI） `size:L` `area:cli`
- [ ] **7.6** Electron：主进程内嵌 `server` 包 + `loadFile(dist)` + 窗口 `1280×860` `size:L` `area:desktop`
- [ ] **7.7** Electron：preload bridge + ipc（替 `@tauri-apps/api`）+ 前端 `services/desktop.ts` 适配 `size:M` `area:desktop`
- [ ] **7.8** `electron-builder` 打包（macOS dmg/zip）+ release CI `size:M` `area:desktop`
- [ ] **7.9** Web：base URL 切换 + `types/generated` → `shared-types` + 删 `ts-codegen` `size:M` `area:web`
- [ ] **7.10** iOS：base URL 切换 + `/v1` 契约 smoke test `size:S` `area:ios`

---

## P8 — 收尾与下线 `phase:8`

- [ ] **8.1** 拆全部代理转发，Node 成为独立服务 `size:M` `area:server`
- [ ] **8.2** 下线 Rust 服务 + 归档旧 crate（保留 git 历史） `size:S` `area:infra`
- [ ] **8.3** 性能/压测对照（chat 流式吞吐/延迟、内存占用） `size:M` `risk:high`
- [ ] **8.4** OTel 全链路验证（`jarvis.agent.run` / `gen_ai.tool.call` span） `size:S`
- [ ] **8.5** 重写 `CLAUDE.md` + 文档 + README `size:M` `area:infra`
- [ ] **8.6** 安全基线复核（Electron contextIsolation、沙箱、OAuth、渠道签名） `size:M` `risk:high`

---

## 附：契约测试基线（贯穿 P2–P8）

每条迁移路由的「黄金样本」最少覆盖：

1. 正常响应体逐字段对齐（含字段顺序无关性、可选字段缺省）；
2. SSE：每个 `data:` 是一个合法 `AgentEvent` JSON，序列与 Rust 一致；
3. WS：帧协议往返（user/approve/deny/reset/resume/new）与错误分支；
4. 503-when-unconfigured；`__memory__.` 前缀拒绝/过滤；
5. 审批门：gated 工具在无 approver 时直接执行、有 approver 时按决议。
