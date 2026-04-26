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
apps/
  jarvis/          # Composition root binary (HTTP server / MCP serve mode)
  jarvis-web/      # Static HTML/CSS/JS bundled into harness-server via `include_dir!`,
                   # served at `/ui/` — minimal demo / WS protocol smoke test client.

crates/
  harness-core/    # Agent, Conversation, Message, Tool, LlmProvider, Memory, Approver traits + run loop
  harness-llm/     # LlmProvider impls: OpenAI, Anthropic, Google, Codex (ChatGPT OAuth)
  harness-mcp/     # MCP bridge (rmcp): McpClient adapts remote tools into Tool;
                   # McpServer exposes a local ToolRegistry over stdio
  harness-memory/  # Memory impls: SlidingWindowMemory + SummarizingMemory
  harness-server/  # Axum router + `serve(addr, AppState)` helper
  harness-store/   # sqlx-backed ConversationStore; sqlite default,
                   # postgres/mysql behind cargo features
  harness-tools/   # Built-in `Tool` impls: echo, time.now, http.fetch,
                   # fs.{read,list,write,edit}, code.grep, shell.exec
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

Env vars consumed by the `jarvis` binary:
`JARVIS_PROVIDER` (`openai` (default), `openai-responses`, `anthropic`, `google`, `codex`, or `kimi`),
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` /
`KIMI_API_KEY` (required for the matching provider unless
`--mcp-serve` is passed; `GEMINI_API_KEY` is also accepted as an
alias for Google; `MOONSHOT_API_KEY` aliases `KIMI_API_KEY`),
`CODEX_HOME` (default `~/.codex`; `provider=codex` reads
`auth.json` from here), `CODEX_ACCESS_TOKEN` (dev-only escape hatch:
when set, used in place of `auth.json` with no refresh capability;
optional `CODEX_ACCOUNT_ID` for the `ChatGPT-Account-ID` header),
`JARVIS_MODEL` (per-provider default: `gpt-4o-mini` /
`claude-3-5-sonnet-latest` / `gemini-1.5-flash` /
`gpt-5.4-mini` / `kimi-k2-thinking`),
`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `GOOGLE_BASE_URL` /
`CODEX_BASE_URL` / `KIMI_BASE_URL` (Kimi defaults to
`https://api.moonshot.cn/v1` — set to `https://api.moonshot.ai/v1`
for the international tenant),
`ANTHROPIC_VERSION` (defaults to `2023-06-01`),
`CODEX_ORIGINATOR` (defaults to `jarvis`),
`CODEX_RESPONSES_PATH` (defaults to `/codex/responses`),
`CODEX_REASONING_SUMMARY` / `OPENAI_REASONING_SUMMARY`
(`auto` / `concise` / `detailed` — opts the request into the
reasoning block; required for reasoning models),
`CODEX_INCLUDE_ENCRYPTED_REASONING` /
`OPENAI_INCLUDE_ENCRYPTED_REASONING` (any value enables it),
`CODEX_SERVICE_TIER` / `OPENAI_SERVICE_TIER` (`auto` /
`priority` / `flex`),
`CODEX_REFRESH_TOKEN_URL_OVERRIDE` (test-only — points
`auth.openai.com/oauth/token` somewhere else),
`JARVIS_ADDR` (default `0.0.0.0:7001`),
`JARVIS_FS_ROOT` (default `.`, sandboxes `fs.*` tools and the
`shell.exec` cwd),
`JARVIS_ENABLE_FS_WRITE` (any value opts into `fs.write`),
`JARVIS_ENABLE_FS_EDIT` (any value opts into `fs.edit`),
`JARVIS_ENABLE_SHELL_EXEC` (any value opts into `shell.exec`),
`JARVIS_SHELL_TIMEOUT_MS` (default `30000`, per-call default for `shell.exec`),
`JARVIS_MCP_SERVERS` (comma-separated `prefix=command args...` list of
external MCP servers to spawn and adapt into Tools),
`JARVIS_DB_URL` (optional; opens a `ConversationStore` at startup — scheme
picks backend: `sqlite:`, `postgres://`, `mysql://`),
`JARVIS_MEMORY_TOKENS` (optional; when set, installs a memory backend
with that estimated-token budget),
`JARVIS_MEMORY_MODE` (optional, `window` (default) or `summary`),
`JARVIS_MEMORY_MODEL` (optional; model used by `summary` mode, defaults
to `JARVIS_MODEL`),
`JARVIS_APPROVAL_MODE` (optional, `auto` or `deny`; gates every tool
whose `requires_approval()` is true. Without this set, gated tools
still run unconditionally — same as before),
`RUST_LOG`.

Passing `--mcp-serve` runs the binary as an MCP server on stdio,
exposing the local ToolRegistry — no LLM/HTTP setup is performed.

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
- `code.grep` — regex search across the sandbox root. Walks via the
  `ignore` crate so `.gitignore` / `.ignore` / hidden / VCS dirs are
  skipped automatically; binary or non-UTF-8 files are skipped silently.
  Optional `path` (relative subdir, sandboxed) and `glob` (e.g. `*.rs`)
  narrow the scan. Returns `path:line: snippet` triples capped by
  `max_results` and a 64 KiB byte budget; lines longer than 240 chars
  are truncated. Always on (read-only).
- `fs.read` / `fs.list` / `fs.write` / `fs.edit` — every `fs.*` tool is
  scoped to a `root` supplied at construction. The shared
  `sandbox::resolve_under` helper rejects absolute paths and any component
  equal to `..`. `fs.edit` does a uniqueness-checked string replace
  (`old_string` must occur exactly once unless `replace_all = true`); it's
  the preferred primitive for editing existing files because the
  uniqueness gate limits accidental rewrites. Both write primitives are
  **opt-in** — flip `BuiltinsConfig::enable_fs_write` /
  `enable_fs_edit` (or set `JARVIS_ENABLE_FS_WRITE` /
  `JARVIS_ENABLE_FS_EDIT`).
- `shell.exec` — runs `sh -c <command>` (or `cmd /C` on Windows) inside
  the sandbox root. Optional `cwd` is resolved through the same sandbox
  helper; optional `timeout_ms` overrides the configured default.
  stdout/stderr are captured separately and each truncated at 64 KiB.
  Killed with `kill_on_drop` on timeout. **Off by default** — flip
  `BuiltinsConfig::enable_shell_exec` (or set `JARVIS_ENABLE_SHELL_EXEC`)
  and tune the default timeout via `shell_default_timeout_ms` /
  `JARVIS_SHELL_TIMEOUT_MS`.

When adding a new built-in tool, keep tool names namespaced (`<group>.<verb>`) and add
it to the right module under `crates/harness-tools/src/`, then export from `lib.rs` and
add a line to `register_builtins` if it should be on by default. Anything
that writes to disk or runs code on the host should follow the
`fs.write` / `fs.edit` / `shell.exec` precedent and stay opt-in.

### LLM providers (`harness-llm`)

Three `LlmProvider` implementations today, all over `reqwest`. They
share nothing except the trait — the wire shapes diverge enough that
trying to factor out a common transport hurts more than it helps.

**OpenAI** (`OpenAiProvider`):
- Tool-call `arguments` are a **JSON-encoded string**, not an object.
  Conversion happens in `OaFunctionCallOut::From<ToolCall>` (out) and
  `parse_tool_call` (in, where empty strings become `{}`).
- `finish_reason` defaults: missing reason + non-empty `tool_calls` →
  `ToolCalls`, otherwise `Stop`.
- Streaming uses `reqwest::Response::bytes_stream()` with a manual SSE
  parser (`data: <json>\n\n`, `data: [DONE]` sentinel).
  `StreamAccumulator` reassembles tool-call argument fragments
  (delivered as string slices that must be concatenated in index
  order) and emits exactly one `LlmChunk::Finish` at the end.

**Anthropic** (`AnthropicProvider`, `anthropic.rs`):
- System messages are pulled out of `messages` into a top-level
  `system` field (multiple system entries are joined with `\n\n`).
- Tool use is a content block, not a separate message: assistant turns
  carry `[{type:text}, {type:tool_use, id, name, input}]`, and tool
  results travel back as `{type:tool_result, tool_use_id, content}`
  blocks inside a `user` message. `convert_messages` coalesces
  consecutive `Message::Tool` entries into a single user message with
  multiple `tool_result` blocks so Anthropic sees the canonical
  pairing with the assistant's `tool_use` blocks.
- `max_tokens` is **required** by Anthropic; we default to 4096 when
  the caller doesn't supply one.
- Streaming is typed SSE events (`message_start`,
  `content_block_start`, `content_block_delta`, `content_block_stop`,
  `message_delta`, `message_stop`, `ping`, plus a forward-compatible
  `Unknown` sink). Tool-use input arrives as `input_json_delta`
  fragments — concatenated and parsed at `content_block_stop`.
  `stop_reason` lives on `message_delta`; the `Finish` chunk is
  emitted on `message_stop`.
- Default headers: `x-api-key`, `anthropic-version` (default
  `2023-06-01`, override via `ANTHROPIC_VERSION`).

**Google Gemini** (`GoogleProvider`, `google.rs`):
- System prompt goes into top-level `systemInstruction.parts`. Roles
  are `user` / `model` (no `assistant` / `tool`); each message has a
  `parts` array. Tool calls are `functionCall` parts; tool results
  travel back as `functionResponse` parts inside a `user` role
  message.
- Gemini's `functionCall` doesn't carry an id. We synthesise stable
  ids of the form `gem_<index>` so the harness's id-keyed routing
  keeps working, and resolve the matching name from the prior
  assistant message when sending tool results back. Consecutive
  `Message::Tool` entries fold into one user message with multiple
  `functionResponse` parts.
- Tool result content is wrapped as `{ "result": "<text>" }` because
  Gemini expects an object payload.
- Streaming uses `streamGenerateContent?alt=sse`. Without `alt=sse`
  Gemini ships a JSON *array* (not JSONL) which is brittle to parse
  incrementally. Each SSE event is a complete
  `GenerateContentResponse` slice: text parts are deltas (concatenate),
  `functionCall` parts arrive **whole** in one chunk (Gemini does not
  fragment tool-call arguments). The terminal `Finish` is synthesised
  by `StreamAccumulator::finalise` when the body closes — Gemini has
  no in-band sentinel.

**Responses API** (`ResponsesProvider`, `responses.rs` +
`codex_auth.rs`): one wire layer, two pluggable auth strategies,
two convenience constructors:

- `ResponsesProvider::openai_responses(api_key)` →
  `api.openai.com/v1/responses` with a static `sk-...` API key.
  This is the public OpenAI surface — useful for reasoning models
  (`o1`, `o3`, `gpt-5`) and any feature OpenAI ships only on
  Responses rather than Chat Completions.
- `ResponsesProvider::codex(CodexAuth)` →
  `chatgpt.com/backend-api/codex/responses` with a ChatGPT
  subscription OAuth bearer (Codex CLI / Plus / Pro). Billed
  flat-rate against the subscription instead of per-token. The
  endpoint isn't a public OpenAI API and the path has changed
  before — the binary logs an `info!` on startup naming the
  endpoint and "subject to ChatGPT Terms of Service".
- Both flavours are just `ResponsesConfig` presets — the auth
  surface is `ResponsesAuth::ApiKey(...)` vs
  `ResponsesAuth::ChatGptOauth(Arc<Mutex<CodexAuth>>)`. Add new
  flavours (Azure AD, Bedrock, …) by extending the `ResponsesAuth`
  enum.

Wire-shape rules common to both flavours, three load-bearing
differences from `openai.rs`'s Chat Completions:

  - `system` messages are pulled out into a top-level `instructions`
    field (joined with `\n\n` if multiple).
  - Each `Assistant.tool_calls` entry becomes a *separate*
    `{type:"function_call",call_id,name,arguments}` item in the
    top-level `input` array, not embedded inside an assistant
    message. Tool replies likewise become `function_call_output`
    items.
  - Streaming is typed events: `response.output_item.added`,
    `response.output_text.delta`,
    `response.function_call_arguments.delta`,
    `response.output_item.done`, `response.completed`. The
    accumulator emits `ToolCallDelta { id, name }` on
    `output_item.added`, then `arguments_fragment` deltas, then
    finalises the call on `output_item.done`. The terminal
    `LlmChunk::Finish` is synthesised on `response.completed` (or
    on body close).

Optional config knobs surfaced through `ResponsesConfig`:
`store` (default `false` — we own state via `harness-store`),
`service_tier`, `reasoning_summary` (`auto` / `concise` /
`detailed`), `include_encrypted_reasoning` (gates
`include: ["reasoning.encrypted_content"]` for cross-turn cache).

**Auth lives in `codex_auth.rs`** (used by the `ChatGptOauth`
strategy):
  - `CodexAuth::load_from_codex_home(path)` parses
    `<codex_home>/auth.json` (the file Codex CLI writes on `codex
    login`) and pulls `tokens.access_token` /
    `tokens.refresh_token` / `tokens.account_id`.
  - `CodexAuth::from_static(token, account)` is the dev backdoor
    (no refresh).
  - `CodexAuth::refresh(http)` POSTs `grant_type=refresh_token` to
    `auth.openai.com/oauth/token` with the Codex CLI's `client_id`
    (`app_EMoamEEZ73f0CkXaXp7hrann` — we extend the same session,
    not create a new one) and writes the new tokens back to disk
    via write-to-temp + atomic rename. Other fields in `auth.json`
    (`auth_mode`, `OPENAI_API_KEY`, etc.) are preserved.

**401 → refresh → retry once** in both `complete` and
`complete_stream`, regardless of auth flavour. For `ApiKey` the
"refresh" returns an error so the 401 surfaces upstream; for
`ChatGptOauth` it actually rotates and retries. Concurrent requests
coalesce: the lock holder compares the access token against a
snapshot taken before the failed request, and skips a redundant
refresh if another request already rotated it.

Add new providers by creating a module under `harness-llm/src/` (or a
separate crate), implementing `LlmProvider`, and re-exporting from
`lib.rs`. The harness `Conversation` shape is the lingua franca; the
provider module owns the conversion in both directions and **must**
preserve tool-call/tool-result pairing — getting that wrong manifests
as cryptic 400s mid-stream.

### MCP bridge (`harness-mcp`)

Two directions on top of the `rmcp` SDK:

- **Client** (`client.rs`): `McpClient::connect(&McpClientConfig)` spawns an external
  MCP server as a child process over stdio (via `TokioChildProcess`), performs the
  handshake, then `register_into(&mut ToolRegistry)` lists every remote tool and
  inserts a private `RemoteTool` adapter for each. The adapter's `Tool::invoke`
  forwards to `CallToolRequestParams::new(name).with_arguments(obj)` and flattens
  the `Vec<Content>` back into a single string. Remote tools are renamed
  `<prefix>.<name>` so multiple MCP servers don't collide. The `McpClient` owns the
  running child — drop it (or call `shutdown()`) to kill the server.
  `connect_all_mcp(configs, &mut registry)` is the batch helper the binary uses.
- **Server** (`server.rs`): `McpServer::new(Arc<ToolRegistry>)` implements the
  `rmcp::ServerHandler` trait by hand (the `#[tool_router]` macro doesn't fit —
  our tool set is runtime-known, not compile-time). `list_tools` maps
  `ToolSpec` → `rmcp::model::Tool`; `call_tool` resolves the name, invokes the
  harness `Tool`, and wraps the result in a `CallToolResult::success` /
  `::error`. Tool errors are surfaced as an `is_error` result rather than a
  JSON-RPC error so clients can read the error text.
  `serve_registry_stdio(registry)` is the one-liner the `--mcp-serve` mode calls.

When the harness `Tool::parameters` isn't a JSON object (e.g. it returns `true` or
`null`), `list_tools` substitutes an empty object so we always send a valid MCP
`inputSchema`. Keep tool `parameters()` returning object schemas to avoid
surprising MCP clients.

Transport features are pinned via `rmcp` features `server, client, transport-io,
transport-child-process, macros`. If you need HTTP/streamable-http transports,
add the corresponding rmcp feature and drop to `rmcp` directly — the helpers in
this crate only wire stdio.

### HTTP server (`harness-server`)

`router(AppState)` returns an `axum::Router`; `serve(addr, state)` is the `tokio::net`
+ `axum::serve` one-liner. Handlers split across three modules:
`routes.rs` (chat + WS), `conversations.rs` (CRUD + persisted run),
and `ui.rs` (the bundled web client at `/ui/`, files in
`apps/jarvis-web/` baked in via `include_dir!`).

**Ephemeral chat** — no store needed:

- `POST /v1/chat/completions` — blocking. Runs the loop to completion, returns
  `{message, iterations, history}`.
- `POST /v1/chat/completions/stream` — SSE. Each event's `data:` payload is a single
  JSON-encoded `AgentEvent`. Axum's `Sse` layer handles framing and keep-alives.
- `GET  /v1/chat/ws` — WebSocket. Multi-turn:
  - `{"type":"user","content":"..."}` — append + run.
  - `{"type":"reset"}` — clear in-memory conversation; also exits
    persisted mode if active.
  - `{"type":"resume","id":"..."}` — load a stored conversation and
    enter persisted mode (auto-save after every turn). Server replies
    `{"type":"resumed","id":"...","message_count":N}` or an `error` frame.
  - `{"type":"new","id":"<optional>"}` — create a fresh persisted
    session. If `id` is omitted, the server allocates a UUID and replies
    `{"type":"started","id":"..."}`.
  - `{"type":"approve","tool_call_id":"..."}` — approve a previously
    surfaced `ApprovalRequest`. The agent unblocks and runs the tool.
  - `{"type":"deny","tool_call_id":"...","reason":"..."?}` — reject
    the call. The agent emits a synthetic `tool denied: <reason>`
    result back to the model so it can adapt.

  Each socket gets its own `ChannelApprover` wired into a per-socket
  `Agent` (the global agent's config is cloned, the approver is
  swapped). The approver's `mpsc<PendingApproval>` is drained
  inside the WS handler's `tokio::select!` loop, which holds a
  `HashMap<tool_call_id, oneshot::Sender<ApprovalDecision>>` so the
  client's `approve` / `deny` frames find their way back to the
  blocking `approver.approve()` call inside the agent. The agent
  yields `ApprovalRequest` **before** awaiting, so the event reaches
  the client in time for it to actually decide.

  State guards: while a turn is running (`event_rx.is_some()`), the
  server rejects new `user` / `reset` / `resume` / `new` frames with
  `error: turn in progress`. `approve` / `deny` for an unknown
  `tool_call_id` get an `error: no pending approval for ...`.

  In persisted mode the WS captures `AgentEvent::Done.conversation` and
  saves it under the active id. Reset clears both the in-memory state
  and the persisted-mode flag — re-issue `resume` / `new` to restore it.

**Persisted CRUD** (require a configured `ConversationStore`; return
`503 Service Unavailable` when absent so callers can distinguish "not
configured" from "really broken"):

- `POST   /v1/conversations` — body `{"system"?, "id"?}` (both optional, body itself optional).
  Returns `{"id"}` (201). When `system` is set, it's saved as the first message.
- `GET    /v1/conversations?limit=N` — newest-first list of
  `{id, created_at, updated_at, message_count}`.
- `GET    /v1/conversations/:id` — `{"id","messages":[...]}` or 404.
- `DELETE /v1/conversations/:id` — `{"deleted":true|false}` (404 if absent).
- `POST   /v1/conversations/:id/messages` — body `{"content":"..."}`.
  Loads the conversation, appends the user message, runs the agent
  loop, saves, returns `{id, message, iterations, history}`. If the
  post-run save fails the response still goes through — losing the
  reply because we couldn't write to disk would be strictly worse —
  and the failure is logged at WARN.
- `POST   /v1/conversations/:id/messages/stream` — same plumbing, but
  emits SSE `AgentEvent`s; saves on the terminal `Done` event.

SSE and WS both call `Agent::run_stream` and just serialise events — keep new transports
on that same path rather than reimplementing the loop.

`AppState` holds `Arc<Agent>` and an optional `Arc<dyn ConversationStore>`
(populated when `JARVIS_DB_URL` is set). When per-request agent
selection or multiple registered models are needed, extend `AppState`
rather than threading a registry through every handler.

### Short-term memory (`harness-memory`)

`harness_core::Memory` is the trait; concrete impls live in
`harness-memory`. The agent loop calls `memory.compact(&messages)`
inside `Agent::build_request` on every iteration and ships the returned
`Vec<Message>` to the LLM — the canonical `Conversation` is **not**
mutated, so transports that snapshot `AgentEvent::Done.conversation`
keep the full unabridged history. Memory failures bubble up as
`Error::Memory(String)` and surface to clients as `AgentEvent::Error`.

Two impls today, both share the turn-grouping helpers in
`crates/harness-memory/src/turns.rs`:

- `SlidingWindowMemory::new(max_tokens)` — hard-drops oldest turns,
  optionally inserts a `[N earlier turn(s) omitted ...]` system note.
- `SummarizingMemory::new(llm, model, max_tokens)` — same windowing
  rules, but instead of dropping the oldest turns it asks the supplied
  `LlmProvider` to summarise them and inserts the summary as a synthetic
  `System` message between the leading systems and the kept recent turns.
  Three-tier lookup keyed by a **stable BLAKE3 fingerprint** of the
  dropped-prefix slice: in-memory single slot → optional persistent
  store (`with_persistence(Arc<dyn ConversationStore>)`) → LLM. The
  persistent tier writes synthetic `Conversation` rows under the
  reserved key namespace `__memory__.summary:<hash>` so summaries
  survive restarts and parallel workers sharing one DB see each other's
  work. Leaves `SUMMARY_RESERVE_TOKENS` (256) of headroom in the budget
  so the injected summary doesn't push us back over. Store load/save
  failures degrade gracefully (`warn!` and fall through to the LLM /
  return the result anyway) — a flaky DB never breaks compaction.

Token counts are heuristic (`harness_core::estimate_tokens`, ~`chars/4`
plus a fixed per-message overhead) — good enough to budget, not a
tiktoken replacement. Both impls share invariants: a turn starts at a
`User` message and runs through every Assistant + `Tool` reply that
follows until the next `User`, so the compactor never splits an
Assistant tool-call from its `Tool` answers (OpenAI rejects orphaned
tool messages). Leading `System` messages are kept unconditionally; the
most recent turn is always kept even if it alone exceeds the budget.

`apps/jarvis` auto-attaches the conversation store to
`SummarizingMemory` whenever both `JARVIS_MEMORY_MODE=summary` and
`JARVIS_DB_URL` are set — no extra flag. Without `JARVIS_DB_URL` the
in-memory single-slot cache still works; you just lose the
cross-restart benefit.

The `__memory__.` key prefix is the canonical "internal-only"
namespace in the conversation store. The HTTP server filters it out of
`GET /v1/conversations` and refuses GET / DELETE on those ids, plus
rejects `POST /v1/conversations` bodies that try to claim the prefix.
Other backends should respect the same convention if they ever expose
a list-style API.

When adding a new memory backend, put it under
`crates/harness-memory/src/`, implement `Memory`, and re-export from
`lib.rs`. Anything that needs the LLM takes `Arc<dyn LlmProvider>` in
its constructor — the trait stays provider-agnostic. The summariser
must call `complete` with `tools: vec![]` and a pinned `temperature` so
the summary call doesn't accidentally invoke real tools or drift in
output shape.

### Approval gate (`harness-core::approval`)

Every `Tool` advertises a `requires_approval(&self) -> bool` method
(default `false`). When `AgentConfig::with_approver` is set, the agent
loop consults the approver **before** invoking any gated tool:

- `Approve` → tool runs as usual.
- `Deny { reason }` → tool is **not** invoked; the synthetic content
  `"tool denied: <reason>"` is written into a `Message::Tool` so the
  model sees the rejection and can adapt (apologise, ask the user,
  pick another tool, …).
- Approver returns `Err` → treated as a `Deny` with reason
  `"approver failed: <error>"`. Better to keep the loop moving and let
  the model surface the failure than to abort the whole turn.

When **no** approver is configured, gated tools run unconditionally —
that's the historical behaviour and stays the default so existing
deployments don't break.

`Tool::requires_approval` overrides today (all in `harness-tools`):
`fs.write`, `fs.edit`, `shell.exec`. Read-only tools (`fs.read`,
`fs.list`, `code.grep`, `http.fetch`, `time.now`, `echo`) stay
ungated.

Built-in approver implementations:

- `AlwaysApprove`, `AlwaysDeny` — no-op policies; useful as defaults
  and in tests.
- `ChannelApprover` — fan-outs `PendingApproval` (request +
  `oneshot::Sender`) over a `tokio::mpsc` channel. The transport-side
  consumer drains the channel, asks a human / UI / scripted policy,
  and replies through the embedded responder. This is the building
  block for interactive approval over WS/SSE — the receiver loop is
  transport-specific, but the trait stays the same.

Streaming surfaces two new event types around every gated invocation:

- `AgentEvent::ApprovalRequest { id, name, arguments }` — emitted
  before the call.
- `AgentEvent::ApprovalDecision { id, name, decision }` — emitted as
  soon as the approver replies.

`ToolStart` / `ToolEnd` always wrap the call regardless of decision
(deny case writes the `tool denied:` sentinel into `ToolEnd.content`),
so transports that already pair those events don't need new branches.

`apps/jarvis` exposes a coarse policy via `JARVIS_APPROVAL_MODE`
(`auto` or `deny`). The WS transport overrides whatever the global
config says with a per-socket `ChannelApprover` so clients get
genuine per-call control — see the `/v1/chat/ws` section above for
the wire protocol.

### Persistence (`harness-store`)

`harness-core::ConversationStore` is the trait (async `save` / `load` / `list` /
`delete`); `harness-store` provides the concrete backends. Driver selection is
both **compile-time** (cargo features) and **runtime** (URL scheme):

| feature      | URL prefixes                    | backend                      |
|--------------|---------------------------------|------------------------------|
| (always on)  | `json:`, `json://`              | JSON files in a directory — `jarvis init` default |
| `sqlite`     | `sqlite:`, `sqlite::memory:`    | SQLite                       |
| `postgres`   | `postgres://`, `postgresql://`  | Postgres                     |
| `mysql`      | `mysql://`, `mariadb://`        | MySQL / MariaDB              |

`harness_store::connect(url)` returns `Arc<dyn ConversationStore>` — higher
layers don't name the backend. The on-disk shape differs per backend:

- **JSON**: one `<id>.json` file per conversation in a directory.
  Filenames percent-encode any byte not in `[A-Za-z0-9._-]` so internal
  `__memory__.summary:<hash>` keys land safely on Windows. Atomic write
  via `.tmp` + rename. Suited to single-user / dev — `list()` is O(N)
  file reads, not great past a few hundred conversations.
- **SQL backends**: a single `conversations(id, messages, created_at,
  updated_at)` table where `messages` is the JSON-serialised
  `Conversation` and timestamps are RFC-3339 strings, so
  `harness-core` doesn't need a time crate in its public surface.

There's also `MemoryConversationStore` (always compiled) for tests / examples;
it's not selectable via `connect()` by design — wire it up directly.

When adding a new backend, decide whether it's "always on" (no external
service) or feature-gated (needs a server / heavy dep). For "always on"
follow `json_file.rs`: a struct, an atomic save, JSON-serialise the
conversation. For feature-gated, copy `sqlite.rs`: a pool wrapper, an
idempotent `migrate()`, and the same JSON-blob-in-a-row schema. Then
add a match arm to `connect()` in `lib.rs`.

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
- **Streaming lives on its own method.** `LlmProvider::complete_stream` is a
  parallel entry point to `complete`; don't retrofit `complete`'s return type.
  New providers can skip it — the default impl returns a stream that calls
  `complete` and emits a single `Finish` chunk.
- **Tool naming collisions** are silent — if you register two tools with the same
  `name()`, the second wins. Prefer unique, namespaced names (`fs.read`, `http.fetch`).
