# Jarvis

A Rust agent runtime built around a small, well-typed **harness**: a runtime-independent core
(`harness-core`) defines the agent loop, message types, and `Tool` / `LlmProvider` traits;
sibling crates plug in concrete LLM providers and an HTTP transport.

> Status: usable as a coding-agent runtime. The harness loop, an OpenAI
> provider, an OpenAI-compatible `/v1/chat/completions` endpoint with
> SSE + WebSocket streaming, an MCP bridge (client + server, stdio
> transport), a pluggable `ConversationStore` (SQLite by default;
> Postgres / MySQL behind features), short-term sliding-window memory,
> and a built-in toolset (read / list / edit / write files, regex code
> search, sandboxed shell exec, HTTP fetch) are working end to end.
> Long-term memory and additional LLM providers are still on the
> roadmap.

## Workspace layout

```
crates/
  harness-core/    # Agent loop, Conversation, Message, Tool / LlmProvider / Memory traits
  harness-llm/     # LlmProvider implementations: OpenAI / Anthropic / Google / Codex / Kimi / Ollama
  harness-mcp/     # MCP bridge: adapt external MCP servers as Tools,
                   # expose a local ToolRegistry as an MCP server
  harness-memory/  # Memory: SlidingWindowMemory + SummarizingMemory
  harness-server/  # Axum HTTP facade
  harness-store/   # Pluggable sqlx ConversationStore (sqlite/postgres/mysql)
  harness-tools/   # Built-in tools: echo, time.now, http.fetch,
                   # fs.{read,list,write,edit,patch}, code.grep, shell.exec,
                   # git.{status,diff,log,show}, workspace.context
apps/
  jarvis/          # HTTP server binary — wires the crates together, serves
                   # /v1/chat/* + /ui/, runs as MCP server on stdio
  jarvis-cli/      # Terminal coding-agent — drives the harness in-process,
                   # tty-driven approval, --no-interactive pipe mode
```

## Run it

```bash
# Pick a provider. `openai` is the default; the matching API key env
# var is required (except `codex`, which uses `~/.codex/auth.json`).
#   openai            — Chat Completions API
#   openai-responses  — Responses API with API key (reasoning models, etc.)
#   anthropic         — Messages API
#   google            — Gemini generateContent
#   codex             — Responses API via ChatGPT OAuth (subscription billing)
#   ollama            — local OpenAI-compatible server (default
#                       http://localhost:11434/v1; no API key needed)
export JARVIS_PROVIDER=openai
export OPENAI_API_KEY=sk-...
# export ANTHROPIC_API_KEY=sk-ant-...
# export GOOGLE_API_KEY=...              # GEMINI_API_KEY also accepted
# Codex provider: bills against your ChatGPT Plus / Pro subscription.
# Run `codex login` once (from the OpenAI Codex CLI) to populate
# ~/.codex/auth.json; the harness reads + refreshes it automatically.
# Note: this uses a non-public ChatGPT backend endpoint and is subject
# to OpenAI's ChatGPT Terms of Service — not the public API contract.
# export CODEX_HOME=~/.codex             # default
# export CODEX_ACCESS_TOKEN=eyJ...       # dev backdoor (no refresh)

# optional, per-provider model defaults:
#   openai     gpt-4o-mini
#   anthropic  claude-3-5-sonnet-latest
#   google     gemini-1.5-flash
#   codex      gpt-5-codex-mini
#   ollama     llama3.2
export JARVIS_MODEL=gpt-4o-mini

# optional base-url overrides for compatible gateways or self-hosted
# proxies:
export OPENAI_BASE_URL=https://...
# export ANTHROPIC_BASE_URL=https://...
# export ANTHROPIC_VERSION=2023-06-01    # default
# export GOOGLE_BASE_URL=https://...
# export CODEX_BASE_URL=https://chatgpt.com/backend-api  # default
# export OLLAMA_BASE_URL=http://localhost:11434/v1       # default
# export OLLAMA_API_KEY=...              # only needed for hosted Ollama proxies
export JARVIS_ADDR=0.0.0.0:7001        # default
export JARVIS_FS_ROOT=./workspace      # sandbox for fs.* + shell.exec cwd (default: .)
export JARVIS_ENABLE_FS_WRITE=1        # opt in to fs.write (off by default)
export JARVIS_ENABLE_FS_EDIT=1         # opt in to fs.edit  (off by default)
export JARVIS_ENABLE_FS_PATCH=1        # opt in to fs.patch (multi-hunk unified-diff apply, atomic, approval-gated)
export JARVIS_ENABLE_SHELL_EXEC=1      # opt in to shell.exec (off by default)
export JARVIS_SHELL_TIMEOUT_MS=30000   # default per-call shell.exec timeout
# read-only `git.*` tools (status / diff / log / show) are on by default;
# unset to disable when `git` isn't on PATH or you want a smaller toolset.
# export JARVIS_DISABLE_GIT_READ=1
# `workspace.context` (compact JSON snapshot: branch, manifests,
# instruction files, top-level dirs) is always on — read-only.
# optional: spawn external MCP servers and adopt their tools. Format:
#   prefix=command arg1 arg2, next_prefix=other_cmd ...
export JARVIS_MCP_SERVERS='fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git'
# optional: persist conversations. Scheme selects the backend
# (sqlite default; postgres / mysql behind cargo features).
#   sqlite::memory:            — ephemeral, test-only
#   sqlite://./jarvis.db       — file-backed
#   postgres://user:pw@host/db — requires `--features postgres` on harness-store
#   mysql://user:pw@host/db    — requires `--features mysql` on harness-store
export JARVIS_DB_URL=sqlite://./jarvis.db
# optional: install a memory backend. JARVIS_MEMORY_TOKENS is a heuristic
# token budget (~chars/4); when exceeded, older turns are evicted before
# each LLM call. Tool-call exchanges are kept atomic and the most recent
# turn is always preserved. JARVIS_MEMORY_MODE picks the strategy:
#   window  (default) — hard-drop oldest turns
#   summary           — call the LLM to summarise dropped turns, inject
#                       the summary as a synthetic system message
export JARVIS_MEMORY_TOKENS=8000
export JARVIS_MEMORY_MODE=summary
export JARVIS_MEMORY_MODEL=gpt-4o-mini    # optional, defaults to JARVIS_MODEL
# optional: gate every "sensitive" tool (fs.write / fs.edit / shell.exec)
# through an approver. `auto` always approves (a no-op shim — useful as
# an audit hook in streaming mode); `deny` always rejects. Per-call
# interactive approval over WS/SSE is the next increment.
export JARVIS_APPROVAL_MODE=auto
export RUST_LOG=info,jarvis=debug

cargo run -p jarvis
```

To point Jarvis at a specific repository without exporting `JARVIS_FS_ROOT`:

```bash
cargo run -p jarvis -- serve --workspace /path/to/repo
# alias: --fs-root, same effect
```

`--workspace` overrides `JARVIS_FS_ROOT` and `[tools].fs_root` from
config; the resolved path is printed at startup as
`workspace root resolved`. When any mutation tool
(`fs.edit` / `fs.write` / `fs.patch` / `shell.exec`) is enabled,
the agent automatically switches to a coding-agent system prompt
that tells it to inspect via `workspace.context` + `git.status`
before editing, prefer small reviewable patches, and end with a
change report. The workspace's `AGENTS.md` / `CLAUDE.md` / `AGENT.md`
(if present) are auto-appended to the prompt, capped at 32 KiB.
Override the prompt with `[agent].system_prompt = "..."` in
`config.toml`, disable the auto-switch with
`[agent].coding_prompt_auto = false`, or skip the project-context
load via `JARVIS_NO_PROJECT_CONTEXT=1`.

For an end-to-end coding-agent walkthrough (plan, patch, check,
review, with the actual JSON the model emits at each step), see
[`docs/user-guide-coding-agent.md`](docs/user-guide-coding-agent.md).

### Terminal front-end

Don't want a browser? `jarvis-cli` is a sibling binary that runs the
harness in-process and gives you a Claude-Code-shaped REPL on stdin /
stdout, with tty-driven approval (`y` / `n` / `a`lways / `d`eny-always)
and a `--no-interactive` pipe mode for shell pipelines and CI:

```bash
export OPENAI_API_KEY=sk-...
cargo run -q -p jarvis-cli                                # interactive REPL
echo "summarise the README" | cargo run -q -p jarvis-cli -- --no-interactive
```

See [`docs/user-guide-cli.md`](docs/user-guide-cli.md) for the full
arg reference, slash commands, and CI usage.

To run Jarvis itself as an MCP server (exposing built-in tools over stdio so
another MCP-aware agent can call them):

```bash
cargo run -p jarvis -- --mcp-serve
```

Then:

The bundled web UI lives at the server root once it's up:

```
open http://localhost:7001/
```

The UI is a React 19 + react-router SPA with two routes today: `/`
(the chat workspace) and `/settings` (theme / API origin override /
read-only workspace + provider inspection / docs links). Reach
Settings from the account chip in the sidebar footer.

It speaks the same WS / REST surface documented below — handy for
manual testing of streaming, persistence, and interactive approval.
Source: `apps/jarvis-web/` (vanilla HTML/CSS/JS, bundled into the
binary at compile time via `include_dir!`).

```bash
# Liveness
curl localhost:7001/health

# Blocking: returns final message + full history when the agent loop finishes.
curl localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi via the echo tool."}]}'

# SSE: each event is a JSON-encoded AgentEvent (delta / tool_start / tool_end /
# assistant_message / done / error).
curl -N localhost:7001/v1/chat/completions/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Count to three slowly."}]}'

# WebSocket at ws://localhost:7001/v1/chat/ws, multi-turn.
# Client sends:
#   {"type":"user","content":"..."}
#   {"type":"reset"}
#   {"type":"resume","id":"..."}    # persisted mode (requires JARVIS_DB_URL)
#   {"type":"new","id":"<optional>"}  # persisted mode
#   {"type":"approve","tool_call_id":"..."}
#   {"type":"deny","tool_call_id":"...","reason":"optional reason"}
# Server streams the same AgentEvent shape as SSE; in persisted mode
# the conversation auto-saves after every turn. When a tool needs
# approval, the server emits an `approval_request` event and waits for
# the matching `approve` / `deny` frame before invoking the tool.
```

### Persisted conversations

These routes require `JARVIS_DB_URL` to be set; otherwise they return
`503 Service Unavailable`.

```bash
# Create a fresh conversation (server allocates the id; pass {"id":"..."}
# yourself for idempotent clients, and {"system":"..."} to seed the prompt).
curl -X POST localhost:7001/v1/conversations \
  -H 'content-type: application/json' \
  -d '{"system":"you are jarvis"}'
# → {"id":"7b6f..."}

# Append a user turn and run the agent loop, persisting the result.
curl -X POST localhost:7001/v1/conversations/7b6f.../messages \
  -H 'content-type: application/json' \
  -d '{"content":"summarise the README"}'

# Streaming variant (SSE):
curl -N -X POST localhost:7001/v1/conversations/7b6f.../messages/stream \
  -H 'content-type: application/json' \
  -d '{"content":"keep going"}'

# Listing / fetching / deleting:
curl localhost:7001/v1/conversations?limit=10
curl localhost:7001/v1/conversations/7b6f...
curl -X DELETE localhost:7001/v1/conversations/7b6f...
```

## Development

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p jarvis
```

## Docs

- `docs/user-guide.md` — user manual: install, configure, run, the
  HTTP/WS API, tools, memory, persistence, troubleshooting.
- `ARCHITECTURE.md` — layering, crate responsibilities, agent loop,
  request lifecycle, extension points.
- `DB.md` — `ConversationStore` trait, backends, schema.
- `CLAUDE.md` — working rules and gotchas for contributors (and Claude).
- `docs/proposals/` — forward-looking design notes (CLI front-end, web
  UI, prompt caching, token estimation, client SDKs, shell sandboxing,
  Codex provider).

## Roadmap

- ~~`harness-memory` short-term (in-process) memory.~~ Done —
  `SlidingWindowMemory` with turn-grouped sliding window + heuristic
  token estimator; opt-in via `JARVIS_MEMORY_TOKENS`.
- ~~`harness-memory` LLM-backed summarisation.~~ Done —
  `SummarizingMemory` summarises evicted turns instead of hard-dropping
  them, with a three-tier lookup (in-memory slot → optional persistent
  store → LLM) keyed by a stable BLAKE3 fingerprint. Switch on with
  `JARVIS_MEMORY_MODE=summary`; combine with `JARVIS_DB_URL` for
  cross-restart persistence.
- ~~HTTP endpoints that read/write via `ConversationStore`.~~ Done —
  `POST/GET/DELETE /v1/conversations[/:id]`,
  `POST /v1/conversations/:id/messages[/stream]`, plus WS
  `{"type":"resume","id":...}` / `{"type":"new","id":...}` with
  per-turn auto-save.
- ~~Approval hook in `AgentConfig`.~~ Done — `Approver` trait,
  `Tool::requires_approval()` (true on `fs.write` / `fs.edit` /
  `shell.exec`), and streaming `AgentEvent::ApprovalRequest` /
  `ApprovalDecision`. `AlwaysApprove` / `AlwaysDeny` ship in
  harness-core; `ChannelApprover` is the transport-agnostic building
  block. `JARVIS_APPROVAL_MODE` exposes a coarse policy.
- ~~Interactive WS approval.~~ Done — each WS socket gets a
  per-connection `ChannelApprover`; the handler drains pending
  requests via `tokio::select!` and routes `{"type":"approve"|"deny",
  "tool_call_id":...}` client frames back to the matching
  `oneshot::Sender`. SSE doesn't currently expose this (it's
  one-direction by nature); use WS for interactive policy.
- ~~Additional providers: Anthropic, Google.~~ Done — Anthropic full
  (complete + streaming + tool use). Google complete + streaming + tool
  use, streaming via `streamGenerateContent?alt=sse`. Switch with
  `JARVIS_PROVIDER`.
