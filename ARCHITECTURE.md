# Architecture

Jarvis is a Node/TypeScript agent runtime shaped around one design rule:

> **`@jarvis/core` knows nothing about HTTP, providers, storage, or MCP.**
> It only owns the agent loop and the interfaces everything else implements.
> Every concrete integration lives in a sibling package that plugs in.

This document gives the big-picture view: how the packages fit together,
how a request flows through the system, and where to extend it.
For day-to-day working rules and subtle gotchas, see `CLAUDE.md`.

The runtime is Node ≥ 22.6 — the TypeScript sources run directly via
`--experimental-strip-types`, with no build step for the server. The package
manager is **pnpm** (one workspace under `packages/*`), and **eslint** is the
lint gate. The web SPA (`apps/jarvis-web`) is a standalone app built by Vite.

## Layering

```
                          ┌────────────────────────────────────┐
  transport / composition │   packages/jarvis-app/src/main.ts  │
                          └──────────────┬─────────────────────┘
                                         │ wires everything
          ┌──────────────────┬───────────┼───────────┬──────────────────┐
          ▼                  ▼           ▼           ▼                  ▼
   ┌────────────┐   ┌────────────┐  ┌────────┐  ┌────────────┐   ┌────────────┐
   │@jarvis/    │   │@jarvis/    │  │@jarvis/│  │@jarvis/    │   │@jarvis/    │
   │server      │   │llm         │  │tools   │  │mcp         │   │store       │
   │(Fastify    │   │(OpenAI,    │  │(echo,  │  │(MCP client │   │(JSON files │
   │ HTTP)      │   │ Anthropic, │  │ fs,…)  │  │ + server)  │   │ default /  │
   │            │   │ Google, …) │  │        │  │            │   │ SQLite …)  │
   └─────┬──────┘   └─────┬──────┘  └────┬───┘  └─────┬──────┘   └─────┬──────┘
         │                │              │            │                │
         │      implements LlmProvider   │   implement Tool             │
         │                │              │            │     implements ConversationStore
         └────────────────┴──────┬───────┴────────────┴────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │     @jarvis/core      │
                     │                       │
                     │  Agent (run / stream) │
                     │  Conversation         │
                     │  Message, ToolCall    │
                     │  interface Tool       │
                     │  interface LlmProvider│
                     │  interface Memory     │
                     │  ToolRegistry         │
                     └───────────────────────┘
```

Dependency direction is strictly downward: sibling packages depend on
`@jarvis/core`; nothing in `@jarvis/core` depends on them. Adding a new
integration means adding a new package and wiring it in
`packages/jarvis-app/src/main.ts` — never adding an `import` of
`@jarvis/server` inside `@jarvis/core` or similar.

## Package responsibilities

Libraries live under `packages/*` and publish as `@jarvis/<name>`; the
applications live under `apps/*`. The table below covers the load-bearing
packages; the rest (`@jarvis/channel`, `@jarvis/project`,
`@jarvis/requirement`-style execution, `@jarvis/workflow`,
`@jarvis/skill`, `@jarvis/subagents`, `@jarvis/plugin`,
`@jarvis/learning`, `@jarvis/automation`, `@jarvis/observability`,
`@jarvis/router`, `@jarvis/connectors`, `@jarvis/agent-profile`,
`@jarvis/todo`, `@jarvis/shared-types`) follow the same rule: depend on
`@jarvis/core` (and each other where noted in `CLAUDE.md`), never the
other way around.

| package            | owns                                                              | depends on                               |
|--------------------|------------------------------------------------------------------|------------------------------------------|
| `@jarvis/core`     | `Agent` run loop, `Conversation`, `Message`, interfaces           | nothing (the leaf)                       |
| `@jarvis/llm`      | `LlmProvider` impls (OpenAI / Anthropic / Google / Responses)     | `@jarvis/core`                           |
| `@jarvis/tools`    | Built-in tools (`echo`, `time.now`, `http.fetch`, `fs.*`, …)      | `@jarvis/core`                           |
| `@jarvis/mcp`      | MCP client (adapts remote tools) + server (exposes local)         | `@jarvis/core`, MCP SDK                  |
| `@jarvis/server`   | Fastify router, `AppState`, `/v1/*` endpoints                     | `@jarvis/core`, Fastify                  |
| `@jarvis/store`    | `ConversationStore` + domain-store impls + `connect(url)`         | `@jarvis/core`, `@jarvis/project`        |
| `@jarvis/memory`   | `Memory` impls (sliding-window + summarizing)                     | `@jarvis/core`                           |
| `@jarvis/router`   | `RoutingProvider` (an `LlmProvider`) — difficulty-tier routing    | `@jarvis/core`                           |
| `@jarvis/shared-types` | Wire-shape types crossing the SPA boundary (source of truth) | nothing                                  |
| `@jarvis/jarvis-app` | Composition root: env vars, wiring, subcommand dispatch         | every library package above              |
| `@jarvis/jarvis-cli` | Terminal coding-agent — drives `Agent` in-process (no HTTP)     | `@jarvis/core`, `@jarvis/llm`, …         |
| `apps/jarvis-web`  | React 19 + react-router SPA, built by Vite into `dist/`           | (standalone app; consumes shared-types)  |
| `apps/jarvis-desktop` | Tauri shell (excluded from default CI)                         | `apps/jarvis-web`                        |

## Core abstractions (`@jarvis/core`)

A small set of TypeScript interfaces forms the extension surface. Every
sibling package implements one (or, in `@jarvis/mcp`'s case, bridges
tools in both directions).

### `interface Tool`

```ts
export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON schema for the `arguments` object passed to `invoke` (object-shaped). */
  readonly parameters: JsonValue;
  invoke(args: JsonValue): Promise<string>;

  readonly requiresApproval?: boolean;          // gate behind a configured Approver (default false)
  readonly category?: ToolCategory;             // "read" | "write" | "exec" | "network"
  readonly isTerminal?: boolean;                // call ends the turn even if more calls were emitted
}
```

`ToolRegistry` is a thin map keyed by `Tool.name`. The agent loop only
talks to the registry; every tool (built-in, MCP-remote, user code) lives
behind it. Same-named registration silently overwrites, so keep names
namespaced (`<group>.<verb>`). The `category` drives Plan-Mode filtering
(only `read` tools reach the model in plan mode) and concurrency defaults.

### `interface LlmProvider`

```ts
export interface LlmProvider {
  complete(req: ChatRequest): Promise<ChatResponse>;
  /** Stream a completion; may return the iterable directly or a Promise of it. */
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> | Promise<AsyncIterable<LlmChunk>>;
}
```

`defaultCompleteStream(provider, req)` and the `LlmProviderBase` class
supply a streaming fallback that calls `complete` and emits a single
synthesised `finish` chunk — new providers only need `complete` to start.
Providers with real streaming implement `completeStream` directly.

### `interface ConversationStore`

```ts
export interface ConversationStore {
  saveEnvelope(id: string, c: Conversation, metadata: ConversationMetadata): Promise<void>;
  loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined>;
  list(limit: number): Promise<ConversationRecord[]>;        // newest first
  listByProject(projectId: string, limit: number): Promise<ConversationRecord[]>;
  delete(id: string): Promise<boolean>;                      // false if absent
  save(id: string, c: Conversation): Promise<void>;          // envelope w/ default metadata
  load(id: string): Promise<Conversation | undefined>;
}
```

(The interface lives in `@jarvis/store`; `ConversationStoreBase` supplies
the wrapper methods so a backend only implements the core four.) Keyed by
an opaque id chosen by the caller (e.g. session UUID). See `DB.md` for the
backends and schema.

## The agent loop

`Agent` has two entry points backed by the same state machine:

- `Agent.run(conversation): Promise<RunOutcome>` — blocking
  (`runWithUsage` also returns aggregated provider usage).
- `Agent.runStream(conversation): AsyncGenerator<AgentEvent>` —
  streaming; yields `AgentEvent`s.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent.run loop                           │
│                                                                 │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ prepend system prompt (if conversation has none)      │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ LlmProvider.complete / completeStream                 │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│   ┌───────────────────────────────────────────────────────┐    │
│   │ push assistant message → Conversation                 │    │
│   └──────────────────────────┬────────────────────────────┘    │
│                              ▼                                  │
│                  finish_reason == tool calls?                   │
│                   ┌─────────┴─────────┐                         │
│                   │ yes               │ no                      │
│                   ▼                   ▼                         │
│        for each tool_call:        return RunOutcome             │
│         (maybe request approval)                                │
│         invoke via registry                                     │
│         push tool result                                        │
│                   │                                             │
│                   └── back to LlmProvider (next iteration) ──┐  │
│                                                              │  │
│              bounded by AgentConfig.maxIterations ───────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Key invariants (enforced in `agent.ts` — preserve when editing):

- The system prompt is **prepended once**, only if the conversation
  doesn't already have a system message.
- Tool errors are **caught and surfaced as text** (`"tool error: …"`)
  so the model can recover on the next turn.
- Streaming emits exactly one terminal event: either `done`
  (carrying the final `Conversation`) or `error`.
- The blocking path runs inside a `jarvis.agent.run` OpenTelemetry span;
  each tool call gets a nested `gen_ai.tool.call` child span. Both are
  no-ops unless an OTel SDK is registered (`JARVIS_OTEL_ENABLED`).

### `AgentEvent` (streaming)

`runStream` yields a discriminated union (`type` field). The main variants:

```
{ type: "delta"; content }                       // token / chunk from the LLM
{ type: "assistant_message"; message; finish_reason } // one complete assistant turn
{ type: "approval_request"; id; name; arguments } // emitted BEFORE awaiting the approver
{ type: "approval_decision"; id; name; decision }
{ type: "tool_start"; id; name; arguments }       // bracketing a tool invocation
{ type: "tool_progress"; id; name; stream; chunk } // incremental tool output
{ type: "tool_end"; id; name; content }
{ type: "plan_update"; items }                     // full plan snapshot (replace, not patch)
{ type: "usage"; model; … }                        // provider-reported token usage
{ type: "done"; outcome; conversation }            // terminal success
{ type: "error"; message }                         // terminal failure
```

## Request lifecycle

All chat transports are thin serialisation layers over `Agent.run` /
`runStream`. They share `AppState` and never reimplement the loop.

```
Client                 @jarvis/server                 @jarvis/core
──────                 ──────────────                 ────────────
                       ┌────────────┐
POST /v1/chat/…  ───▶  │ chat-routes│
                       │            │  build Conversation from body
                       │            │  call Agent.run or runStream
                       │            │  ┌──────────────────────────┐
                       │            │  │ Agent loop                │──▶ LlmProvider
                       │            │  │                           │──▶ Tools
                       │            │  │                           │    (possibly
                       │            │  │                           │     a remote
                       │            │  │                           │     MCP tool)
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

The WebSocket handler is the only chat endpoint that keeps conversation
state across turns: it captures the `done` event's `conversation` and
carries it into the next incoming user message. Clients don't resend
history. Each socket gets its own per-call approver so the client can
approve/deny gated tools in real time.

Beyond chat, `@jarvis/server` mounts the full `/v1/*` domain surface —
persisted conversations CRUD, projects/requirements (the Work kanban +
auto-loop), workflows, automations, skills, plugins, channels,
memories + memory sync, diagnostics, and more. See `CLAUDE.md` for the
route-by-route map. Every domain surface follows the same pattern:
return `503` when its store is unconfigured.

`AppState` is the shared bundle the router carries:

```ts
interface AppState {
  agent: Agent;
  stores?: StoreBundle;        // conversations + domain stores, if JARVIS_DB_URL
  memoryRuntime?: …;           // long-term memory + sync, if JARVIS_ENABLE_MEMORY
  // … further optional runtimes (auto-mode, workflows, channels, …)
}
```

Extend `AppState` rather than threading registries through handlers.

## MCP bridge (`@jarvis/mcp`)

`@jarvis/mcp` wires the agent into the Model Context Protocol in both
directions on top of the MCP SDK (stdio transport):

```
        ┌──────────────────────────────────────────────┐
        │ Jarvis process                               │
        │                                              │
        │    ┌──────────────────────────────────┐     │
        │    │ ToolRegistry                     │     │
        │    │  ├─ built-in tools               │     │
        │    │  └─ remote tool (one per remote) │─────┼──┐
        │    └──────────────────────────────────┘     │  │  remote MCP server
        │                       ▲                     │  │  (child process,
        │                       │ registerInto()      │  │   stdio)
        │              ┌────────┴─────────┐           │  │
        │              │ McpClient        │──────────────┘
        │              └──────────────────┘           │
        │                                              │
        │    ┌──────────────────────────────────┐     │
        │    │ McpServer                        │──┐  │  another MCP-aware
        │    │   exposes ToolRegistry over stdio│  │  │  agent (calls us)
        │    └──────────────────────────────────┘  │  │
        │                                          └──┼────────────▶
        └──────────────────────────────────────────────┘
```

- **Client** (`client.ts`): `McpClient.connect(config)` spawns a remote
  MCP server as a child process, handshakes, lists its tools, and
  `registerInto(registry, …)` inserts a remote-tool adapter into the
  local `ToolRegistry` for each one. Names are namespaced as
  `<prefix>.<tool>` so multiple servers don't collide. `connectAllMcp`
  is the batch helper.
- **Server** (`server.ts`): `McpServer` adapts the local `ToolRegistry`
  into an MCP server. `serveRegistryStdio` is the one-liner the
  `--mcp-serve` subcommand calls — no LLM or HTTP credentials required.

## Persistence (`@jarvis/store`)

Backend selection is by **URL scheme**, chosen at runtime by `connect(url)`
(`connectAll(url)` opens the whole domain-store family):

| URL prefixes                    | backend                                  |
|---------------------------------|------------------------------------------|
| `json:`, `json://`              | JSON files in a directory (**default**)  |
| `sqlite:`, `sqlite::memory:`    | SQLite (`better-sqlite3`)                |
| `postgres://`, `postgresql://`  | Postgres (deferred — currently throws)   |
| `mysql://`, `mariadb://`        | MySQL / MariaDB (deferred — throws)      |

**JSON files are the default.** With no `JARVIS_DB_URL`, the composition
root resolves to `json:///<data>/jarvis/conversations` (i.e.
`~/.local/share/jarvis/conversations/`), one `<id>.json` per conversation,
written atomically (`.tmp` + rename). SQLite and the SQL backends are
**opt-in** via the `JARVIS_DB_URL` scheme. An all-in-memory bundle
(`makeMemoryStores()`) backs tests and the server's no-DB fallback. See
`DB.md` for details.

## Composition (`packages/jarvis-app/src/main.ts`)

`main.ts` is the only place that reads `process.env`, picks default models,
or decides which tools ship on by default. Library packages must never read
`process.env` — put config on their input types and let `main.ts` populate
them. It dispatches these subcommands (default `serve`):

| subcommand   | does                                                         |
|--------------|-------------------------------------------------------------|
| `serve`      | build everything and start the `@jarvis/server` HTTP server |
| `mcp-serve`  | expose the local tool registry over MCP stdio (no LLM/HTTP) |
| `init`       | scaffold a config skeleton (prints the env knobs to set)    |
| `login`      | store an API key (OAuth device-code flow for `codex`)       |
| `status`     | print the resolved config summary (no secrets)              |
| `workspace`  | print the pinned workspace root (+ optional JSON)           |

`serve` startup order:

1. Resolve config from env (`config.ts`) — the sole `process.env` reader.
2. Initialise OpenTelemetry tracing if `JARVIS_OTEL_ENABLED`.
3. Build a `ToolRegistry` and register built-ins (honouring the
   write/exec opt-in gates).
4. If `--mcp-serve`: hand the registry to `serveRegistryStdio` and return —
   no LLM or HTTP setup.
5. Otherwise build the configured `LlmProvider` (OpenAI by default; or
   Anthropic / Google / Responses / Codex / Kimi / Ollama), optionally
   wrapped in the `RoutingProvider` when `JARVIS_ROUTER_ENABLED`.
6. If `JARVIS_MCP_SERVERS` is set: spawn external MCP servers and merge
   their tools into the registry.
7. Construct the `Agent` (provider + registry + system prompt +
   max iterations).
8. Open persistence (`connectAll(JARVIS_DB_URL)`, default `json:`) and
   build `AppState`; attach the memory runtime if `JARVIS_ENABLE_MEMORY`.
9. `serve(opts, state)`.

The web SPA is served from a real directory on disk (`@fastify/static`):
`make dev` builds `apps/jarvis-web/dist/` and `JARVIS_WEB_DIST` points the
server at it. A React-Router-aware fallback serves `index.html` for
extension-less unmatched paths so client routes resolve, while `/v1/` and
`/health` always 404 cleanly from the fallback.

## Extension points

Each extension point is an interface implementation in a new (or existing)
sibling package, plus one wiring line in `packages/jarvis-app/src/main.ts`.

### Add a new built-in tool

1. New module in `packages/tools/src/` exporting a `Tool` impl.
2. Re-export from `packages/tools/src/index.ts`.
3. (Optional) Register it in the built-ins entry point if it should be on
   by default. Otherwise let the composition root opt in.
4. Keep names namespaced: `<group>.<verb>` (e.g. `fs.read`). Anything that
   writes to disk or runs code stays opt-in and approval-gated.

### Add a new LLM provider

1. New module in `packages/llm/src/` (or a brand-new package).
2. Implement `LlmProvider`. Start with `complete` (extend
   `LlmProviderBase` for the streaming fallback); add `completeStream`
   when you need real-time tokens.
3. Re-export from `packages/llm/src/index.ts`.
4. Wire it in `main.ts` — typically behind the `JARVIS_PROVIDER` switch or
   a CLI flag. Preserve tool-call / tool-result pairing in the conversion.

### Add a new `ConversationStore` backend

1. New module in `packages/store/src/`.
2. Follow the `json-file.ts` (always-on) or `sqlite.ts` pattern: a backend
   that round-trips the JSON `Conversation` + metadata.
3. Add a match arm for the URL scheme in `connect()` / `connectAll()`.

### Add a new HTTP transport / endpoint

1. Handler module in `packages/server/src/` (e.g. `*-routes.ts`).
2. Mount it in the router (`server.ts`).
3. For streaming, call `Agent.runStream` and serialise `AgentEvent`s —
   don't reimplement the loop.
4. Extend `AppState` rather than threading extra handles through every
   handler. Return `503` when the backing store is unconfigured.

## Configuration surface

All user-facing configuration is read by `packages/jarvis-app/src/config.ts`
and passed as plain values into the library packages. A representative slice
(the full set is documented in `CLAUDE.md`):

| env var                   | default               | purpose                                       |
|---------------------------|-----------------------|-----------------------------------------------|
| `JARVIS_PROVIDER`         | `openai`              | `openai` / `openai-responses` / `anthropic` / `google` / `codex` / `kimi` / `ollama` |
| `OPENAI_API_KEY`          | —                     | required for OpenAI (unless `--mcp-serve`)    |
| `JARVIS_MODEL`            | per-provider default  | model id                                      |
| `JARVIS_ADDR`             | `0.0.0.0:7001`        | bind address for the HTTP server              |
| `JARVIS_FS_ROOT`          | `.`                   | sandbox root for `fs.*` / `git.*` / `shell.exec` |
| `JARVIS_ENABLE_FS_WRITE`  | unset                 | any value opts into `fs.write`                |
| `JARVIS_MCP_SERVERS`      | unset                 | `prefix=cmd args, …` — external MCP servers   |
| `JARVIS_DB_URL`           | `json:///…` (under `~/.local/share`) | persistence URL (`json:` / `sqlite:` …) |
| `JARVIS_ENABLE_MEMORY`    | unset                 | enable the long-term memory store + `/v1/memory/sync*` |
| `JARVIS_MEMORY_SYNC_BACKEND` | `none`             | markdown-memory sync: `none` / `git` / `icloud` |
| `JARVIS_HTTP_ALLOW_PRIVATE` | unset               | opt out of the `http.fetch` SSRF guard (private hosts are blocked by default) |
| `JARVIS_OTEL_ENABLED`     | unset                 | enable OpenTelemetry tracing                  |
| `JARVIS_OTEL_CONSOLE`     | unset                 | also export spans to the console              |

CLI flags consumed by the binary include `--mcp-serve` (expose the local
`ToolRegistry` over MCP stdio instead of the HTTP server),
`--workspace <path>` (alias `--fs-root`), `--addr`, and `--provider`.

## Commands

```bash
make check        # typecheck + lint + test — what CI runs
make dev          # build web + run the Node server with the embedded UI
make test         # node test runner across every package
make typecheck    # tsc --noEmit across every package
make lint         # eslint (the CI gate)
make perf         # the Node harness perf baseline (P8.3)

pnpm -r typecheck && pnpm -r test                 # CI without the make wrapper
pnpm --filter @jarvis/core test                   # one package
node --experimental-strip-types packages/jarvis-app/src/main.ts serve   # run the server (needs OPENAI_API_KEY)
```

See also `docs/security/p8-security-baseline.md` (SSRF guard, write/exec
gating, secret handling) and `docs/observability/perf-baseline.md` (the
`make perf` baseline).

## Conventions

- **Workspace-only deps** — packages depend on `@jarvis/*` siblings; shared
  dev-deps live once in the root `package.json`.
- **No `process.env` in library packages** — config flows in through input
  types; `packages/jarvis-app/src/main.ts` is the sole composition root.
- **eslint is the gate** — `make lint` must pass clean (mirrors CI).
- **Streaming is a separate method** — `completeStream` parallels
  `complete`; don't retrofit `complete`'s return type.
- **Tool-name collisions are silent** — the second registration wins.
  Namespace aggressively (`<group>.<verb>`).
- **Wire-shape types are owned by `@jarvis/shared-types`** — the single
  source of truth for types crossing the SPA boundary.
