# Proposals

Forward-looking design notes. Each file is a concrete, scoped plan
that can be picked up as a separate PR — none of them are committed
work yet. They share the project's conventions: be honest about
trade-offs, prefer minimum-viable shapes over hypothetical
generality, and call out the integration points (which crates change,
what trait surfaces are touched).

Status legend in each doc's header:

- **Proposed** — written but not started.
- **In progress** — work has begun on a branch.
- **Adopted** — merged; the doc stays as historical record.
- **Superseded** — a later proposal replaced this one.

| Doc | Topic | Status |
|---|---|---|
| [onboarding.md](onboarding.md) | Pre-built binary, `jarvis init` / `login`, config file, OAuth ownership | Adopted — init/login/logout/status + config + per-provider auth store + multi-target release CI; install.sh / Homebrew tap still pending |
| [cli.md](cli.md) | `harness-cli` — terminal Chat / Work client with Coding as a capability | Adopted partial — REPL + `--no-interactive` pipe + approval gate + slash commands + project context; Work subcommands / TUI / Windows pending |
| [web-ui.md](web-ui.md) | Minimal browser UI for the WS protocol | Adopted |
| [codex-provider.md](codex-provider.md) | Codex provider — ChatGPT OAuth + Responses API | Adopted |
| [prompt-caching.md](prompt-caching.md) | Anthropic `cache_control` + OpenAI prefix discipline | Adopted — Anthropic `cache_control` block tagging + OpenAI `prompt_cache_key` + deterministic tool sort |
| [token-estimation.md](token-estimation.md) | Per-provider tokenisers (replace `chars/4`) | Adopted — `TiktokenEstimator` (cl100k/o200k) wired into sliding + summarizing memory |
| [client-sdks.md](client-sdks.md) | TypeScript + Python SDKs over HTTP/WS | Proposed — not started (no `clients/`, no `jarvis-client` crate, no OpenAPI emission) |
| [sandboxing.md](sandboxing.md) | OS-level isolation for `shell.exec` | Adopted (v0) — `Sandbox` enum (bubblewrap / sandbox-exec) + `ShellLimits`; container backend (Docker/Podman) pending |
| [product-design.md](product-design.md) / [zh-CN](product-design.zh-CN.md) | Chat / Work / Doc product design and capability-pack model | Adopted |
| [aicoding-agent.md](aicoding-agent.md) | Coding capability pack and Codex / Claude Code style workflow | Proposed |
| [aicoding-agent.zh-CN.md](aicoding-agent.zh-CN.md) | Coding 基础能力与 Codex / Claude Code 风格工作流 | Proposed |
| [persistent-todos.md](persistent-todos.md) | Persistent TODO board as the lightweight Work backlog | Adopted |
| [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md) | 云端能力包、端云协同与多云厂商适配 | Proposed |
| [work-orchestration.zh-CN.md](work-orchestration.zh-CN.md) | Work 编排、自动执行、验证门禁、GSD 2 + Multica 参考吸收 | Adopted partial — Phase 0/1/2/3 落地; Multica 启发的 AgentProfile / Activity / Run 持久化是新 Phase 3.5/3.6/3.7 |
| [symphony-inspired-orchestration.zh-CN.md](symphony-inspired-orchestration.zh-CN.md) | 借鉴 Symphony SPEC 的常驻 Work 调度、`WORKFLOW.md` 契约、tracker adapter、per-issue workspace、retry/reconcile | Proposed |
| [cloud-blueprint.zh-CN.md](cloud-blueprint.zh-CN.md) | Cloud / Edge 落地蓝图：看板 10 条 Requirement 的 PR 拆分、验收与依赖图 | In progress — Phase 0/1 文档化 |
| [permission-modes.md](permission-modes.md) | Five permission modes (`ask` / `accept-edits` / `plan` / `auto` / `bypass`) + rule engine | Adopted — backend rule engine **and** Web UI (ModeBadge / PermissionModeChip / ModeChangedToast / PermissionsSection) shipped |
| [new-session-resource-manager.zh-CN.md](new-session-resource-manager.zh-CN.md) | 新建会话资源管理弹框：选择项目/文件夹、自动创建项目、多工作区绑定 | Adopted — `ResourceManagerDialog.tsx` ships project search / folder pick / auto-create / recent workspaces |
| [session-execution-context.zh-CN.md](session-execution-context.zh-CN.md) | 会话执行上下文条：输入区上方展示当前需求、执行状态、验证与详情入口 | In progress — Phase 1 read-only bar + drawer shipped; WS live-update + `/v1/conversations/:id/work-context` aggregation + action buttons pending |
| [tauri-desktop-client.zh-CN.md](tauri-desktop-client.zh-CN.md) | Tauri 桌面端：复用 jarvis-web，Rust 管理 sidecar/server 与系统集成 | Adopted partial — shell + sidecar lifecycle + macOS DMG release; async SessionRunRegistry / tray menu / auto-update / code-signing pending |
| [web-multi-session-runs.zh-CN.md](web-multi-session-runs.zh-CN.md) | Web 多会话并行与异步运行：per-conversation run 状态、后台 run API、sidebar 运行态 | In progress — per-conversation sockets + run-state + surface snapshots (Phase 0–2); global Running panel / notifications / multi-tab dedup pending |
| [self-improving-agent.zh-CN.md](self-improving-agent.zh-CN.md) | 让 Jarvis 具备自我成长闭环：记忆、技能、后台复盘、Curator 与可观测学习日志 | In progress — learning/memory/skill-lifecycle data models + telemetry routes shipped; background Reviewer fork + Curator loop + `skill.manage` tool pending |
| [model-tool-compatibility.zh-CN.md](model-tool-compatibility.zh-CN.md) | 强化 Jarvis 的模型自由切换、OpenAI-compatible provider profiles、工具目录、MCP 管理与并行 SubAgent 执行 | Adopted partial — ProviderProfile catalog + ToolMetadata + `/v1/providers` + `/v1/tools` + MCP routes; dynamic model catalog / capability-pack UI / auto model-routing pending |
| [channel-plugins.md](channel-plugins.md) | Channels as plugins — binding store, ChannelAdapter registry, WeCom/Feishu/DingTalk | In progress — ChannelBinding/Instance stores + ChannelAdapter registry + plugin manifest parsing; adapter spawn/supervise + WS `user.source` + channel token auth + channel SDK pending |
| [project-connectors.zh-CN.md](project-connectors.zh-CN.md) | 项目连接器：接外部 tracker（GitHub/Jira/Linear/Notion）双向同步需求 | Proposed — not started (no `harness-connectors`, no `ProjectConnector` trait; only local `roadmap.import`) |
| [declarative-workflows.zh-CN.md](declarative-workflows.zh-CN.md) | 声明式多步 Agent Workflow（harness-workflow）+ `/v1/workflows` + workflow_runtime | Adopted — WorkflowDefinition/Step/Run + store + routes + runtime (Agent/Pipeline/Phase/Parallel) + Requirement binding |
| [chat-sidebar-project-groups.zh-CN.md](chat-sidebar-project-groups.zh-CN.md) | 侧边栏按项目分组 + 运行态指示 | Adopted — `ConvoList` project grouping + per-group expand + run-status spinner |
| [otel-native-eval-harness.zh-CN.md](otel-native-eval-harness.zh-CN.md) | OTel 原生 trace 埋点 + Eval 评测看板 | In progress — span emission (`jarvis.agent.run` / `gen_ai.tool.call`) + ObservabilityStore + `/v1/observability/*` + `/v1/evals/*` read side; eval suite **runner/grader** + `jarvis eval` CLI pending |
| [subagents.zh-CN.md](subagents.zh-CN.md) | SubAgent 体系（review / claude_code / codex / reader / batch） | Adopted — SubAgent trait + 4 built-ins + batch + recursion guard + reviewer auto-accept |
| [nodejs-migration.zh-CN.md](nodejs-migration.zh-CN.md) | Node.js（Egg.js + tegg）→ Rust 迁移：历史决策、旧功能映射、遗留缺口收尾（知识库/RAG 为 P0） | In progress — 主体迁移已完成（f40ff3d）；knowledge/RAG 收尾未启动 |

## Product Alignment Audit

Current product model: **Chat / Work / Doc** are the only top-level
product surfaces. Coding, office, research, cloud ops, and future
domains are **capability packs** that can appear inside those
surfaces. First audience: **small teams**. First wedge:
**Coding Work** — turning coding conversations into verified work and
lasting documentation.

| Doc | Alignment after review |
|---|---|
| [product-design.md](product-design.md) / [zh-CN](product-design.zh-CN.md) | Source of truth for positioning, product surfaces, capability packs, and the Coding Work wedge. English is primary; Chinese translation must stay in sync. |
| [aicoding-agent.md](aicoding-agent.md) / [aicoding-agent.zh-CN.md](aicoding-agent.zh-CN.md) | Updated: Coding is a cross-product capability pack, not Jarvis's product identity. |
| [cli.md](cli.md) | Updated: terminal Chat / Work client; Coding is the first rich capability use case. |
| [persistent-todos.md](persistent-todos.md) | Updated: TODO board is the already-shipped lightweight Work backlog, with Chat/Doc capture paths. |
| [work-orchestration.zh-CN.md](work-orchestration.zh-CN.md) | Updated: Work is one product surface; TODO is Phase 0; Coding/office/research enter through capability packs. |
| [web-ui.md](web-ui.md) | Updated as historical MVP; future UI follows Chat / Work / Doc navigation. |
| [client-sdks.md](client-sdks.md) | Updated: SDK namespaces should be `chat`, `work`, `doc`, and `capabilities`, not coding-only. |
| [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md) | Updated: cloud is deployment/execution infrastructure for Chat / Work / Doc, not a product surface. |
| [cloud-blueprint.zh-CN.md](cloud-blueprint.zh-CN.md) | In progress: execution blueprint for Phase 0/1; mirrors the 10 kanban requirements with PR breakdown, acceptance criteria, and dependency graph. |
| [onboarding.md](onboarding.md) | Updated: first-run setup should communicate Chat / Work / Doc and initial capability choices. |
| [prompt-caching.md](prompt-caching.md) | Updated: prompt caching is cross-product infrastructure for capability-heavy turns. |
| [permission-modes.md](permission-modes.md) | Already aligned: cross-product safety/policy layer. |
| [sandboxing.md](sandboxing.md) | Already aligned: cross-product execution safety layer. |
| [token-estimation.md](token-estimation.md) | Already aligned: provider/runtime infrastructure for every surface. |
| [codex-provider.md](codex-provider.md) | Already aligned: provider implementation available to all surfaces. |

## Cross-cutting principles

- **Don't fork the harness loop.** Anything new wires through
  `harness-core`'s existing trait surfaces (`Tool`, `LlmProvider`,
  `Memory`, `Approver`, `ConversationStore`). If a proposal needs a
  new trait, that's a flag worth justifying, not an obvious win.
- **Composition root is `apps/jarvis`.** Library crates must not read
  `std::env`. New env vars and config wiring live in the binary.
- **Streaming is first-class.** Don't add features that only work in
  blocking mode; they'll bit-rot the moment a transport switches.
- **Opt-in for anything that mutates the host or costs money.**
  Defaults stay safe. New tools either start opt-in or come with an
  approval-gate story.
- **Keep product surfaces separate from capability packs.** Chat /
  Work / Doc own user-facing state and navigation. Coding, office,
  research, cloud ops, and future domains plug in as capabilities
  through tools, skills, prompts, context builders, and policies.
- **Maintain English primary docs with Chinese translations.** Major
  product and architecture proposals should be authored in English as
  the primary document and include a `*.zh-CN.md` translation in the
  same PR. Each pair should link to the other at the top of the file.
