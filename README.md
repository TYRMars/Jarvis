# Jarvis

A Rust agent runtime built around a small, well-typed **harness**: a runtime-independent core
(`harness-core`) defines the agent loop, message types, and `Tool` / `LlmProvider` traits;
sibling crates plug in concrete LLM providers and an HTTP transport.

> Status: scaffold. The harness loop, an OpenAI provider, and an OpenAI-compatible
> `/v1/chat/completions` endpoint are working end to end. Memory, MCP, persistence,
> streaming, and additional providers are intentionally not yet implemented — see
> the roadmap below.

## Workspace layout

```
crates/
  harness-core/    # Agent loop, Conversation, Message, Tool / LlmProvider traits
  harness-llm/     # LlmProvider implementations (OpenAI today)
  harness-server/  # Axum HTTP facade
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
export RUST_LOG=info,jarvis=debug

cargo run -p jarvis
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
# Client sends: {"type":"user","content":"..."} or {"type":"reset"}
# Server streams the same AgentEvent shape as SSE.
```

## Development

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p jarvis
```

## Roadmap

- `harness-mcp` — MCP client + server (`rmcp`).
- `harness-memory` — short-term (in-process) and long-term (DB) memory tiers.
- `harness-store` — `sqlx` persistence for agents, conversations, tools.
- Additional providers: Anthropic, Google.
