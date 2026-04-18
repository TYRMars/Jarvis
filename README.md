# Jarvis

A Rust agent runtime built around a small, well-typed **harness**: a runtime-independent core
(`harness-core`) defines the agent loop, message types, and `Tool` / `LlmProvider` traits;
sibling crates plug in concrete LLM providers and an HTTP transport.

> Status: scaffold. The harness loop, an OpenAI provider, an OpenAI-compatible
> `/v1/chat/completions` endpoint with SSE + WebSocket streaming, an MCP bridge
> (client + server, stdio transport), and a pluggable `ConversationStore`
> (SQLite by default; Postgres / MySQL behind features) are working end to end.
> Short-term memory and additional providers are intentionally not yet
> implemented — see the roadmap below.

## Workspace layout

```
crates/
  harness-core/    # Agent loop, Conversation, Message, Tool / LlmProvider traits
  harness-llm/     # LlmProvider implementations (OpenAI today)
  harness-mcp/     # MCP bridge: adapt external MCP servers as Tools,
                   # expose a local ToolRegistry as an MCP server
  harness-server/  # Axum HTTP facade
  harness-store/   # Pluggable sqlx ConversationStore (sqlite/postgres/mysql)
  harness-tools/   # Built-in tools: echo, time.now, http.fetch, fs.{read,list,write}
apps/
  jarvis/          # Binary that wires the crates together and serves HTTP
```

## Run it

```bash
export OPENAI_API_KEY=sk-...
# optional:
export JARVIS_MODEL=gpt-4o-mini        # default
export OPENAI_BASE_URL=https://...     # for OpenAI-compatible gateways
export JARVIS_ADDR=0.0.0.0:7001        # default
export JARVIS_FS_ROOT=./workspace      # sandbox dir for fs.* tools (default: .)
export JARVIS_ENABLE_FS_WRITE=1        # opt in to fs.write (off by default)
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
export RUST_LOG=info,jarvis=debug

cargo run -p jarvis
```

To run Jarvis itself as an MCP server (exposing built-in tools over stdio so
another MCP-aware agent can call them):

```bash
cargo run -p jarvis -- --mcp-serve
```

Then:

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
# Client sends: {"type":"user","content":"..."}, {"type":"reset"}, or
#              {"type":"resume","id":"sess-1"} (requires JARVIS_DB_URL).
# Server streams the same AgentEvent shape as SSE.
```

### Persisting conversations

When `JARVIS_DB_URL` is set, pass a `conversation_id` to load prior
history and save the result:

```bash
curl localhost:7001/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"conversation_id":"sess-1","messages":[{"role":"user","content":"hi"}]}'

# List / fetch / delete stored conversations
curl localhost:7001/v1/conversations
curl localhost:7001/v1/conversations/sess-1
curl -X DELETE localhost:7001/v1/conversations/sess-1
```

## Development

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p jarvis
```

## Docs

- `ARCHITECTURE.md` — layering, crate responsibilities, agent loop,
  request lifecycle, extension points.
- `DB.md` — `ConversationStore` trait, backends, schema.
- `CLAUDE.md` — working rules and gotchas for contributors (and Claude).

## Roadmap

- `harness-memory` — short-term (in-process) and long-term (DB) memory tiers.
- HTTP endpoints that read/write via `ConversationStore` (the trait and
  SQLite/Postgres/MySQL backends are wired into `AppState`, but no routes
  consume them yet).
- Additional providers: Anthropic, Google.
