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
| [onboarding.md](onboarding.md) | Pre-built binary, `jarvis init` / `login`, config file, OAuth ownership | Proposed |
| [cli.md](cli.md) | `harness-cli` — terminal Chat / Work client with Coding as a capability | Proposed |
| [web-ui.md](web-ui.md) | Minimal browser UI for the WS protocol | Adopted |
| [codex-provider.md](codex-provider.md) | Codex provider — ChatGPT OAuth + Responses API | Adopted |
| [prompt-caching.md](prompt-caching.md) | Anthropic `cache_control` + OpenAI prefix discipline | Proposed |
| [token-estimation.md](token-estimation.md) | Per-provider tokenisers (replace `chars/4`) | Proposed |
| [client-sdks.md](client-sdks.md) | TypeScript + Python SDKs over HTTP/WS | Proposed |
| [sandboxing.md](sandboxing.md) | OS-level isolation for `shell.exec` | Proposed |
| [product-design.md](product-design.md) / [zh-CN](product-design.zh-CN.md) | Chat / Work / Doc product design and capability-pack model | Proposed |
| [aicoding-agent.md](aicoding-agent.md) | Coding capability pack and Codex / Claude Code style workflow | Proposed |
| [aicoding-agent.zh-CN.md](aicoding-agent.zh-CN.md) | Coding 基础能力与 Codex / Claude Code 风格工作流 | Proposed |
| [persistent-todos.md](persistent-todos.md) | Persistent TODO board as the lightweight Work backlog | Adopted |
| [cloud-capabilities.zh-CN.md](cloud-capabilities.zh-CN.md) | 云端能力包、端云协同与多云厂商适配 | Proposed |
| [work-orchestration.zh-CN.md](work-orchestration.zh-CN.md) | Work 编排、自动执行、验证门禁、GSD 2 + Multica 参考吸收 | Adopted partial — Phase 0/1/2/3 落地; Multica 启发的 AgentProfile / Activity / Run 持久化是新 Phase 3.5/3.6/3.7 |
| [cloud-blueprint.zh-CN.md](cloud-blueprint.zh-CN.md) | Cloud / Edge 落地蓝图：看板 10 条 Requirement 的 PR 拆分、验收与依赖图 | In progress — Phase 0/1 文档化 |
| [permission-modes.md](permission-modes.md) | Five permission modes (`ask` / `accept-edits` / `plan` / `auto` / `bypass`) + rule engine | Adopted (backend); Web UI follow-up |
| [new-session-resource-manager.zh-CN.md](new-session-resource-manager.zh-CN.md) | 新建会话资源管理弹框：选择项目/文件夹、自动创建项目、多工作区绑定 | Proposed |
| [session-execution-context.zh-CN.md](session-execution-context.zh-CN.md) | 会话执行上下文条：输入区上方展示当前需求、执行状态、验证与详情入口 | Proposed |

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
