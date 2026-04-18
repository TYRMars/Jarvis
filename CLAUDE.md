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
  harness-tools/   # Built-in `Tool` impls: echo, time.now, http.fetch, fs.{read,list,write}
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
(default `0.0.0.0:7001`), `JARVIS_FS_ROOT` (default `.`, sandboxes `fs.*`
tools), `JARVIS_ENABLE_FS_WRITE` (any value opts into `fs.write`),
`RUST_LOG`.

## Architecture

### The harness loop (`harness-core`)

Two entry points, same loop:

- `Agent::run(&mut Conversation) -> Result<RunOutcome>` — blocking. Calls
  `LlmProvider::complete`, appends the assistant message, dispatches tool calls,
  loops until a non-`ToolCalls` finish reason or `max_iterations`.
- `Agent::run_stream(self: Arc<Self>, Conversation) -> AgentStream` — streaming.
  Calls `LlmProvider::complete_stream`, forwards `ContentDelta`s as
  `AgentEvent::Delta`, emits `ToolStart` / `ToolEnd` around each invocation, and
  finishes with exactly one `AgentEvent::Done` (carrying the final `Conversation`)
  or `AgentEvent::Error`. The streaming version takes the conversation by value
  because it lives inside an `async_stream!` block; consumers rebuild state from
  the event stream.

Before the first LLM call, the configured `system_prompt` is prepended to the
conversation iff it has no system message already. Tool errors are **caught and
surfaced as text** (`format!("tool error: {e}")`) on both paths so the model can
recover — preserve that when editing `agent.rs`.

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

### Built-in tools (`harness-tools`)

`register_builtins(&mut ToolRegistry, BuiltinsConfig)` is the one-shot entry point the
binary uses. The individual tools are also pub so callers can register selectively:

- `echo` — returns its `text` arg; useful for smoke-testing the tool loop.
- `time.now` — `{unix, iso}` UTC.
- `http.fetch` — GET/POST with headers/body, response truncated to `http_max_bytes`
  (default 256 KiB). Returns a `HTTP <status>\n<headers>\n\n<body>` string.
- `fs.read` / `fs.list` / `fs.write` — every `fs.*` tool is scoped to a `root`
  supplied at construction. `resolve_under` rejects absolute paths and any
  component equal to `..`. **`fs.write` is not registered by default**; flip
  `BuiltinsConfig::enable_fs_write` (or set `JARVIS_ENABLE_FS_WRITE`).

When adding a new built-in tool, keep tool names namespaced (`<group>.<verb>`) and add
it to the right module under `crates/harness-tools/src/`, then export from `lib.rs` and
add a line to `register_builtins` if it should be on by default.

### LLM providers (`harness-llm`)

`OpenAiProvider` implements `LlmProvider` over `reqwest`. Notable wire-shape details:

- OpenAI requires tool-call `arguments` as a **JSON-encoded string**, not an object.
  Conversion happens in `OaFunctionCallOut::From<ToolCall>` (out) and `parse_tool_call`
  (in, where empty strings become `{}`).
- `finish_reason` defaults: missing reason + non-empty `tool_calls` → `ToolCalls`,
  otherwise `Stop`. Don't change this without checking `Agent::run`'s match arm.
- Configurable `base_url` lets you point at any OpenAI-compatible gateway.
- Streaming uses `reqwest::Response::bytes_stream()` with a manual SSE parser
  (`data: <json>\n\n`, `data: [DONE]` sentinel). `StreamAccumulator` reassembles
  tool-call argument fragments (OpenAI delivers them as string slices that must
  be concatenated in index order) and emits exactly one `LlmChunk::Finish` at
  the end. `StreamAccumulator::finalise` is also called if the connection
  closes without a `finish_reason`.

Add new providers by creating a module under `harness-llm/src/` (or a separate crate),
implementing `LlmProvider`, and re-exporting from `lib.rs`.

### HTTP server (`harness-server`)

`router(AppState)` returns an `axum::Router`; `serve(addr, state)` is the `tokio::net`
+ `axum::serve` one-liner. Handlers live in `routes.rs`. Three transports expose the
same agent:

- `POST /v1/chat/completions` — blocking. Runs the loop to completion, returns
  `{message, iterations, history}`.
- `POST /v1/chat/completions/stream` — SSE. Each event's `data:` payload is a single
  JSON-encoded `AgentEvent`. Axum's `Sse` layer handles framing and keep-alives.
- `GET  /v1/chat/ws` — WebSocket. Multi-turn: client sends
  `{"type":"user","content":"..."}` (or `{"type":"reset"}`), server streams
  `AgentEvent`s per turn as text frames. **Conversation state is kept server-side
  for the life of the socket** — the WS handler captures `AgentEvent::Done.conversation`
  and carries it into the next turn, so clients don't need to resend history.

SSE and WS both call `Agent::run_stream` and just serialise events — keep new transports
on that same path rather than reimplementing the loop.

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
