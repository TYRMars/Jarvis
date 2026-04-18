# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jarvis is a Rust agent runtime organised as a Cargo **workspace** around a small, runtime-
independent harness. The repository was rewritten from a TypeScript Egg.js + tegg
implementation; do not assume any prior TS conventions or files apply — they were deleted
in the rewrite.

The single design rule: **`harness-core` knows nothing about HTTP, providers, storage, or
MCP.** It only owns the agent loop and the traits everything else implements. Sibling
crates plug in.

## Workspace layout

```
crates/
  harness-core/    # Agent, Conversation, Message, Tool, LlmProvider traits + run loop
  harness-llm/     # LlmProvider impls; today: OpenAI (`OpenAiProvider`)
  harness-server/  # Axum router + `serve(addr, AppState)` helper
apps/
  jarvis/          # Binary that wires everything and exposes the HTTP API
```

`Cargo.toml` at the root is a workspace manifest with shared `[workspace.dependencies]`;
member crates always reference deps as `foo.workspace = true`. New crates go under
`crates/` (libraries) or `apps/` (binaries) and must be added to `members` in the root
`Cargo.toml`.

## Commands

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings   # CI gate
cargo test --workspace
cargo test -p harness-core message::                    # filter by path
cargo run -p jarvis                                     # needs OPENAI_API_KEY
cargo build --release -p jarvis
```

Env vars consumed by the `jarvis` binary: `OPENAI_API_KEY` (required),
`JARVIS_MODEL` (default `gpt-4o-mini`), `OPENAI_BASE_URL`, `JARVIS_ADDR`
(default `0.0.0.0:7001`), `RUST_LOG`.

## Architecture

### The harness loop (`harness-core`)

`Agent::run(&mut Conversation)` is the entire runtime:

1. Prepend the configured system prompt if the conversation has none.
2. Loop up to `max_iterations`:
   - Build a `ChatRequest` from the conversation + tool specs and call `LlmProvider::complete`.
   - Append the returned assistant message to the conversation.
   - If `finish_reason == ToolCalls`, invoke each tool via `ToolRegistry`, append a
     `Message::Tool` for each result, and continue.
   - Any other finish reason returns `RunOutcome::{Stopped, LengthLimited}`.
3. Hitting the iteration cap returns `Error::MaxIterations`.

Tool errors are **caught and surfaced as text** in the tool result message
(`format!("tool error: {e}")`) so the model can recover, rather than aborting the loop.
Preserve that behaviour when editing `agent.rs`.

### Message model (`message.rs`)

`Message` is an externally-tagged enum (`role` discriminator) deliberately shaped like
the OpenAI chat-completions wire format so providers can map both directions losslessly.
Tool arguments are stored as `serde_json::Value` (already parsed); the OpenAI provider
serialises them back to the JSON-string form OpenAI expects in `OaFunctionCallOut`.

### Tools (`tool.rs`)

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value; // JSON schema
    async fn invoke(&self, args: Value) -> Result<String, BoxError>;
}
```

`BoxError` is re-exported from `harness-core` so tool implementors don't need `anyhow`.
`ToolRegistry` is a thin `HashMap<String, Arc<dyn Tool>>` and is the only thing the agent
loop talks to — `register` inserts by `Tool::name()`, so two tools with the same name
silently overwrite each other.

### LLM providers (`harness-llm`)

`OpenAiProvider` implements `LlmProvider` over `reqwest`. Notable wire-shape details:

- OpenAI requires tool-call `arguments` as a **JSON-encoded string**, not an object.
  Conversion happens in `OaFunctionCallOut::From<ToolCall>` (out) and
  `OpenAiResponse::into_chat_response` (in, where empty strings become `{}`).
- `finish_reason` defaults: missing reason + non-empty `tool_calls` → `ToolCalls`,
  otherwise `Stop`. Don't change this without checking `Agent::run`'s match arm.
- Configurable `base_url` lets you point at any OpenAI-compatible gateway.

Add new providers by creating a module under `harness-llm/src/` (or a separate crate),
implementing `LlmProvider`, and re-exporting from `lib.rs`.

### HTTP server (`harness-server`)

`router(AppState)` returns an `axum::Router`; `serve(addr, state)` is the `tokio::net`
+ `axum::serve` one-liner. Handlers live in `routes.rs`. The `/v1/chat/completions`
handler intentionally does **not** stream — it runs the agent loop to completion and
returns `{message, iterations, history}`. Streaming is on the roadmap.

`AppState` currently holds a single `Arc<Agent>`. When per-request agent selection or
multiple registered models are needed, extend `AppState` rather than threading a
registry through every handler.

### Binary (`apps/jarvis`)

`apps/jarvis/src/main.rs` is the only place that knows about env vars, default models,
or which tools are wired in. Treat it as the composition root — the library crates must
not read `std::env`. New tools, providers, or middlewares get registered here.

## Conventions

- **Workspace deps only.** Every crate dep should be `foo.workspace = true`. Add the
  version once in the root `Cargo.toml` `[workspace.dependencies]`.
- **No `unwrap` in library crates.** Return `harness_core::Result` (or `BoxError` from
  tools) and let the binary decide how to surface failure. `apps/jarvis` may use
  `anyhow` freely.
- **Errors:** library code uses `thiserror`-derived `Error` in `harness-core`; provider
  errors get wrapped in `Error::Provider(String)` rather than leaking `reqwest::Error`.
- **Clippy is the gate.** `cargo clippy --workspace --all-targets -- -D warnings` must
  pass; the existing code is clean against it.
- **No streaming yet.** If you add it, do it as a parallel method on `LlmProvider`
  (e.g. `complete_stream`) rather than retrofitting `complete`'s return type.
- **Tool naming collisions** are silent — if you register two tools with the same
  `name()`, the second wins. Prefer unique, namespaced names (`fs.read`, `http.fetch`).
