# Jarvis

**Jarvis is a Node/TypeScript agent runtime and coding workspace for building, running, and extending tool-using AI agents.** It pairs a small runtime-independent harness with a web UI, terminal UI, HTTP API, MCP bridge, persistent conversations, workspace-aware tools, approval flows, and pluggable LLM providers.

English is the default README. A Chinese translation is available at [README.zh-CN.md](README.zh-CN.md).

## What It Does

Jarvis is designed for coding-agent workflows, but the core harness is general-purpose:

- Run multi-turn agents over HTTP, SSE, WebSocket, or the terminal.
- Connect to OpenAI, OpenAI Responses-compatible gateways, Anthropic, Google Gemini, Codex OAuth, Ollama, Kimi, and other OpenAI-compatible providers.
- Use built-in tools for file reading/listing/editing/patching, regex code search, sandboxed shell execution, HTTP fetch, git inspection, planning, user prompts, and workspace context.
- Bind conversations to a workspace so filesystem, shell, and git operations run against the right repository.
- See the selected workspace and current git branch directly above the chat composer.
- Optionally attach a project as light context for a new session; project selection is intentionally a soft reminder rather than a blocking setup step.
- Persist conversations, projects, permissions, and workspace bindings with JSON files by default, with SQLite, Postgres, and MySQL available by switching the store URL scheme.
- Gate sensitive tools through permission modes and rule-based permission policies.
- Bridge tools through MCP: consume external MCP servers or expose Jarvis tools as an MCP server.
- Keep conversations within a token budget using sliding-window or summarizing memory.
- Trace agent runs and tool calls through OpenTelemetry, and sync long-term Markdown memory through git or iCloud.

## Product Surfaces

### Web App

The web UI is served at the server root:

```bash
open http://127.0.0.1:7001/
```

The app includes:

- Chat workspace with streaming assistant output and visible tool activity.
- Claude Code-style composer context chips for local runtime, workspace, git branch, optional project context, model, and permission mode.
- Sidebar conversations, quick switcher, pinned chats, account/settings menu, and connection status.
- Workspace panels for diffs, changed files, tasks, plans, preview, terminal, and change reports.
- Settings for providers, server state, workspaces, permissions, MCP, plugins, skills, appearance, and preferences.
- Work and Docs routes for project/product context and documentation surfaces.

The SPA lives in `apps/jarvis-web` (React 19 + react-router, built by Vite). The Node server serves the built `dist/` bundle at `/`.

### Terminal UI

`@jarvis/jarvis-cli` runs the same harness in-process with an interactive REPL, approval prompts, and a non-interactive pipe mode:

```bash
pnpm --filter @jarvis/jarvis-cli start
echo "summarize the README" | pnpm --filter @jarvis/jarvis-cli start -- --no-interactive
```

See [docs/user-guide-cli.md](docs/user-guide-cli.md).

### HTTP and WebSocket API

Jarvis exposes OpenAI-shaped and Jarvis-native endpoints:

- `POST /v1/chat/completions`
- `POST /v1/chat/completions/stream`
- `GET /v1/chat/ws`
- `GET /v1/conversations`
- `GET /v1/providers`
- `GET /v1/workspace`
- `GET /v1/workspace/diff`
- `GET /v1/projects`
- `GET /v1/projects/:id/requirements?triage_state=approved|proposed_by_*|proposed`
- `POST /v1/requirements/:id/{approve,reject,runs}` — Triage approve / reject (with `reason`) / mint a fresh-session run
- `GET/POST /v1/requirements/:id/todos`, `PATCH/DELETE /v1/requirements/:id/todos/:todo_id` — structured execution/checklist items, including CI/CD commands and evidence
- `POST /v1/memory/sync/*` — git/iCloud Markdown-memory sync surface (enabled with `JARVIS_ENABLE_MEMORY`)
- `GET /v1/diagnostics/{worktrees/orphans, runs/stuck, runs/failed}` — doctor / forensics
- `GET /v1/server/info`

The WebSocket is the richest transport: it supports multi-turn state, persisted conversation resume, approval decisions, HITL responses, routing/model changes, workspace changes, and streaming `AgentEvent`s.

## Spec → Project Workflow (v1.0)

v1.0 turns the kanban into a "spec-in / project-out" loop. **Spec** is anything the agent can read: a one-line user request, a `docs/feature-x.md` Jarvis fetches via `fs.read`, or candidates surfaced by `triage.scan_candidates` over `TODO|FIXME|XXX|HACK` comments in the workspace.

The flow:

1. **Capture** — talk to Jarvis in chat ("read `docs/avatar-upload.md` and lay out the work"). The agent calls `workspace.context` + `fs.read`, drafts a breakdown via `plan.update`, and after user confirmation creates a project + one Requirement per item.
2. **Triage** — agent-created and scan-surfaced rows default to `triage_state=proposed_by_*` and land in the **Triage drawer** above the kanban. A human clicks **通过 / 拒绝** (the latter requires a free-text reason that lands on the activity timeline). User-typed REST creates default to `triage_state=approved` for back-compat.
3. **Execute** — open any approved Backlog card and click **新建一次运行 / Start fresh run** in the detail panel. The button mints a new conversation tied to the requirement, flips status to `in_progress`, and jumps you into chat.
4. **Auto** — set an `assignee_id` on a card and start the server with `JARVIS_WORK_MODE=auto`. The background scheduler picks `Approved` rows whose `depends_on` are all `done`, drives one run per tick, includes the card's structured TODO/checklist items in the run prompt, and runs the per-requirement `verification_plan.commands` after each agent loop. Runs that need worktree isolation are scoped through `git worktree add` (`JARVIS_WORKTREE_MODE=per_run`).
5. **Verify** — every `RequirementRun` carries its `verification` result (stdout / stderr / exit_code per command, aggregate `passed/failed/needs_review`). Failed runs flip the card back to Backlog before writing a `Blocked` activity.

The full spec is in [docs/proposals/work-orchestration.zh-CN.md](docs/proposals/work-orchestration.zh-CN.md).

## Quick Start

Jarvis runs on **Node ≥ 22.6** and uses **pnpm**. The server runs the TypeScript sources directly via `--experimental-strip-types`, so no build step is required to run it. The only thing you build ahead of time is the web bundle.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Build the Web UI

The server serves the built web bundle from `apps/jarvis-web/dist/`, so build the frontend once:

```bash
make web
# or, manually:
cd apps/jarvis-web && npm ci && npm run build
```

### 3. Configure a Provider

OpenAI is the default provider:

```bash
export JARVIS_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export JARVIS_MODEL=gpt-4o-mini
```

Other common provider settings:

```bash
# Anthropic
export JARVIS_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
export JARVIS_PROVIDER=google
export GOOGLE_API_KEY=...

# Ollama-compatible local server
export JARVIS_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:11434/v1
export JARVIS_MODEL=llama3.2

# Codex OAuth provider
# Run `codex login` once so ~/.codex/auth.json exists.
export JARVIS_PROVIDER=codex
```

### 4. Configure Workspace and Persistence

```bash
export JARVIS_ADDR=0.0.0.0:7001
export JARVIS_FS_ROOT=.
# Persistence defaults to JSON files under ~/.local/share/jarvis/conversations/.
# Switch backends by changing the URL scheme:
#   export JARVIS_DB_URL=sqlite://./jarvis.db
#   export JARVIS_DB_URL=postgres://user:pass@localhost/jarvis
```

Optional tool switches (write/exec tools are opt-in):

```bash
export JARVIS_ENABLE_FS_WRITE=1
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_SHELL_TIMEOUT_MS=30000
```

### 5. Run

```bash
make dev
```

`make dev` builds the web bundle and runs the server with the embedded UI in one process. To run the server directly:

```bash
node --experimental-strip-types packages/jarvis-app/src/main.ts serve --workspace /path/to/repo
```

Then open [http://127.0.0.1:7001/](http://127.0.0.1:7001/).

A container image is also provided — `make docker` builds it and `make docker-run` runs it (see the [Makefile](Makefile) and [Dockerfile](Dockerfile)).

## Configuration Reference

All environment variables are read by the composition root (`packages/jarvis-app/src/main.ts`); the library packages never read `process.env`. Important variables:

| variable | purpose |
| --- | --- |
| `JARVIS_PROVIDER` | Provider name: `openai` (default), `openai-responses`, `anthropic`, `google`, `codex`, `kimi`, or `ollama`. |
| `JARVIS_MODEL` | Default model for the selected provider. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `KIMI_API_KEY` | Provider credentials (`GEMINI_API_KEY` → Google, `MOONSHOT_API_KEY` → Kimi). |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_BASE_URL`, `OLLAMA_BASE_URL`, `KIMI_BASE_URL`, `CODEX_BASE_URL` | Compatible gateway or proxy base URLs. |
| `JARVIS_ADDR` | HTTP bind address. Defaults to `0.0.0.0:7001`. |
| `JARVIS_FS_ROOT` | Default workspace root for filesystem, git, and shell tools (`--workspace <path>` overrides). |
| `JARVIS_DB_URL` | Conversation/project store URL. Defaults to `json:///<data>/jarvis/conversations`; the scheme selects the backend (`json:` / `sqlite:` / `postgres://` / `mysql://`). |
| `JARVIS_MCP_SERVERS` | Comma-separated external MCP servers, such as `fs=uvx mcp-server-filesystem /tmp`. |
| `JARVIS_COMPOSIO_MCP_URL` | Full Composio MCP URL to register as a remote MCP server. |
| `JARVIS_COMPOSIO_MCP_SERVER_ID`, `JARVIS_COMPOSIO_USER_ID`, `COMPOSIO_API_KEY` | Alternative Composio setup: Jarvis builds the MCP URL and sends `COMPOSIO_API_KEY` as `x-api-key`. |
| `JARVIS_MEMORY_MODE` | Short-term memory mode: `window` (default) or `summary`. |
| `JARVIS_MEMORY_TOKENS` | Heuristic short-term memory budget. |
| `JARVIS_MEMORY_MODEL` | Model used for `summary` memory mode (defaults to `JARVIS_MODEL`). |
| `JARVIS_ENABLE_MEMORY` | Enable the long-term Markdown memory store and `/v1/memory/sync*` routes. |
| `JARVIS_MEMORY_SYNC_BACKEND` | Sync backend for long-term memory (`git` / iCloud). |
| `JARVIS_MEMORY_USER_ROOT` | Root directory for the long-term user memory store. |
| `JARVIS_PERMISSION_MODE` | `ask` / `accept-edits` / `plan` / `auto` / `bypass`. (Replaces the deprecated `JARVIS_APPROVAL_MODE`.) |
| `JARVIS_HTTP_ALLOW_PRIVATE` | Opt out of the `http.fetch` SSRF guard (private-network fetches are blocked by default). |
| `JARVIS_HTTP_MAX_BYTES` | Response-body truncation cap for `http.fetch`. |
| `JARVIS_OTEL_ENABLED` | Enable OpenTelemetry tracing (`jarvis.agent.run` + `gen_ai.tool.call` spans). |
| `JARVIS_OTEL_CONSOLE` | Export OpenTelemetry spans to the console (useful for local debugging). |
| `JARVIS_WORK_MODE` | `off` (default) or `auto`. When `auto`, the background scheduler drives Approved Requirements with an assignee. |
| `JARVIS_WORK_TICK_SECONDS` | Scheduler tick interval (default `30`). |
| `JARVIS_WORK_MAX_CONCURRENT` | Global cap on concurrent auto runs. |
| `JARVIS_WORKTREE_MODE` | `off` (default) / `per_run` / `per_unit`. Auto mode upgrades `off` → `per_run` so the scheduler never mutates the main checkout. |
| `JARVIS_WORKTREE_ROOT` | Directory under the workspace where `git worktree add` lands child trees (default `.jarvis/worktrees`). |
| `JARVIS_NO_PROJECT_CONTEXT` | Disable auto-loading `AGENTS.md` / `CLAUDE.md` / `AGENT.md` as project context. |
| `JARVIS_PROJECT_CONTEXT_BYTES` | Cap on loaded project-context bytes (default 8 KiB). |
| `JARVIS_ROUTER_ENABLED` | Wrap the primary provider in smart routing (off = unchanged behavior). |

Project-context auto-loading appends `AGENTS.md`, `CLAUDE.md`, or `AGENT.md` (priority order) from the workspace root, each wrapped in a context fence and capped by `JARVIS_PROJECT_CONTEXT_BYTES`. Disable it with `JARVIS_NO_PROJECT_CONTEXT=1` or `--no-project-context` (CLI).

See [docs/security/p8-security-baseline.md](docs/security/p8-security-baseline.md) for the security baseline (SSRF guard, tool gating, secret handling) and [docs/observability/perf-baseline.md](docs/observability/perf-baseline.md) for the performance baseline (`make perf`).

## Built-In Tools

Jarvis ships with a namespaced toolset:

- `echo`, `time.now`
- `http.fetch` (SSRF-guarded by default)
- `fs.read`, `fs.list`, `fs.write`, `fs.edit`, `fs.patch`
- `code.grep`
- `shell.exec`
- `git.status`, `git.diff`, `git.log`, `git.show` (read-only)
- `workspace.context`, `project.checks`
- `plan.update`, `ask.text`, `exit_plan`
- `triage.scan_candidates` — surface follow-up Requirement candidates from `TODO|FIXME|XXX|HACK` markers
- `todo.{list,add,update,delete}` — workspace-scoped lightweight backlog
- `requirement.{list,start,block,complete,create,update,delete,review_verdict}` — kanban row CRUD; agent-created rows default to `triage_state=proposed_by_agent` and wait for human approval
- `roadmap.import` — bootstrap a project + Requirements from `docs/proposals/`, `docs/roadmap/`, or `ROADMAP.md`
- `doc.{list,search,get,upsert,create,update,delete,draft.{get,save}}` — long-form document CRUD
- `memory.{list,read,write,delete,…,sync,sync_status,sync_setup}` — agent long-term memory with git/iCloud sync
- `subagent.<name>` (`review` / `claude_code` / `codex` / `reader` / `batch` …) — opt-in sub-agent runners

Mutation tools are opt-in and approval-aware. The composition root decides which tools are registered; `@jarvis/core` only sees the `ToolRegistry`.

## Architecture

Jarvis is a pnpm workspace. Libraries live under `packages/*` (published internally as `@jarvis/<name>`); apps live under `apps/`:

```text
packages/
  core/            Agent loop, message model, Tool/LlmProvider/Store interfaces
  llm/             Provider implementations
  router/          Smart routing (difficulty-classified model selection)
  mcp/             MCP client and server bridge
  memory/          Sliding-window and summarizing memory
  server/          HTTP, SSE, WebSocket, and UI serving
  store/           JSON-file (default) + SQLite/Postgres/MySQL stores
  tools/           Built-in tools
  project/         "Work" feature domain types + stores (kanban + audit timeline)
  workflow/        Declarative multi-step agent workflows
  channel/         Channel value types + dispatcher/store interfaces
  skill/           Skills catalog
  subagents/       Delegated sub-agents
  learning/        Telemetry + long-term memory surfaces
  automation/      Scheduled tasks
  observability/   Eval + observed value types
  plugin/          Plugin packaging
  shared-types/    Wire-shape types crossing the SPA boundary
  jarvis-app/      Server binary + composition root (the only env reader)
  jarvis-cli/      Terminal coding-agent UI
  desktop/         Desktop shell bindings
apps/
  jarvis-web/      React 19 + react-router SPA, built by Vite
  jarvis-desktop/  Tauri shell
  jarvis-ios/      iOS shell
```

The main design rule:

> `@jarvis/core` knows nothing about HTTP, providers, storage, MCP, or the web UI.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed layering and request lifecycle.

## MCP Mode

Run Jarvis as an MCP server exposing its local `ToolRegistry` over stdio (no LLM/HTTP setup):

```bash
node --experimental-strip-types packages/jarvis-app/src/main.ts mcp-serve
```

Or consume external MCP servers at runtime:

```bash
export JARVIS_MCP_SERVERS='fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git'
```

Composio-managed MCP endpoints can be registered directly:

```bash
export COMPOSIO_API_KEY=...
export JARVIS_COMPOSIO_MCP_SERVER_ID=mcp_...
export JARVIS_COMPOSIO_USER_ID=user-123
# or: export JARVIS_COMPOSIO_MCP_URL='https://backend.composio.dev/v3/mcp/...?...'
```

## Development

```bash
make check        # typecheck + lint + test — what CI runs
make typecheck    # pnpm -r typecheck (tsc --noEmit per package)
make lint         # eslint . (the CI gate)
make test         # pnpm -r test (node --test per package)
make perf         # run the harness perf baseline
make web          # build the web bundle into apps/jarvis-web/dist
make dev          # build web + run the Node server with the embedded UI
```

Equivalent raw commands:

```bash
pnpm -r typecheck && pnpm -r test
pnpm lint
pnpm --filter @jarvis/core test          # test a single package
```

When editing the web UI served by the Node server, rebuild the frontend (`make web`) so the new `dist/` bundle is served. **eslint is the gate** — keep the tree clean against it.

## Documentation

- [README.zh-CN.md](README.zh-CN.md) — Chinese translation.
- [CHANGELOG.md](CHANGELOG.md) — product changes.
- [docs/user-guide.md](docs/user-guide.md) — full user guide.
- [docs/user-guide-web.md](docs/user-guide-web.md) — web UI guide.
- [docs/user-guide-cli.md](docs/user-guide-cli.md) — terminal UI guide.
- [docs/user-guide-coding-agent.md](docs/user-guide-coding-agent.md) — coding-agent walkthrough.
- [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture.
- [DB.md](DB.md) — persistence schema and store details.
- [docs/security/p8-security-baseline.md](docs/security/p8-security-baseline.md) — security baseline.
- [docs/observability/perf-baseline.md](docs/observability/perf-baseline.md) — performance baseline.

## Status

Jarvis is usable as a local coding-agent runtime and extensible agent harness. The core loop, multiple providers, web and terminal frontends, persistent sessions, workspace-aware tools, MCP bridge, approvals, memory, OpenTelemetry tracing, and git/iCloud memory sync are implemented. Some product surfaces are still evolving, especially long-term memory, richer project/document workflows, and provider-specific polish.
