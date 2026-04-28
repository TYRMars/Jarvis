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
| [cli.md](cli.md) | `harness-cli` — terminal coding-agent front-end | Proposed |
| [web-ui.md](web-ui.md) | Minimal browser UI for the WS protocol | Adopted |
| [codex-provider.md](codex-provider.md) | Codex provider — ChatGPT OAuth + Responses API | Adopted |
| [prompt-caching.md](prompt-caching.md) | Anthropic `cache_control` + OpenAI prefix discipline | Proposed |
| [token-estimation.md](token-estimation.md) | Per-provider tokenisers (replace `chars/4`) | Proposed |
| [client-sdks.md](client-sdks.md) | TypeScript + Python SDKs over HTTP/WS | Proposed |
| [sandboxing.md](sandboxing.md) | OS-level isolation for `shell.exec` | Proposed |
| [aicoding-agent.md](aicoding-agent.md) | Codex / Claude Code style coding-agent workflow | Proposed |
| [aicoding-agent.zh-CN.md](aicoding-agent.zh-CN.md) | Codex / Claude Code 风格 AI Coding 工作流中文版 | Proposed |
| [permission-modes.md](permission-modes.md) | Five permission modes (`ask` / `accept-edits` / `plan` / `auto` / `bypass`) + rule engine | Adopted (backend); Web UI follow-up |

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
