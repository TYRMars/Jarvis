# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **⚠️ Runtime is Node/TypeScript — Rust fully decommissioned (P8 complete).**
> The Rust workspace (`crates/harness-*`, `apps/jarvis`, `apps/jarvis-cli`,
> `apps/jarvis-desktop`, `Cargo.toml`) was removed; Jarvis runs entirely on the
> **pnpm workspace under `packages/*`** + the `apps/jarvis-web` SPA. The Rust
> source remains in git history (tag `rust-archive-pre-takedown`). Each Node
> package mirrors the crate it was ported from (e.g. `@jarvis/core` ←
> `harness-core`), so the architecture notes below still describe the *shape* of
> the system — read them with `<crate>` → `@jarvis/<name>`,
> `apps/jarvis/src/main.rs` → `packages/jarvis-app/src/main.ts`. Build/test via
> `make check` (pnpm) or `pnpm -r typecheck && pnpm -r test`.
>
> P8 close-out shipped the last contract gaps + non-blocking items: the
> `/v1/memory/sync*` + `/v1/memory/includes*` routes are live (git/iCloud memory
> sync ported — `@jarvis/tools` `memory.{sync,sync_setup,sync_setup_icloud,
> sync_status}`); OpenTelemetry tracing emits `jarvis.agent.run` +
> `gen_ai.tool.call` spans (P8.4); a security baseline review landed hardening +
> findings (`docs/security/p8-security-baseline.md`, P8.6); and a Node perf
> baseline exists (`make perf`, P8.3). README/ARCHITECTURE were rewritten
> Node-native (P8.5).

## Project Overview

Jarvis is an agent runtime organised as a small, runtime-independent harness with
sibling packages plugging in. The single design rule: **`@jarvis/core` knows
nothing about HTTP, providers, storage, or MCP** — it owns only the agent loop and
the interfaces everything else implements. Library packages never read
`process.env`; `packages/jarvis-app/src/main.ts` is the sole composition root.

The sections below were written for the original Rust workspace; the Node port
preserves the same module boundaries (crate ↔ `@jarvis/*` package) and wire
contracts, so they remain an accurate architectural map pending the P8.5 rewrite.

## Workspace layout

```
apps/
  jarvis/          # HTTP server binary + composition root. Subcommands:
                   # serve / mcp-serve / init / login / status / workspace.
  jarvis-cli/      # Terminal coding-agent. Drives harness-core::Agent in-process
                   # (no HTTP); provider construction is env-only. REPL + a
                   # --no-interactive pipe mode (one turn under AlwaysDeny).
  jarvis-web/      # React 19 + react-router SPA, built by Vite into dist/ and
                   # baked into harness-server via include_dir!. Served at /.
  jarvis-desktop/  # Tauri shell. Excluded from default CI (needs WebKitGTK).

crates/  (libraries; deps are workspace-only: `foo.workspace = true`)
  harness-core/        # Agent, Conversation, Message, Tool, LlmProvider, Memory,
                       # Approver traits + the run loop. The leaf everything builds on.
  harness-llm/         # LlmProvider impls: OpenAI, Anthropic, Google, Responses
                       # (public OpenAI + Codex ChatGPT-OAuth). Kimi/Ollama reuse
                       # the OpenAI wire format via base-URL swaps.
  harness-router/      # Smart routing — RoutingProvider (an LlmProvider) classifies
                       # each request's difficulty into a Tier via a Classifier and
                       # rewrites the model before delegating. P0: HeuristicClassifier
                       # (no LLM). Wired in apps/jarvis as the primary provider entry
                       # when JARVIS_ROUTER_ENABLED. Depends on core only.
  harness-mcp/         # MCP bridge (rmcp): McpClient adapts remote tools into Tool;
                       # McpServer exposes a local ToolRegistry over stdio.
  harness-memory/      # Memory impls: SlidingWindowMemory + SummarizingMemory.
  harness-tools/       # Built-in Tool impls (fs.*, shell.exec, git.*, code.grep,
                       # http.fetch, channel.send, memory.*, requirement.*, …).
  harness-channel/     # Channel value types + ChannelDispatcher / *Store traits.
                       # Shared vocabulary for tools / store / server. core does NOT depend on it.
  harness-project/     # Project domain VALUE TYPES + *Store traits — Project /
                       # Requirement / RequirementRun / VerificationPlan / Activity /
                       # Comment / Label / DocProject / DocDraft / ProjectMemory. The
                       # "Work" feature (kanban + audit timeline). Depends on core (Usage type).
  harness-requirement/ # Requirement EXECUTION orchestration — context-manifest builders,
                       # roadmap import, RequirementRunEvent streams. Re-exports project
                       # value types. Depends on core + harness-project.
  harness-observability/ # Eval* + Observed* value types + ObservabilityStore / EvalStore
                       # traits ("is the agent doing well?"). True leaf, no harness-* deps.
  harness-store/       # Concrete store backends (ConversationStore / ProjectStore /
                       # TodoStore / channel / permission / memory). JSON-file + in-memory
                       # default; SQLite / Postgres / MySQL behind opt-in features.
  harness-server/      # Axum router + serve(addr, AppState). Owns ChannelAdapter trait
                       # + per-kind impls and every /v1 route module.
  harness-skill/       # Anthropic-style Skills catalog — SKILL.md (markdown + YAML
                       # frontmatter) discovery, activation selectors. Depends on core only.
  harness-subagents/   # SubAgent trait + registry for delegated agents (internal loop
                       # or SDK sidecar) invoked via subagent.<name> tools. Depends on core.
  harness-plugin/      # Plugin packaging — plugin.json manifests bundling skills + MCP
                       # servers, install/uninstall via PluginManager. Depends on core +
                       # harness-channel + harness-mcp + harness-skill.
  harness-learning/    # Self-improving-agent surfaces: SkillUsageEvent/Store telemetry +
                       # MemoryItem/Store long-term memory, with injection/leak guards.
                       # Depends on core only.
  harness-automation/  # AutomationTask + ScheduleSpec (one-time / interval) + AutomationStore
                       # for scheduled work. Depends on core only.
  harness-cloud/       # Edge/cloud runtime scaffold — EdgeNode, EdgeCommand, TaskMessage,
                       # EdgeTransport (+ WebSocket/loopback impls). Depends on core only.
  harness-workflow/    # Declarative multi-step agent Workflows — WorkflowDefinition /
                       # WorkflowStep (Agent/Pipeline/Phase/Parallel) / WorkflowRun +
                       # WorkflowStore. Bindable to a Requirement; executed by
                       # harness-server's workflow_runtime. Depends on core only.
```

New packages go under `packages/` (libraries) or `apps/` (binaries) and are picked up
by `pnpm-workspace.yaml` (`packages/*`); the shared dev-deps live in the root `package.json`.

## Commands

```bash
make check            # pnpm -r typecheck + lint + test (what CI runs)
make typecheck        # pnpm -r typecheck      (tsc --noEmit per package)
make lint             # pnpm lint              (eslint .  — CI gate)
make test             # pnpm -r test           (node --test per package)
make dev              # build web + run the Node server with the embedded UI
pnpm --filter @jarvis/core test                # one package
node --experimental-strip-types packages/jarvis-app/src/main.ts serve   # run the server (needs OPENAI_API_KEY)
```

Runtime is Node ≥ 22.6 (`--experimental-strip-types` runs the TS sources with no
build step). **eslint is the gate** — keep the tree clean against it. The web SPA
(`apps/jarvis-web`) is a standalone npm app (`npm` in that dir), built into `dist/`
and served by the Node server via `JARVIS_WEB_DIST`.

### Environment variables (consumed only by `packages/jarvis-app`)

**Provider & auth** (`JARVIS_PROVIDER` ∈ `openai` (default) / `openai-responses` / `anthropic` / `google` / `codex` / `kimi` / `ollama`):

| var | notes |
|-----|-------|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `KIMI_API_KEY` | required for the matching provider (unless `--mcp-serve`). Aliases: `GEMINI_API_KEY`→Google, `MOONSHOT_API_KEY`→Kimi |
| `JARVIS_MODEL` | per-provider default: `gpt-4o-mini` / `claude-3-5-sonnet-latest` / `gemini-1.5-flash` / `gpt-5.4-mini` / `kimi-k2-thinking` |
| `*_BASE_URL` | `OPENAI_` / `ANTHROPIC_` / `GOOGLE_` / `CODEX_` / `KIMI_` (Kimi default `…moonshot.cn/v1`; `.ai/v1` for intl) / `OLLAMA_` (default `localhost:11434/v1`) |
| `OLLAMA_API_KEY` | optional (local server ignores it) |
| `ANTHROPIC_VERSION` | default `2023-06-01` |
| `CODEX_HOME` | default `~/.codex`; `provider=codex` reads `auth.json` here |
| `CODEX_ACCESS_TOKEN` / `CODEX_ACCOUNT_ID` | dev escape hatch — static token, no refresh |
| `CODEX_ORIGINATOR` (`jarvis`) / `CODEX_RESPONSES_PATH` (`/codex/responses`) / `CODEX_REFRESH_TOKEN_URL_OVERRIDE` (test-only) | |

**Responses/reasoning knobs:** `CODEX_REASONING_SUMMARY` / `OPENAI_REASONING_SUMMARY` (`auto`/`concise`/`detailed` — required for reasoning models), `CODEX_INCLUDE_ENCRYPTED_REASONING` / `OPENAI_INCLUDE_ENCRYPTED_REASONING` (any value enables), `CODEX_SERVICE_TIER` / `OPENAI_SERVICE_TIER` (`auto`/`priority`/`flex`).

**Server / workspace:** `JARVIS_ADDR` (`0.0.0.0:7001`), `JARVIS_FS_ROOT` (`.`, sandboxes `fs.*`/`git.*`/`code.grep`/`workspace.context` + `shell.exec` cwd; `--workspace <path>` CLI flag overrides), `JARVIS_NO_PROJECT_CONTEXT` (disable auto-loading `AGENTS.md`/`CLAUDE.md`/`AGENT.md`), `JARVIS_PROJECT_CONTEXT_BYTES` (cap, default 8 KiB). (Logging is via `console`/`process.stderr`; there is no `RUST_LOG`-style level env in the Node runtime.)

**Remote access + DDNS** (the native iOS client connects to the home server + configures its dynamic DNS; see `docs/proposals/mobile-ddns.zh-CN.md`): `JARVIS_ACCESS_TOKEN` (bearer required of **non-loopback** callers — `packages/server/src/auth.ts` registers an `onRequest` gate that loopback bypasses and remote `/v1`+WS requests must satisfy via `Authorization: Bearer` or `?token=`; unset = no auth, the historical loopback/LAN default; **must** be set before exposing externally — a startup WARN fires on a non-loopback bind without it), `JARVIS_MDNS` (truthy → advertise `_jarvis._tcp` via the optional `bonjour-service` dep for zero-config LAN discovery; absent dep no-ops), `JARVIS_DEVICE_NAME` (friendly name in `GET /v1/remote/info`, default OS hostname). **DDNS** (`@jarvis/ddns`; `/v1/ddns/*` + `ddns.{status,update,configure}` tools): `JARVIS_DDNS_ENABLE` (truthy, or implied by a `JARVIS_DDNS_PROVIDER` seed, creates the `DdnsRuntime` so the routes work instead of 503), `JARVIS_DDNS_PROVIDER` (`cloudflare`/`duckdns`/`dyndns2`/`aliyun`/`dnspod`), `JARVIS_DDNS_HOSTNAME`, `JARVIS_DDNS_PORT` (default = listen port), `JARVIS_DDNS_INTERVAL` (sec, default 300), `JARVIS_DDNS_UPNP` (best-effort UPnP/NAT port-map), `JARVIS_DDNS_CREDENTIALS` (JSON object of provider credential keys; persisted `0600`, never returned by any GET). The iOS app normally PUTs the config at runtime instead of seeding via env.

**Tool gating** (write/exec tools are opt-in; any value enables): `JARVIS_ENABLE_FS_WRITE`, `JARVIS_ENABLE_FS_EDIT`, `JARVIS_ENABLE_FS_PATCH`, `JARVIS_ENABLE_SHELL_EXEC`, `JARVIS_SHELL_TIMEOUT_MS` (`30000`), `JARVIS_DISABLE_GIT_READ` (drops the otherwise-on `git.*` group), `JARVIS_HTTP_ALLOW_PRIVATE` (P8.6 SSRF guard is **on by default** — `http.fetch` blocks loopback/private/link-local/metadata hosts + non-http(s) schemes; set this to allow `localhost` dev servers), `JARVIS_ENABLE_LSP` (off by default; when set **and** a write primitive is enabled, `fs.{write,edit,patch}` append an LSP `<diagnostics>` block for the files they wrote — the agent's edit→verify loop via `@jarvis/lsp`. Language servers are PATH-probed (`typescript-language-server`/`pyright-langserver`/`gopls`/`rust-analyzer`); absent servers no-op, none are auto-downloaded), `JARVIS_MCP_SERVERS` (comma-sep `prefix=command args...`). Composio-managed MCP can be enabled with either `JARVIS_COMPOSIO_MCP_URL` or `JARVIS_COMPOSIO_MCP_SERVER_ID` + `JARVIS_COMPOSIO_USER_ID`; `COMPOSIO_API_KEY` / `JARVIS_COMPOSIO_API_KEY` is forwarded as `x-api-key`, with optional `JARVIS_COMPOSIO_PREFIX`, `JARVIS_COMPOSIO_ALLOW_TOOLS`, `JARVIS_COMPOSIO_DENY_TOOLS`.

**Permissions:** `JARVIS_PERMISSION_MODE` (`ask`/`accept-edits`/`plan`/`auto`/`bypass`). `JARVIS_APPROVAL_MODE` is **deprecated** (logs a startup WARN; still accepted).

**Persistence & memory:** `JARVIS_DB_URL` (defaults to `json:///<data>/jarvis/conversations`; scheme picks backend — `json:`/`sqlite:`/`postgres://`/`mysql://`, SQL backends are opt-in), `JARVIS_DISABLE_TODOS`, `JARVIS_MEMORY_TOKENS` (installs a token-budgeted memory backend), `JARVIS_MEMORY_MODE` (`window` (default) / `summary`), `JARVIS_MEMORY_MODEL` (summary mode, defaults to `JARVIS_MODEL`), `JARVIS_MEMORY_MAX_ITEMS` (long-term Memory store retention cap; default `5000`, `0`/`off`/`unlimited` disables pruning; pinned rows are never pruned).

**Markdown memory + sync** (the `memory.*` agent surface + `/v1/memory/*` routes; off by default): `JARVIS_ENABLE_MEMORY` (truthy registers `memory.{list,read,write,delete}` + `memory.include_*` and populates `AppState.memoryRuntime` so the REST routes work instead of 503-ing), `JARVIS_MEMORY_USER_ROOT` (parent of the user-scope `<root>/.jarvis/memory/` tree; defaults to the home dir), `JARVIS_MEMORY_SYNC_BACKEND` (`none` (default) / `git` / `icloud` — wires the matching `memory.{sync,sync_setup,sync_setup_icloud,sync_status}` tools + gates the `/v1/memory/sync*` routes).

**Observability (OpenTelemetry, P8.4):** off unless enabled. `JARVIS_OTEL_ENABLED` (truthy → OTLP/HTTP exporter, honours the standard `OTEL_EXPORTER_OTLP_*` vars), `JARVIS_OTEL_CONSOLE` (print spans to stderr — verify/debug, no collector needed), or just set `OTEL_EXPORTER_OTLP_ENDPOINT`. The agent loop emits `jarvis.agent.run` + `gen_ai.tool.call` spans via `@opentelemetry/api` (no-op when disabled); the SDK is registered only in the `packages/jarvis-app` composition root (`otel.ts`).

**Auto/Work mode** (`JARVIS_WORK_MODE` = `off` (default) / `auto`): `JARVIS_WORK_TICK_SECONDS` (`30`), `JARVIS_WORK_MAX_UNITS_PER_TICK` (`1` — per-tick burst), `JARVIS_WORK_MAX_CONCURRENT` (`2` — true global concurrency cap via a Semaphore; independent of the burst budget), `JARVIS_WORK_MAX_RETRIES` (`1`), `JARVIS_WORK_RUN_TIMEOUT_MS` (`600000`), `JARVIS_REVIEWER_AUTO_ACCEPT` (opt into reviewer-subagent dispatch on Review→Done under `Subagent` policy; default off).

**Subagents:** `JARVIS_SUBAGENT_CLAUDE_CODE_BIN` (`claude`), `_CLAUDE_CODE_MODEL`, `_CLAUDE_CODE_ARGS` (verbatim extra args), `_CODEX_MODEL` / `_READER_MODEL` / `_REVIEWER_MODEL` (per-subagent model override), `JARVIS_SUBAGENT_MAX_CONCURRENCY` (`3` — `subagent.batch` fan-out cap).

**Smart routing** (`harness-router`, opt-in; off = identical to today): `JARVIS_ROUTER_ENABLED` (truthy wraps the primary provider entry in a `RoutingProvider`), `JARVIS_ROUTER_TIER_{SIMPLE,MEDIUM,COMPLEX,REASONING}` (each `<provider>/<model>`; any unset tier falls through to the primary `(provider, model)`). Requests explicitly targeting a *different* provider bypass routing. Distinct from the operator-static `JARVIS_ROUTE_*` slots (`harness-server::ModelRoutePolicy`) consumed by subagents/summariser.

**Worktrees:** `JARVIS_WORKTREE_MODE` (`off`/`per_run`/`per_unit`; auto mode upgrades `off`→`per_run` so the scheduler never mutates the main checkout), `JARVIS_WORKTREE_ROOT` (`.jarvis/worktrees`).

**Workflows** (manual `POST /v1/workflows/:id/run` governance): `JARVIS_WORKFLOW_MAX_CONCURRENT` (global cap on concurrent manually-dispatched runs via a `WorkflowRunGate` semaphore; defaults to `JARVIS_WORK_MAX_CONCURRENT` — over-cap POSTs get `429`), `JARVIS_WORKFLOW_REAP_SECONDS` (`60` — stale-run reaper cadence; flips orphaned `Running`/`Pending` rows left by a crash to `Cancelled`, skipping runs still alive in-process), `JARVIS_WORKFLOW_RUN_TIMEOUT_MS` (reaper budget; defaults to `JARVIS_WORK_RUN_TIMEOUT_MS`, ×3 safety multiplier for `Running`). Cancel an in-flight run via `POST /v1/workflow-runs/:run_id/cancel`.

Passing `--mcp-serve` runs the binary as an MCP server on stdio exposing the local
ToolRegistry — no LLM/HTTP setup.

## Architecture

### The harness loop (`harness-core`)

Two entry points, same loop:

- `Agent::run(&mut Conversation) -> Result<RunOutcome>` — blocking. Calls
  `LlmProvider::complete`, appends the assistant message, dispatches tool calls, loops until
  a non-`ToolCalls` finish reason or `max_iterations`.
- `Agent::run_stream(self: Arc<Self>, Conversation) -> AgentStream` — streaming. Forwards
  `ContentDelta`s as `AgentEvent::Delta`, wraps each call in `ToolStart`/`ToolEnd`, finishes
  with exactly one `Done` (carrying the final `Conversation`) or `Error`. Takes the
  conversation by value (lives in an `async_stream!` block); consumers rebuild state from events.

Before the first LLM call the configured `system_prompt` is prepended iff there's no system
message already. Tool errors are **caught and surfaced as text** (`format!("tool error: {e}")`)
on both paths so the model can recover — preserve that when editing `agent.rs`.

**Message model** (`message.rs`): `Message` is an externally-tagged enum (`role` discriminator)
shaped like the OpenAI chat-completions wire format so providers map both ways losslessly. Tool
arguments are stored as parsed `serde_json::Value`; the OpenAI provider re-serialises them to
the JSON-string form OpenAI expects.

### Tools (`tool.rs` + `harness-tools`)

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value;          // JSON schema (return an object schema)
    async fn invoke(&self, args: Value) -> Result<String, BoxError>;
    fn requires_approval(&self) -> bool { false }
}
```

`BoxError` is re-exported from `harness-core`. `ToolRegistry` is a thin
`HashMap<String, Arc<dyn Tool>>`; `register` keys by `Tool::name()`, so **same-named tools
silently overwrite** — keep names namespaced (`<group>.<verb>`).

`register_builtins(&mut ToolRegistry, BuiltinsConfig)` is the one-shot entry point; individual
tools are also pub for selective registration. When adding a tool: put it in the right module
under `crates/harness-tools/src/`, export from `lib.rs`, add to `register_builtins` if on by
default. **Anything that writes to disk or runs code stays opt-in and approval-gated** (follow
the `fs.write` / `shell.exec` precedent).

**Always-on, read-only:** `echo`, `time.now`, `http.fetch` (GET/POST, body truncated to
`http_max_bytes`≈256 KiB; `format: "markdown"` arg converts HTML responses to clean Markdown
via `node-html-markdown` — non-HTML bodies pass through; native web search is intentionally not
built — point `JARVIS_MCP_SERVERS` at a search MCP server, e.g. `web=npx -y exa-mcp-server`, to
get `web.search`), `code.grep` (regex over sandbox, `.gitignore`-aware via the `ignore`
crate, `path`/`glob` narrowers, `max_results` + 64 KiB budget), `git.{status,diff,log,show}`
(read-only over host `git -C <root>`, typed per-subcommand schemas, arg validators reject
`-`-leading/null/newline; off via `JARVIS_DISABLE_GIT_READ`), `workspace.context` (compact JSON
workspace snapshot — the intended first call), `project.checks` (manifest scanner → suggested
commands, executes nothing), `plan.update` (pushes the full plan snapshot — replace, not patch —
via the `harness_core::plan` task-local channel → `AgentEvent::PlanUpdate`), `triage.scan_candidates`
(surfaces `TODO/FIXME/XXX/HACK` markers as Requirement candidates without writing), `ask.text`,
`exit_plan`.

**Filesystem** (`fs.*` scoped to a construction-time `root`; `sandbox::resolve_under` rejects
absolute paths and `..`): `fs.read`/`fs.list` always on; `fs.write`, `fs.edit` (uniqueness-checked
string replace — `old_string` must occur once unless `replace_all`), `fs.patch` (multi-file unified
diff via `diffy`, no fuzz, atomic per call, supports `/dev/null` create/delete, refuses
binary/renames/out-of-sandbox) are **opt-in + approval-gated**. `shell.exec` (`sh -c` /`cmd /C`,
sandboxed cwd, stdout/stderr each truncated 64 KiB, killed on timeout) is opt-in + approval-gated.

**Conditional (registered when their stores/config are present):**
- `requirement.{list,start,block,complete,create,update,delete,review_verdict}` — agent-side
  kanban CRUD (mirrors `requirements_routes.rs`). `create` defaults `triage_state=ProposedByAgent`
  (auto loop won't pick it up — pass `triage_state="approved"` when the user confirmed); `complete`
  flips to Review and is structurally barred from writing Done (human-only gate); `delete` is the
  only approval-gated one. All status mutations emit Activity rows. Needs `requirement_store` +
  `activity_store`.
- `roadmap.import` — scans `docs/proposals/` → `docs/roadmap/` → `roadmap/` → `ROADMAP.md`, creates/
  updates one Requirement per proposal under a `<basename>-roadmap` Project. Idempotent via a hidden
  `<!-- roadmap-source: … -->` marker; zh-CN files merge into their English peer; maps `**Status:**`
  keywords → kanban status. Approval-gated; needs `project_store` + `requirement_store`.
- `doc.{list,search,get,upsert,create,update,delete,draft.get,draft.save}` — DocProject + append-only
  Markdown drafts (mutators approval-gated).
- `memory.{list,read,write,delete,include_add,include_list,include_remove,include_refresh,
  sync,sync_status,sync_setup}` + `memory_icloud_setup` — agent long-term memory store, git/iCloud
  sync, include directives (writes/sync/deletes approval-gated).
- `learning.memory.{list,add,update,delete}` — user long-term memory rows (delete approval-gated).
- `todo.{list,add,update,delete}` — workspace TODO board (ungated).
- `subagent.<name>` (`review` / `claude_code` / `codex` / `reader` / `batch` …) — delegate to a
  sub-agent loop or CLI sidecar. `claude_code.run` / `codex.run` are approval-gated, off by default.
- `enter_plan_mode` / `harness.health` — off by default.

### LLM providers (`harness-llm`)

Each impl is over `reqwest` and shares nothing but the trait — wire shapes diverge too much to
factor a common transport. The `Conversation` shape is the lingua franca; each provider owns the
conversion **and must preserve tool-call/tool-result pairing** — getting it wrong shows up as
cryptic 400s mid-stream. Add providers under `harness-llm/src/`, implement `LlmProvider`,
re-export from `lib.rs`.

**OpenAI** (`OpenAiProvider`): tool-call `arguments` are a **JSON-encoded string** (converted in
`OaFunctionCallOut::From` / `parse_tool_call`, empty→`{}`). `finish_reason` defaults: missing +
non-empty `tool_calls` → `ToolCalls` else `Stop`. Manual SSE parser (`data: <json>\n\n`, `[DONE]`
sentinel); `StreamAccumulator` reassembles argument fragments in index order, one `Finish` at end.
Kimi/Ollama reuse this provider with swapped base URLs.

**Anthropic** (`anthropic.rs`): `system` messages hoisted to a top-level `system` field (joined
`\n\n`). Tool use is a content block — assistant turns carry `[{text},{tool_use,id,name,input}]`;
results return as `{tool_result,tool_use_id,content}` blocks inside a `user` message;
`convert_messages` coalesces consecutive `Message::Tool` into one user message. `max_tokens` is
**required** (default 4096). Typed SSE events; tool input arrives as `input_json_delta` fragments
parsed at `content_block_stop`; `Finish` on `message_stop`. Headers: `x-api-key`, `anthropic-version`.

**Google Gemini** (`google.rs`): system prompt → `systemInstruction.parts`; roles `user`/`model`;
tool calls are `functionCall` parts, results are `functionResponse` parts in a `user` message
wrapped as `{"result": "<text>"}`. `functionCall` has no id — we synthesise `gem_<index>` and
resolve the name from the prior assistant message. Streaming via `streamGenerateContent?alt=sse`
(without `alt=sse` Gemini ships a JSON array); `functionCall` parts arrive **whole**; `Finish` is
synthesised on body close (no in-band sentinel).

**Responses API** (`responses.rs` + `codex_auth.rs`): one wire layer, two auth strategies/presets.
`ResponsesProvider::openai_responses(api_key)` → `api.openai.com/v1/responses` (public; reasoning
models). `ResponsesProvider::codex(CodexAuth)` → `chatgpt.com/backend-api/codex/responses` (ChatGPT
subscription OAuth, flat-rate; not a public API — logs an `info!` on startup). Auth surface is
`ResponsesAuth::ApiKey` vs `ChatGptOauth(Arc<Mutex<CodexAuth>>)`; extend the enum for new flavours.
Wire differences from Chat Completions: `system`→top-level `instructions`; each tool call is a
*separate* `{type:"function_call",call_id,name,arguments}` item in the top-level `input` array
(replies → `function_call_output`); typed streaming events finalising on `response.completed`.
`ResponsesConfig` knobs: `store` (default false — we own state), `service_tier`, `reasoning_summary`,
`include_encrypted_reasoning`, `chain_responses`. **`chain_responses` defaults to false** for both
flavours — the Codex backend rejects `store:true` (`400 Store must be set to false`); the openai
flavour can opt in via `with_chain_responses(true)`.

`codex_auth.rs`: `load_from_codex_home` parses `<codex_home>/auth.json`; `from_static` is the
dev backdoor (no refresh); `refresh` POSTs `grant_type=refresh_token` to `auth.openai.com/oauth/token`
with the Codex CLI client_id (extends the same session) and atomically rewrites `auth.json`,
preserving other fields. **401 → refresh → retry once** in both `complete`/`complete_stream`; for
`ApiKey` the refresh errors so the 401 surfaces; concurrent requests coalesce (token-snapshot
comparison skips a redundant refresh).

### MCP bridge (`harness-mcp`)

Two directions on `rmcp`. **Client** (`client.rs`): `McpClient::connect` spawns an external server
over stdio, handshakes, `register_into` lists remote tools and inserts a `RemoteTool` adapter per
tool, renamed `<prefix>.<name>` to avoid collisions. The `McpClient` owns the child — drop/`shutdown()`
to kill it; `connect_all_mcp` is the batch helper. **Server** (`server.rs`): `McpServer::new(Arc<ToolRegistry>)`
hand-implements `ServerHandler` (our tool set is runtime-known). Tool errors surface as `is_error`
results, not JSON-RPC errors. `serve_registry_stdio` is what `--mcp-serve` calls. Non-object
`parameters()` get substituted with `{}` — keep schemas object-shaped. Pinned rmcp features:
`server, client, transport-io, transport-child-process, macros` (stdio only).

### HTTP server (`harness-server`)

`router(AppState)` → `axum::Router`; `serve(addr, state)` is the one-liner. `AppState` holds
`Arc<Agent>` + optional stores; extend it rather than threading registries through handlers.

**SPA routing:** `ui::router()` serves `/` → `index.html`; `ui::spa_fallback` serves `index.html`
for any extension-less unmatched path so react-router owns client routes (`/settings`, `/projects`,
…). Paths with extensions 404 cleanly; `/v1/` and `/health` always 404 from the fallback (so SDK
clients never parse SPA HTML as JSON). The web client is baked in from `apps/jarvis-web/dist/` via
`include_dir!`.

**Streaming invariant:** SSE and WS both call `Agent::run_stream` and just serialise `AgentEvent`s
— keep new transports on that path, don't reimplement the loop.

**Chat surfaces:**
- `POST /v1/chat/completions` — blocking → `{message, iterations, history}`.
- `POST /v1/chat/completions/stream` — SSE, each `data:` is one JSON `AgentEvent`.
- `GET /v1/chat/ws` — multi-turn WebSocket. Frames in: `user` / `reset` / `resume{id}` /
  `new{id?}` / `approve{tool_call_id}` / `deny{tool_call_id,reason?}`. Each socket gets its own
  `ChannelApprover` wired into a per-socket `Agent`; pending approvals drain in the handler's
  `tokio::select!` loop, which maps `tool_call_id → oneshot::Sender<ApprovalDecision>`. The agent
  yields `ApprovalRequest` **before** awaiting so the client can decide in time. Guards: new
  `user`/`reset`/`resume`/`new` while a turn runs → `error: turn in progress`; unknown approval id
  → `error: no pending approval`. In persisted mode the WS saves `Done.conversation` under the
  active id; `reset` clears both in-memory state and the persisted flag.

**Persisted conversations CRUD** (503 when no `ConversationStore`): `POST /v1/conversations`
(`{system?,id?}` → 201 `{id}`), `GET /v1/conversations?limit=N`, `GET`/`DELETE /v1/conversations/:id`,
`POST /v1/conversations/:id/messages` (append + run + save → `{id,message,iterations,history}`;
save failure is logged WARN but the reply still returns), `…/messages/stream` (SSE, saves on `Done`).
The `__memory__.` key prefix is internal-only — filtered from list, GET/DELETE refused, POST bodies
claiming it rejected.

**Work / triage / auto-loop.** Requirement rows carry `triage_state: TriageState`
(`Approved`/`ProposedByAgent`/`ProposedByScan`, serde-skipped when default) and `depends_on: Vec<String>`.
Manual `Start`/drag ignores both gates — they're scheduler-only.
- `GET /v1/projects/:id/requirements?triage_state=approved|proposed_by_agent|proposed_by_scan|proposed`
  (`proposed` = OR of both proposed-*; unknown → 400).
- `POST /v1/requirements/:id/approve` (→ Approved, idempotent `{no_op:true}`), `…/reject` (`{reason}`
  required; writes a `rejected` Activity *before* soft-delete), `…/runs` (mints a fresh-session run;
  does **not** auto-start the loop), `…/review` (manual reviewer dispatch — validates Review +
  `Subagent` policy + `subagent.review` registered; 202 `{dispatched:true}`).
- `POST /v1/roadmap/import` — same as the `roadmap.import` tool (`{slug?,name?,source_subdir?,prune?}`
  → `ImportSummary`; 503 if stores/workspace-root unset).

**Auto-loop guards** (`auto_mode::tick`, mostly silent skips): `triage_state == Approved`,
`assignee_id.is_some()`, all `depends_on` reach Done (topo sort), no in-flight run, `failed_count <
max_retries`, and Review rows under `AcceptancePolicy::Human` are skipped. The `depends_on` gate
distinguishes *permanent* deadlocks from ordinary waiting: a **self-dependency** (a row listing its
own id) or a **dependency cycle** (`A→B→A`, plus anything transitively behind one) surfaces an
operator-visible `Blocked` Activity row **once** (deduped on the newest row, reason
`self_dependency` / `dependency_cycle`) instead of skipping in silence forever. Self-dependency is
also rejected at requirement create/update time (REST + `requirement.{create,update}` tools).
Cross-project `depends_on` ids are **not** resolved across stores — author dependencies within a
single project; an id pointing outside the project is treated as "not yet done" and blocks (a
silent `debug!` skip, since a deleted-dep block is intended).

**Acceptance policy** (`Requirement.acceptance_policy`): `Subagent` (default) auto-flips Review→Done
**unless** `JARVIS_REVIEWER_AUTO_ACCEPT` is set, in which case the picker re-picks the Review row,
re-runs the agent (`drive_one`), and the prompt directs it to delegate to the `subagent.review`
subagent whose terminal `requirement.review_verdict` call flips Done (`pass`) / InProgress (`fail`).
`Human` keeps the row at Review (the picker also skips it) — for work the verification plan can't
model. Reviewer auto-accept is off by default. Tests: `auto_mode.rs::tests` under `reviewer_flag`-
prefixed names.

**Other domain REST surfaces** (each follows the 503-when-unconfigured pattern):
- `GET /v1/workspace` → `{root,vcs,branch?,head?,dirty?}` (live git probe; 503 if no pinned root).
  Plus `/v1/workspace/{list,read,find,diff/*}` (files/search/git) and `/v1/workspace/terminal` (PTY WS);
  `/v1/workspaces` (persisted recent-workspace registry).
- `/v1/automations` (+ `/:id/run`) — scheduled-task CRUD + on-demand trigger (`automation_runtime`).
- `/v1/workflows` (+ `/:id`, `/:id/run`, `/:id/runs`, `/v1/workflow-runs/:id`, `/v1/workflow-runs/:id/cancel`) —
  declarative multi-step agent workflows (CRUD + dispatch + cancel). Bindable to a Requirement via its
  `workflow_id`; executed by `workflow_runtime::drive_workflow` (also branched into from `auto_mode`).
  Manual `/run` dispatch is governed by a process-wide `WorkflowRunGate` (`workflow_concurrency.rs`):
  a global concurrency semaphore (over-cap → `429`), a run-cancel ledger of `AbortHandle`s, and a
  liveness set the `spawn_workflow_reaper` background sweep consults so it only reclaims orphaned
  `Running` rows (left by a crash), never live in-process runs. See
  `docs/proposals/declarative-workflows.zh-CN.md`.
- `/v1/skills` (+ `/:name`, `/reload`, `/:name/lifecycle`, archive/restore) — Skills catalog.
- `/v1/plugins` (+ `/:name`, `/marketplace`), `/v1/market/{mcp,skills,skills/install}` — plugin/market.
- `/v1/subagents` (list) + `/v1/subagents/runs*` (run ledger / cancel).
- `/v1/agent-profiles` — user identity bundles (name/provider/model/system prompt).
- `/v1/providers` (+ `/default`) — runtime provider config (503 with no admin impl).
- `/v1/memories` — Phase-1 row-based memory store (`memories-routes.ts`).
- `/v1/memory/sync_status` · `/sync` · `/sync_setup` · `/sync_setup_icloud` + `/v1/memory/includes` (GET/POST/DELETE) · `/includes/refresh` — git/iCloud memory-tree sync + include directives (`memory-sync-routes.ts`; invokes the `memory.*` tool impls directly per request from `AppState.memoryRuntime`, 503 when `JARVIS_ENABLE_MEMORY` is unset, backend-mismatch 503 for git/iCloud ops).
- `/v1/learning/skill-usage` (+ `/report`) — skill-activation telemetry.
- `/v1/doc-projects*` (+ `/:id/draft`) — append-only Markdown drafts.
- `/v1/work/{overview,quality}` — dashboard aggregation (tolerates partial stores).
- `/v1/diagnostics/{worktrees/orphans,runs/*,memory}` — health snapshots + worktree cleanup.
- `/v1/channels` (+ `/:id`, `/:id/test`, `/kinds`, `/:id/callback`, `/:id/oauth/{start,callback}`) —
  channel-instance CRUD, inbound platform callbacks (WeCom/Feishu/DingTalk), WeCom-app OAuth2 identity.

### Plan channel (`harness-core::plan`)

Sibling to `harness-core::progress`. Per-invocation `task_local` `mpsc::UnboundedSender<Vec<PlanItem>>`
scoped via `with_plan(...)`. Tools call `plan::emit(items)`; the loop drains it in the same
`tokio::select!` arm pattern as `progress` and yields `AgentEvent::PlanUpdate { items }`. Each emit
is the **full latest snapshot** (replace, not patch). Outside an agent loop the channel is absent so
emits are no-ops (keeps `plan.update` tests trivial). The web UI renders it in `PlanList` (right rail).

### Short-term memory (`harness-memory`)

`harness_core::Memory` is the trait; the loop calls `memory.compact(&messages)` inside
`Agent::build_request` every iteration and ships the result to the LLM — the canonical
`Conversation` is **not** mutated, so `Done.conversation` keeps full history. Failures bubble as
`Error::Memory` → `AgentEvent::Error`.

Both impls share the turn-grouping helpers in `turns.rs`. Invariants: a turn starts at `User` and
runs through every following Assistant + `Tool` reply (never splits a tool-call from its answers —
OpenAI rejects orphaned tool messages); leading `System` messages always kept; the most recent turn
always kept even if over budget. Token counts are heuristic (`estimate_tokens`, ~chars/4 + per-message
overhead).

- `SlidingWindowMemory::new(max_tokens)` — drops oldest turns, optional `[N earlier turn(s) omitted]`
  note.
- `SummarizingMemory::new(llm, model, max_tokens)` — summarises the dropped prefix into a synthetic
  `System` message instead. Three-tier lookup keyed by a stable BLAKE3 fingerprint of the dropped
  slice: in-memory slot → optional persistent store (`with_persistence`) → LLM. The persistent tier
  writes synthetic rows under `__memory__.summary:<hash>` so summaries survive restarts and are
  shared across workers; store failures degrade gracefully (`warn!` + fall through). Leaves
  `SUMMARY_RESERVE_TOKENS` (256) headroom. The summary call must use `tools: vec![]` + a pinned
  temperature. `apps/jarvis` auto-attaches the store when both `JARVIS_MEMORY_MODE=summary` and
  `JARVIS_DB_URL` are set.

### Approval gate (`harness-core::approval`)

`Tool::requires_approval` (default false). When `AgentConfig::with_approver` is set, the loop
consults it before any gated tool: `Approve` runs it; `Deny{reason}` writes a synthetic
`"tool denied: <reason>"` `Message::Tool` so the model adapts; an approver `Err` is treated as a
Deny (`"approver failed: …"`) to keep the loop moving. **No approver configured → gated tools run
unconditionally** (historical default). Gated today: `fs.write`, `fs.edit`, `fs.patch`, `shell.exec`
(+ the conditional mutators listed above).

Approvers: `AlwaysApprove` / `AlwaysDeny` (tests/defaults); `ChannelApprover` (fans `PendingApproval`
over an mpsc for a transport-side consumer — the WS building block). Streaming emits
`AgentEvent::ApprovalRequest{id,name,arguments}` before and `ApprovalDecision{id,name,decision}` after;
`ToolStart`/`ToolEnd` always wrap the call (deny writes the sentinel into `ToolEnd.content`). The WS
transport overrides the global config with a per-socket `ChannelApprover` for genuine per-call control.

### Persistence (`harness-store`)

Traits live in `harness-core`/`harness-project`/etc.; `harness-store` provides backends. **JSON-file
is the default** (`~/.local/share/jarvis/conversations/`); SQL backends are opt-in cargo features.
Backend is chosen both at compile time (feature) and runtime (URL scheme):

| feature     | URL prefixes                   | backend |
|-------------|--------------------------------|---------|
| (always on) | `json:` / `json://`            | JSON files in a directory (default, zero deps) |
| `sqlite`    | `sqlite:` / `sqlite::memory:`  | SQLite (`--features sqlite`) |
| `postgres`  | `postgres://` / `postgresql://`| Postgres (`--features postgres`) |
| `mysql`     | `mysql://` / `mariadb://`      | MySQL/MariaDB (`--features mysql`) |

`harness_store::connect(url)` → `Arc<dyn ConversationStore>`; higher layers don't name the backend.
JSON: one `<id>.json` per conversation, filenames percent-encode bytes outside `[A-Za-z0-9._-]` (so
`__memory__.summary:<hash>` keys are Windows-safe), atomic `.tmp`+rename, `list()` is O(N). SQL: one
`conversations(id, messages, created_at, updated_at)` table, `messages` = JSON `Conversation`,
RFC-3339 string timestamps (so core needs no time crate). `MemoryConversationStore` is always
compiled for tests but not `connect()`-selectable. New backend: follow `json_file.rs` (always-on) or
`sqlite.rs` (feature-gated: pool wrapper + idempotent `migrate()` + JSON-blob-in-a-row), then add a
`connect()` arm.

### Binary (`apps/jarvis`)

`main.rs` is the only place that reads env vars / picks default models / wires tools — the
composition root. Library crates must not read `std::env`.

- **Workspace selection:** `serve --workspace <path>` (alias `--fs-root`) > `JARVIS_FS_ROOT` >
  `[tools].fs_root` > `.`. Logged once at startup.
- **System-prompt switch** (`serve.rs`): `[agent].system_prompt` (verbatim) > `CODING_SYSTEM_PROMPT`
  (when *coding mode* — any of `fs.edit`/`fs.write`/`fs.patch`/`shell.exec` enabled — and
  `[agent].coding_prompt_auto != false`) > `GENERAL_SYSTEM_PROMPT`. Both consts live at the top of
  `serve.rs`.
- **Project-context auto-load:** appends `AGENTS.md` / `CLAUDE.md` / `AGENT.md` (priority order) via
  `load_instructions`, each wrapped in `=== project context: <name> ===`, capped 8 KiB
  (`JARVIS_PROJECT_CONTEXT_BYTES`; truncation logs WARN). Disable via `JARVIS_NO_PROJECT_CONTEXT=1` /
  `[agent].include_project_context = false` / `jarvis-cli --no-project-context`. `README.md` /
  `CONTRIBUTING.md` are deliberately excluded.

## Conventions

- **Workspace deps only** — `foo.workspace = true`; version lives once in the root `[workspace.dependencies]`.
- **No `unwrap` in library crates** — return `harness_core::Result` / `BoxError`; `apps/jarvis` may use `anyhow`.
- **Errors:** `thiserror`-derived `Error` in `harness-core`; provider errors wrapped in `Error::Provider(String)`, never leaking `reqwest::Error`.
- **Clippy is the gate** — `make lint` must pass clean (mirrors CI `.github/workflows/rust.yml`).
- **Streaming on its own method** — `complete_stream` parallels `complete`; don't retrofit `complete`'s return type. New providers may skip it (default impl wraps `complete` + one `Finish`).
- **Tool-name collisions are silent** — second registration wins; keep names namespaced.
- **Wire-shape types are owned by `@jarvis/shared-types`** — the Node-side single source of truth for types crossing the SPA boundary (the former Rust `ts_rs` codegen into `apps/jarvis-web/src/types/generated/` has been removed as a step toward decommissioning Rust). The Node domain packages (`@jarvis/channel` / `@jarvis/workflow`) re-export from it and keep their runtime helpers; the standalone web SPA consumes it via a path alias. When you change a wire shape, edit `packages/shared-types/src/index.ts` and keep the Rust struct's serde JSON shape in sync by hand. See `docs/conventions/rust-ts-codegen.md` (retired-convention note).
