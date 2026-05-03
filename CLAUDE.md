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
  jarvis/          # HTTP server binary (composition root) — `serve` /
                   # `mcp-serve` / `init` / `login` / `status` / `workspace`
                   # subcommands.
  jarvis-cli/      # Terminal coding-agent. Drives `harness-core::Agent`
                   # in-process; no HTTP server. Reuses harness-llm /
                   # harness-tools verbatim; provider construction is
                   # env-only (no auth-store / config file). Mirrors the
                   # WS handler's three-channel select pattern (stdin /
                   # pending approvals / agent events) over stdout. Both
                   # an interactive REPL and a `--no-interactive` pipe
                   # mode that runs one turn under `AlwaysDeny`.
  jarvis-web/      # React 19 + react-router SPA, built by Vite into `dist/`
                   # which `harness-server` folds into the binary via
                   # `include_dir!`. Served at server root `/`; routes
                   # today are `/` (chat) and `/settings` (full
                   # settings page).

crates/
  harness-core/    # Agent, Conversation, Message, Tool, LlmProvider, Memory, Approver traits + run loop
  harness-llm/     # LlmProvider impls: OpenAI, Anthropic, Google, Codex (ChatGPT OAuth)
  harness-mcp/     # MCP bridge (rmcp): McpClient adapts remote tools into Tool;
                   # McpServer exposes a local ToolRegistry over stdio
  harness-memory/  # Memory impls: SlidingWindowMemory + SummarizingMemory
  harness-server/  # Axum router + `serve(addr, AppState)` helper
  harness-store/   # ConversationStore / ProjectStore / TodoStore;
                   # JSON-file + in-memory by default, SQLite /
                   # Postgres / MySQL behind opt-in cargo features
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
`JARVIS_PROVIDER` (`openai` (default), `openai-responses`, `anthropic`, `google`, `codex`, `kimi`, or `ollama`),
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
`OLLAMA_BASE_URL` (Ollama defaults to `http://localhost:11434/v1`,
the local-server endpoint; only point this somewhere else for a
hosted Ollama proxy), `OLLAMA_API_KEY` (optional — the local
server ignores it; only some hosted proxies need one),
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
`JARVIS_FS_ROOT` (default `.`, sandboxes `fs.*`, `git.*`,
`code.grep`, `workspace.context` tools and the `shell.exec` cwd; the
`--workspace <path>` CLI flag overrides this and is the recommended
form for one-shot invocations),
`JARVIS_ENABLE_FS_WRITE` (any value opts into `fs.write`),
`JARVIS_ENABLE_FS_EDIT` (any value opts into `fs.edit`),
`JARVIS_ENABLE_FS_PATCH` (any value opts into `fs.patch` —
multi-hunk unified-diff apply, atomic per call, approval-gated),
`JARVIS_ENABLE_SHELL_EXEC` (any value opts into `shell.exec`),
`JARVIS_DISABLE_GIT_READ` (any value drops the read-only `git.*`
toolset, which is otherwise on by default),
`JARVIS_NO_PROJECT_CONTEXT` (any value disables auto-loading
`AGENTS.md` / `CLAUDE.md` / `AGENT.md` from the workspace into the
system prompt; defaults to loading them, capped at 32 KiB),
`JARVIS_PROJECT_CONTEXT_BYTES` (override the default 32 KiB cap),
`JARVIS_SHELL_TIMEOUT_MS` (default `30000`, per-call default for `shell.exec`),
`JARVIS_MCP_SERVERS` (comma-separated `prefix=command args...` list of
external MCP servers to spawn and adapt into Tools),
`JARVIS_DB_URL` (optional; opens a `ConversationStore` +
`ProjectStore` + `TodoStore` at startup. Defaults to
`json:///<XDG_DATA_HOME or ~/.local/share>/jarvis/conversations`
when neither this env nor `[persistence].url` is set, so out-of-the-
box deployments are persistent without any config. Scheme picks
backend: `json:` (default, always available) /
`sqlite:` / `postgres://` / `mysql://` (the SQL backends are
opt-in cargo features — build with
`cargo build -p jarvis --features sqlite`),
`JARVIS_DISABLE_TODOS` (any value disables the persistent project
TODO board even when `JARVIS_DB_URL` is set; `todo.*` tools stay
unregistered and `/v1/todos*` returns 503),
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
- `plan.update` — push the agent's working plan into the event
  stream. Input is `{items: [{id, title, status, note?}]}`; status ∈
  `{pending, in_progress, completed, cancelled}`. Each call **replaces
  the whole snapshot** (no diffing on the wire). Emits via the
  `harness_core::plan` task-local channel; the agent loop relays each
  snapshot as `AgentEvent::PlanUpdate { items }`. Always-on, no
  approval — the side effect is purely a typed event, not a
  filesystem / process write. Outside an agent loop the emit is a
  no-op (so the tool's tests can run without standing up the harness).
- `project.checks` — read-only manifest scanner. Returns
  `{suggestions: [{manifest, kind, command, why}]}` with conservative
  recommendations per ecosystem (`Cargo.toml` →
  `cargo check / clippy / test`; `package.json` →
  `npm test / lint / build`; `pyproject.toml` → `pytest / ruff check`;
  `go.mod` → `go test / vet / build ./...`). **Suggests, does not
  execute** — the model still has to call `shell.exec` (which is
  approval-gated) to actually run a command. Always-on.
- `workspace.context` — compact JSON snapshot of the workspace:
  absolute root, VCS state (`branch` / `head` / `dirty` when git is
  present, `vcs: "none"` otherwise), instruction files
  (`AGENTS.md` / `CLAUDE.md` / `README.md` / `CONTRIBUTING.md`),
  package manifests (root + one level deep into `apps/` / `crates/`
  / `packages/` / `services/` / `modules/` / `libs/`), and a
  shallow top-level directory listing. Read-only, always on. The
  intended "first call" before the model picks where to grep or
  edit. No source-file contents — use `fs.read` for those.
- `requirement.list` / `requirement.get` / `requirement.create` /
  `requirement.update` / `requirement.link_conversation` — kanban-row
  CRUD over [`RequirementStore`](crates/harness-core/src/store.rs).
  `list` returns `{items, count, by_status: {backlog,
  in_progress, review, done}}` so the model can answer "what's
  pending?" without re-counting. `update` accepts any subset of
  `{title, description, status}`; pass `description: null` to clear.
  `link_conversation` is idempotent (a second call with the same id
  is a no-op). Read tools are always-on / no-approval; the three
  write tools are approval-gated. Registered only when
  `BuiltinsConfig::requirement_store` is set (same opt-in as
  `todo_store` / `project_store`).
- `roadmap.import` — bootstrap the workspace's roadmap into Work.
  Scans `docs/proposals/`, `docs/roadmap/`, `roadmap/`, or
  `ROADMAP.md` (in that order), parses each file's `**Status:**` /
  `**状态：**` line, and creates / updates one Requirement per
  proposal under a workspace-derived Project (default slug
  `<workspace-basename>-roadmap`, e.g. `jarvis-roadmap`,
  `acme-roadmap`). zh-CN translations are merged into their English
  peer (`foo.md` + `foo.zh-CN.md` → one Requirement with the
  translation linked in `description`); a standalone zh-CN file
  becomes the main entry. Idempotent — a hidden
  `<!-- roadmap-source: <path> -->` marker on the first line of each
  Requirement's `description` lets re-runs skip / update existing
  rows. Status keywords map: `Adopted`/`Done`/`Shipped`/`已落地` →
  `done`; `Adopted partial`/`In progress`/`WIP`/`部分`/`进行中` →
  `in_progress`; `Review`/`Verifying`/`审核` → `review`;
  `Proposed`/`Planned`/`Backlog`/`提议`/`待办` → `backlog`. Returns
  `{project_id, slug, name, source, created, updated, unchanged,
  removed, total, items}`. Off by default; registered only when
  **both** `project_store` and `requirement_store` are set.
  Approval-gated. Optional args: `slug`, `name`, `source_subdir`,
  `prune` (default false — orphan-marker Requirements are kept).
  Manually-added Requirements without the marker are never touched
  by import.
- `fs.patch` — apply a unified diff across one or more files.
  Accepts standard `--- a/<path>` / `+++ b/<path>` headers, with or
  without a `diff --git` preamble. Splits multi-file diffs on the
  preamble (preferred) or on `--- ` / `+++ ` header pairs, parses
  each block via `diffy::Patch::from_str`, applies hunks against
  the sandboxed file with **no fuzz / no whitespace tolerance**,
  and writes only after every block parses + applies cleanly
  (atomic per call). Supports file creation (`--- /dev/null`) and
  deletion (`+++ /dev/null`); refuses binary patches, renames, and
  any path outside the sandbox root. Off by default — flip
  `BuiltinsConfig::enable_fs_patch` (or set
  `JARVIS_ENABLE_FS_PATCH`). Approval-gated.
- `git.status` / `git.diff` / `git.log` / `git.show` — read-only git
  inspection over the host's `git` binary, scoped via `git -C <root>`
  to the tool root. Each subcommand has its own typed schema (no
  free-form `args` array). Arg validators reject anything starting
  with `-` and any null/newline bytes, so the model can't smuggle a
  `--upload-pack=…`-style option through a `revision` or `path`
  field. `git.diff` understands `staged`, `from`/`to` ranges,
  `path`, and `stat_only`; `git.log` takes `limit` (default 20,
  cap 200), `revision`, `path`, and `format=short|full`;
  `git.show` takes `revision` (required), `metadata_only`, and
  `path`. Stdout is truncated at 64 KiB; running `git.status` in a
  non-git directory returns the soft sentinel `(not a git
  repository)` instead of erroring. On by default — flip
  `BuiltinsConfig::enable_git_read = false` (or set
  `JARVIS_DISABLE_GIT_READ`) to skip the whole group, e.g. when
  `git` isn't on `PATH`.
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
and `ui.rs` (the bundled web client at the server root `/`, files in
`apps/jarvis-web/dist/` baked in via `include_dir!`).

**SPA routing.** `ui::router()` mounts `GET /` → `index.html`. The
main router uses `ui::spa_fallback` as its `.fallback(...)` handler
so any extension-less path that doesn't match an explicit API route
serves `index.html` — that's what lets `react-router-dom` own
client-side routes like `/settings` without per-page server entries.
Paths with file extensions still 404 cleanly when the asset is
missing (silent HTML fallback for missing JS would mask deploy
bugs); paths under `/v1/` and `/health` always 404 from the
fallback as defence in depth so SDK clients never accidentally
parse SPA HTML as JSON.

**Workspace inspection** — `GET /v1/workspace`:

Returns `{root, vcs, branch?, head?, dirty?}` for the resolved
workspace root. Same shape as a trimmed `workspace.context` (no
manifest scan). The git probe (`rev-parse --is-inside-work-tree`,
`abbrev-ref HEAD`, `rev-parse --short HEAD`, `status --porcelain`)
runs each call so the answer reflects the current branch / dirty
state. `503 Service Unavailable` when the binary didn't pin a
workspace root via `AppState::with_workspace_root` — the field is
optional on `AppState` so test harnesses don't have to fake one,
but every realistic deployment sets it. Used by the web UI's
chat-header `WorkspaceBadge` and by ops scripts; the `jarvis
workspace [--json]` CLI subcommand prints the same shape locally
without booting a server.

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

**Roadmap → Work bootstrap** — `POST /v1/roadmap/import`:

Scan the workspace for proposal-style markdown
(`docs/proposals/` → `docs/roadmap/` → `roadmap/` → `ROADMAP.md`)
and create / update one Requirement per proposal under a
workspace-derived Project (default slug
`<workspace-basename>-roadmap`). Body is optional and accepts the
same overrides as the [`roadmap.import`](#built-in-tools) tool:
`{ slug?, name?, source_subdir?, prune? }`. Returns the
[`ImportSummary`](crates/harness-requirement/src/roadmap.rs)
shape: `{project_id, slug, name, source, created, updated,
unchanged, removed, total, items, note?}`. Idempotent — re-runs
update only changed Requirements. Returns
`503 Service Unavailable` when any of `ProjectStore`,
`RequirementStore`, or the pinned workspace root isn't configured.

Once imported, the Web UI's `/projects` kanban renders the
roadmap automatically — no UI code change needed. The agent can
also call `roadmap.import` directly from chat to bootstrap any
new workspace.

SSE and WS both call `Agent::run_stream` and just serialise events — keep new transports
on that same path rather than reimplementing the loop.

`AppState` holds `Arc<Agent>` and an optional `Arc<dyn ConversationStore>`
(populated when `JARVIS_DB_URL` is set). When per-request agent
selection or multiple registered models are needed, extend `AppState`
rather than threading a registry through every handler.

### Plan channel (`harness-core::plan`)

Sibling to `harness-core::progress`. Per-tool-invocation
`tokio::task_local` `mpsc::UnboundedSender<Vec<PlanItem>>`, scoped
via `with_plan(...)` from inside the agent loop's tool-dispatch
section. Tools call `plan::emit(items)`; the loop drains the
receiver in step with `progress` (same `tokio::select!` arm
pattern) and yields `AgentEvent::PlanUpdate { items }`. Each emit
carries the **full latest snapshot** — replace, not patch — so a
late-joining transport renders the current plan without replaying
history. Outside an agent invocation the channel is absent and
emits become no-ops, which keeps unit tests on `plan.update` etc.
trivial. The web UI subscribes via `case "plan_update"` in
`apps/jarvis-web/src/services/frames.ts` and renders into the
`PlanList` component in the right rail.

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
`fs.write`, `fs.edit`, `fs.patch`, `shell.exec`. Read-only tools
(`fs.read`, `fs.list`, `code.grep`, `git.{status,diff,log,show}`,
`workspace.context`, `http.fetch`, `time.now`, `echo`) stay ungated.

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

`harness-core::ConversationStore` / `ProjectStore` / `TodoStore`
are the traits; `harness-store` provides the concrete backends.
**JSON-file is the default backend** — out-of-the-box deployments
persist conversations / projects / TODOs to `~/.local/share/jarvis/conversations/`
without any config. SQL backends (SQLite / Postgres / MySQL) are
opt-in cargo features for ops that genuinely need a DB. Driver
selection is both **compile-time** (cargo features) and **runtime**
(URL scheme):

| feature      | URL prefixes                    | backend                      |
|--------------|---------------------------------|------------------------------|
| (always on)  | `json:`, `json://`              | **Default**: JSON files in a directory. Zero extra deps. |
| `sqlite`     | `sqlite:`, `sqlite::memory:`    | SQLite (opt-in: `cargo build -p jarvis --features sqlite`) |
| `postgres`   | `postgres://`, `postgresql://`  | Postgres (opt-in: `--features postgres`) |
| `mysql`      | `mysql://`, `mariadb://`        | MySQL / MariaDB (opt-in: `--features mysql`) |

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

**Workspace selection.** `jarvis serve --workspace <path>` (alias
`--fs-root`) is the highest-priority way to set the sandbox root.
Resolution order: CLI flag > `JARVIS_FS_ROOT` env > `[tools].fs_root`
in config > `.`. The resolved path is logged once at startup
(`workspace root resolved`).

**System-prompt switch.** `serve.rs` picks the agent's system prompt
in this order: `[agent].system_prompt` from config (verbatim
override) > `CODING_SYSTEM_PROMPT` when *coding mode* is active and
`[agent].coding_prompt_auto` is not `false` > `GENERAL_SYSTEM_PROMPT`.
Coding mode is "any of `fs.edit` / `fs.write` / `fs.patch` /
`shell.exec` is enabled" — i.e. the operator deliberately handed
Jarvis the keys to mutate the workspace. The coding prompt mirrors
the contract from `docs/proposals/aicoding-agent.md` (inspect before
editing, prefer small reviewable patches, end with a change report).
Both prompt strings live as `const`s at the top of `serve.rs` so
they're discoverable in one place.

**Project context auto-load.** After the system prompt resolves, the
binary appends the workspace's `AGENTS.md` / `CLAUDE.md` /
`AGENT.md` (in that priority order) via
`harness_tools::workspace::load_instructions(root, max_bytes)`.
Each file is wrapped in a `=== project context: <name> ===` header
so the model can tell injected guidance from its own template.
Combined output is capped at 32 KiB (override:
`JARVIS_PROJECT_CONTEXT_BYTES`); overflow is truncated with a
`[... project context truncated at N bytes ...]` marker. Disable
entirely via `JARVIS_NO_PROJECT_CONTEXT=1` or
`[agent].include_project_context = false`. `jarvis-cli` honours the
same env vars plus a `--no-project-context` CLI flag. Deliberately
**not** in the load list: `README.md`, `CONTRIBUTING.md` — those
are usually marketing / human-PR docs, not agent guidance.

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
