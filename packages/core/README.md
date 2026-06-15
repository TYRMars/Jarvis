# @jarvis/core

Runtime-independent agent harness — the TypeScript port of the Rust
`harness-core` crate. This is the leaf everything else in the Node rewrite
builds on. **Zero runtime dependencies** (not even a test framework).

Part of the [Node.js rewrite](../../docs/proposals/nodejs-rewrite.zh-CN.md);
this is **Phase 1 (P1)** of the
[task list](../../docs/proposals/nodejs-rewrite-tasklist.zh-CN.md).

## What's here

| Module | Ports (Rust) | Surface |
|---|---|---|
| `json.ts` | — | `JsonValue` |
| `error.ts` | `error.rs` | `HarnessError` + `ProviderError` / `MemoryError` / `MaxIterationsError` / …, `errorText` |
| `message.ts` | `message.rs` | `Message` (externally-tagged by `role`), `ToolCall`, `CacheHint`, constructors |
| `conversation.ts` | `conversation.rs` | `Conversation`, `lastAssistantText` |
| `llm.ts` | `llm.rs` | `LlmProvider`, `ChatRequest`/`ChatResponse`, `FinishReason`, `Usage` (`addUsage`), `LlmChunk`, `defaultCompleteStream` |
| `tool.ts` | `tool.rs` | `Tool`, `ToolCategory`, `ToolRegistry`, `ToolSpec` |
| `approval.ts` | `approval.rs` | `Approver`, `AlwaysApprove`/`AlwaysDeny`/`ChannelApprover`, `ApprovalDecision` |
| `plan.ts` / `progress.ts` | `plan.rs` / `progress.rs` | per-invocation channels via `AsyncLocalStorage` (replaces tokio `task_local`) |
| `memory.ts` | `memory.rs` (trait only) | `Memory` |
| `agent.ts` | `agent.rs` (load-bearing subset) | `Agent.run` / `Agent.runWithUsage` / `Agent.runStream`, `AgentEvent`, `RunOutcome`, `AgentConfig` |

### Invariants locked by tests

- System prompt prepended/refreshed per `ensureSystemPrompt` semantics.
- Tool errors and tool-not-found surface as text (`tool error: …`); a deny
  surfaces `tool denied: …`. Neither aborts the loop.
- `run()` throws `MaxIterationsError` when the loop never terminates.
- `runStream()` yields **exactly one** terminal `done` (carrying the full
  `Conversation`) or `error`, nothing after it; `approval_request` is emitted
  **before** the approver is awaited; `tool_start`/`tool_end` always pair
  (even on deny); plan/progress emitted during `invoke` stream live, between
  `tool_start` and `tool_end`.
- No approver configured → gated tools run unconditionally (historical default).

## Deferred to later phases

Parallel tool dispatch, `tool_filter` (Plan Mode), session-workspace scoping,
HITL (`ask.text`), memory-compaction / subagent / provider-fallback / mode
events, and Responses-API chaining are intentionally **not** ported yet — see
the task list. The data model keeps the chaining fields so they round-trip.

## Test

Tests use Node's built-in runner with native TypeScript type-stripping — **no
install required** (needs Node ≥ 22.6):

```bash
node --experimental-strip-types --test src/model.test.ts src/agent.test.ts
# or
pnpm test
```

> The broader monorepo standardises on vitest (matching `apps/jarvis-web`).
> `core` deliberately stays dependency-free and uses `node:test`; packages that
> need DOM/mocking use vitest. Source is written in erasable-syntax TS (no
> enums / namespaces / parameter properties) so it runs under type-stripping
> and type-checks with `erasableSyntaxOnly`.
