# Architecture

Jarvis is a Rust agent runtime shaped around one design rule:

> **`harness-core` knows nothing about HTTP, providers, storage, or MCP.**
> It only owns the agent loop and the traits everything else implements.
> Every concrete integration lives in a sibling crate that plugs in.

This document gives the big-picture view: how the crates fit together,
how a request flows through the system, and where to extend it.
For day-to-day working rules and subtle gotchas, see `CLAUDE.md`.

## Layering

```
                          ┌────────────────────────────────────┐
  transport / composition │         apps/jarvis (bin)          │
                          └──────────────┬─────────────────────┘
                                         │ wires everything
          ┌──────────────────┬───────────┼───────────┬──────────────────┐
          ▼                  ▼           ▼           ▼                  ▼
   ┌────────────┐   ┌────────────┐  ┌────────┐  ┌────────────┐   ┌────────────┐
   │harness-    │   │harness-    │  │harness-│  │harness-    │   │harness-    │
   │server      │   │llm         │  │tools   │  │mcp         │   │store       │
   │(axum HTTP) │   │(OpenAI)    │  │(echo,  │  │(rmcp       │   │(sqlx       │
   │            │   │            │  │ fs,…)  │  │ client +   │   │ SQLite /   │
   │            │   │            │  │        │  │ server)    │   │ PG / MySQL)│
   └─────┬──────┘   └─────┬──────┘  └────┬───┘  └─────┬──────┘   └─────┬──────┘
         │                │              │            │                │
         │      implements LlmProvider   │   implement Tool             │
         │                │              │            │     implements ConversationStore
         └────────────────┴──────┬───────┴────────────┴────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │     harness-core      │
                     │                       │
                     │  Agent (run / stream) │
                     │  Conversation         │
                     │  Message, ToolCall    │
                     │  trait Tool           │
                     │  trait LlmProvider    │
                     │  trait ConversationStore │
                     │  trait ToolRegistry   │
                     └───────────────────────┘
```

Dependency direction is strictly downward: sibling crates depend on
`harness-core`; nothing in `harness-core` depends on them. Adding a new
integration means adding a new crate and wiring it in `apps/jarvis` —
never adding `use harness_server::…` inside `harness-core` or similar.

## Crate responsibilities

| crate             | owns                                                      | depends on                               |
|-------------------|-----------------------------------------------------------|------------------------------------------|
| `harness-core`    | `Agent` run loop, `Conversation`, `Message`, traits       | no sibling crate                         |
| `harness-llm`     | `OpenAiProvider` (implements `LlmProvider`)               | `harness-core`, `reqwest`                |
| `harness-tools`   | Built-in tools (`echo`, `time.now`, `http.fetch`, `fs.*`) | `harness-core`, `reqwest`                |
| `harness-mcp`     | MCP client (adapts remote tools) + server (exposes local) | `harness-core`, `rmcp`                   |
| `harness-server`  | Axum router, `AppState`, `/v1/chat/*` endpoints           | `harness-core`, `axum`                   |
| `harness-store`   | `ConversationStore` impls (sqlx) + `connect(url)`         | `harness-core`, `sqlx`, `chrono`         |
| `apps/jarvis`     | Composition root: env vars, wiring, process lifecycle     | every library crate above                |

## Core abstractions (`harness-core`)

Three traits form the extension surface. Every sibling crate implements
one (or, in `harness-mcp`'s case, bridges tools in both directions).

### `trait Tool`

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value; // JSON Schema (object)
    async fn invoke(&self, args: Value) -> Result<String, BoxError>;
}
```

`ToolRegistry` is a thin `HashMap<String, Arc<dyn Tool>>`. The agent loop
only talks to the registry; every tool (built-in, MCP-remote, user code)
lives behind it.

### `trait LlmProvider`

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse>;
    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream>;
}
```

`complete_stream` has a default implementation that calls `complete` and
emits a single `Finish` chunk — new providers only need the non-streaming
method to start.

### `trait ConversationStore`

```rust
#[async_trait]
pub trait ConversationStore: Send + Sync {
    async fn save(&self, id: &str, c: &Conversation) -> Result<(), BoxError>;
    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError>;
    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}
```

Keyed by an opaque id chosen by the caller (e.g. session UUID). See
`DB.md` for the backends and schema.

## The agent loop

`Agent` has two entry points backed by the same state machine:

- `Agent::run(&mut Conversation) -> Result<RunOutcome>` — blocking.
- `Agent::run_stream(self: Arc<Self>, Conversation) -> AgentStream` —
  streaming; yields `AgentEvent`s.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent::run loop                          │
│                                                                 │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ prepend system prompt (if conversation has none)      │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ LlmProvider::complete / complete_stream               │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ append assistant message → Conversation               │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│                  finish_reason == ToolCalls?                    │
│                   ┌─────────┴─────────┐                         │
│                   │ yes               │ no                      │
│                   ▼                   ▼                         │
│        for each tool_call:        return RunOutcome             │
│         invoke_tool(registry)                                   │
│         append Tool message                                     │
│                   │                                             │
│                   └── back to LlmProvider (next iteration) ──┐  │
│                                                              │  │
│              bounded by AgentConfig::max_iterations ─────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Key invariants (enforced in `agent.rs` — preserve when editing):

- The system prompt is **prepended once**, only if the conversation
  doesn't already have a system message.
- Tool errors are **caught and surfaced as text** (`"tool error: {e}"`)
  so the model can recover on the next turn.
- Streaming emits exactly one terminal event: either `AgentEvent::Done`
  (carrying the final `Conversation`) or `AgentEvent::Error`.

### `AgentEvent` (streaming)

```
Delta { content }                       // token / chunk from the LLM
AssistantMessage { message, finish }    // one complete assistant turn
ToolStart { id, name, arguments }       // bracketing a tool invocation
ToolEnd   { id, name, content }
Done { conversation }                   // terminal success
Error { message }                       // terminal failure
```

## Request lifecycle

All three HTTP transports are thin serialisation layers over
`Agent::run` / `run_stream`. They share `AppState`, never reimplement the
loop.

```
Client                 harness-server                 harness-core
──────                 ──────────────                 ────────────
                       ┌────────────┐
POST /v1/chat/…  ───▶  │ routes.rs  │
                       │            │  build Conversation from body
                       │            │  call Agent::run or run_stream
                       │            │  ┌──────────────────────────┐
                       │            │  │ Agent loop                │──▶ LlmProvider
                       │            │  │                           │──▶ Tools
                       │            │  │                           │    (possibly
                       │            │  │                           │     RemoteTool
                       │            │  │                           │     via MCP)
                       │            │  └──────────────────────────┘
                       │            │  serialise response / stream
◀───  JSON / SSE / WS  │            │
                       └────────────┘
```

| endpoint                              | shape                                    |
|---------------------------------------|------------------------------------------|
| `POST /v1/chat/completions`           | blocking; returns `{message, iterations, history}` |
| `POST /v1/chat/completions/stream`    | SSE; each `data:` is one JSON `AgentEvent` |
| `GET  /v1/chat/ws`                    | WebSocket; multi-turn, server-held state |

The WebSocket handler is the only endpoint that keeps conversation state
across turns: it captures `AgentEvent::Done { conversation }` and carries
it into the next incoming user message. Clients don't resend history.

`AppState` currently holds:

```rust
struct AppState {
    agent: Arc<Agent>,
    store: Option<Arc<dyn ConversationStore>>,  // set if JARVIS_DB_URL
}
```

No handler reads `store` yet — that's where persistence endpoints plug
in next.

## MCP bridge (`harness-mcp`)

`harness-mcp` wires the agent into the Model Context Protocol in both
directions on top of the `rmcp` SDK (stdio transport only, for now):

```
        ┌──────────────────────────────────────────────┐
        │ Jarvis process                               │
        │                                              │
        │    ┌──────────────────────────────────┐     │
        │    │ ToolRegistry                     │     │
        │    │  ├─ built-in tools               │     │
        │    │  └─ RemoteTool (one per remote)  │─────┼──┐
        │    └──────────────────────────────────┘     │  │  remote MCP server
        │                       ▲                     │  │  (child process,
        │                       │ register_into()     │  │   stdio)
        │              ┌────────┴─────────┐           │  │
        │              │ McpClient (rmcp) │──────────────┘
        │              └──────────────────┘           │
        │                                              │
        │    ┌──────────────────────────────────┐     │
        │    │ McpServer (rmcp::ServerHandler)  │──┐  │  another MCP-aware
        │    │   exposes ToolRegistry over stdio│  │  │  agent (calls us)
        │    └──────────────────────────────────┘  │  │
        │                                          └──┼────────────▶
        └──────────────────────────────────────────────┘
```

- **Client** (`client.rs`): `McpClient::connect(&McpClientConfig)` spawns
  a remote MCP server as a child process, handshakes, lists its tools,
  and inserts a `RemoteTool` adapter into the local `ToolRegistry` for
  each one. Names are namespaced as `<prefix>.<tool>` so multiple
  servers don't collide.
- **Server** (`server.rs`): `McpServer::new(Arc<ToolRegistry>)`
  implements `rmcp::ServerHandler` by hand (the `#[tool_router]` macro
  doesn't fit a runtime-known registry). `serve_registry_stdio` is the
  one-liner the `--mcp-serve` binary mode calls.

## Persistence (`harness-store`)

Driver selection is both **compile-time** (cargo features) and
**runtime** (URL scheme picked by `connect(url)`):

| feature    | URL prefixes                    | backend            |
|------------|---------------------------------|--------------------|
| `sqlite`   | `sqlite:`, `sqlite::memory:`    | SQLite (default)   |
| `postgres` | `postgres://`, `postgresql://`  | Postgres           |
| `mysql`    | `mysql://`, `mariadb://`        | MySQL / MariaDB    |

All backends share one table, `conversations(id, messages, created_at,
updated_at)`, where `messages` is the JSON-serialised `Conversation` and
timestamps are RFC-3339 strings. See `DB.md` for details.

## Composition (`apps/jarvis`)

The binary is the only place that reads `std::env`, picks default
models, or decides which tools ship on by default. Library crates must
never call `std::env::var` — put config on their input types and let
`main.rs` populate them.

Startup order:

1. Initialise tracing.
2. Build a `ToolRegistry`; register built-ins via
   `harness_tools::register_builtins`.
3. If `--mcp-serve`: hand the registry to `serve_registry_stdio` and
   return — no LLM or HTTP setup.
4. Otherwise: build an `OpenAiProvider` from `OPENAI_API_KEY` /
   `JARVIS_MODEL` / `OPENAI_BASE_URL`.
5. If `JARVIS_MCP_SERVERS` is set: spawn external MCP servers and merge
   their tools into the registry via `connect_all_mcp`.
6. Construct the `Agent` (provider + registry + system prompt +
   max iterations).
7. If `JARVIS_DB_URL` is set: call `harness_store::connect` and stash
   the store on `AppState`.
8. `serve(addr, state)`.

## Extension points

Each extension point is a trait implementation in a new (or existing)
sibling crate, plus one wiring line in `apps/jarvis`.

### Add a new built-in tool

1. New module in `crates/harness-tools/src/` with a `Tool` impl.
2. Re-export from `crates/harness-tools/src/lib.rs`.
3. (Optional) Register in `register_builtins` if it should be on by
   default. Otherwise let the binary opt in.
4. Keep names namespaced: `<group>.<verb>` (e.g. `fs.read`).

### Add a new LLM provider

1. New module in `crates/harness-llm/src/` (or a brand-new crate).
2. Implement `LlmProvider`. Start with `complete`; add
   `complete_stream` when you need real-time tokens.
3. Re-export from `lib.rs`.
4. Wire it in `apps/jarvis/src/main.rs` — likely behind a new env var
   or CLI flag.

### Add a new `ConversationStore` backend

1. New module in `crates/harness-store/src/` guarded by a cargo
   feature.
2. Follow the `sqlite.rs` pattern: pool wrapper, idempotent `migrate()`,
   `ConversationStore` impl that round-trips JSON + RFC-3339 strings.
3. Declare the feature in `crates/harness-store/Cargo.toml`.
4. Add a match arm in `connect()` in `src/lib.rs`.

### Add a new HTTP transport / endpoint

1. Handler in `crates/harness-server/src/routes.rs`.
2. Mount it in `router(AppState)`.
3. For streaming, call `Agent::run_stream` and serialise `AgentEvent`s —
   don't reimplement the loop.
4. Extend `AppState` rather than threading extra handles through every
   handler.

## Configuration surface

All user-facing configuration is read by `apps/jarvis` and passed as
plain Rust values into the library crates.

| env var                   | default        | purpose                                       |
|---------------------------|----------------|-----------------------------------------------|
| `OPENAI_API_KEY`          | —              | Required (unless `--mcp-serve`)               |
| `JARVIS_MODEL`            | `gpt-4o-mini`  | OpenAI model id                               |
| `OPENAI_BASE_URL`         | OpenAI         | For OpenAI-compatible gateways                |
| `JARVIS_ADDR`             | `0.0.0.0:7001` | Bind address for the HTTP server              |
| `JARVIS_FS_ROOT`          | `.`            | Sandbox root for `fs.*` tools                 |
| `JARVIS_ENABLE_FS_WRITE`  | unset          | Any value opts into `fs.write`                |
| `JARVIS_MCP_SERVERS`      | unset          | `prefix=cmd args, …` — external MCP servers   |
| `JARVIS_DB_URL`           | unset          | `sqlite:…` / `postgres://…` / `mysql://…`     |
| `RUST_LOG`                | `info`         | `tracing_subscriber` filter                   |

CLI flags consumed by the binary:

- `--mcp-serve` — expose the local `ToolRegistry` over MCP stdio instead
  of starting the HTTP server.

## Conventions

- Workspace-only deps: every crate uses `foo.workspace = true`; versions
  live once in the root `Cargo.toml` `[workspace.dependencies]`.
- No `unwrap` in library crates. Return `harness_core::Result` or
  `BoxError`; let the binary decide how to surface failure.
- `clippy --workspace --all-targets -- -D warnings` is the CI gate.
- Streaming is a separate method, not a retrofit on `complete`.
- Tool name collisions are silent — the second registration wins.
  Namespace aggressively.
