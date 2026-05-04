# Jarvis

**Jarvis is a Rust agent runtime and coding workspace for building, running, and extending tool-using AI agents.** It pairs a small runtime-independent harness with a web UI, terminal UI, HTTP API, MCP bridge, persistent conversations, workspace-aware tools, approval flows, and pluggable LLM providers.

English is the default README. A Chinese translation is available at [README.zh-CN.md](README.zh-CN.md).

## What It Does

Jarvis is designed for coding-agent workflows, but the core harness is general-purpose:

- Run multi-turn agents over HTTP, SSE, WebSocket, or the terminal.
- Connect to OpenAI, OpenAI Responses-compatible gateways, Anthropic, Google Gemini, Codex OAuth, Ollama, Kimi, and other OpenAI-compatible providers.
- Use built-in tools for file reading/listing/editing/patching, regex code search, sandboxed shell execution, HTTP fetch, git inspection, planning, user prompts, and workspace context.
- Bind conversations to a workspace so filesystem, shell, and git operations run against the right repository.
- See the selected workspace and current git branch directly above the chat composer.
- Optionally attach a project as light context for a new session; project selection is intentionally a soft reminder rather than a blocking setup step.
- Persist conversations, projects, permissions, and workspace bindings with SQLite by default, with Postgres and MySQL behind features.
- Gate sensitive tools through approval modes and rule-based permission policies.
- Bridge tools through MCP: consume external MCP servers or expose Jarvis tools as an MCP server.
- Keep conversations within a token budget using sliding-window or summarizing memory.

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

### Terminal UI

`jarvis-cli` runs the same harness in-process with an interactive REPL, approval prompts, and a non-interactive pipe mode:

```bash
cargo run -q -p jarvis-cli
echo "summarize the README" | cargo run -q -p jarvis-cli -- --no-interactive
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
- `GET /v1/diagnostics/{worktrees/orphans, runs/stuck, runs/failed}` — doctor / forensics
- `GET /v1/server/info`

The WebSocket is the richest transport: it supports multi-turn state, persisted conversation resume, approval decisions, HITL responses, routing/model changes, workspace changes, and streaming `AgentEvent`s.

## Spec → Project Workflow (v1.0)

v1.0 turns the kanban into a "spec-in / project-out" loop. **Spec** is anything the agent can read: a one-line user request, a `docs/feature-x.md` Jarvis fetches via `fs.read`, or candidates surfaced by `triage.scan_candidates` over `TODO|FIXME|XXX|HACK` comments in the workspace.

The flow:

1. **Capture** — talk to Jarvis in chat ("read `docs/avatar-upload.md` and lay out the work"). The agent calls `workspace.context` + `fs.read`, drafts a breakdown via `plan.update`, and after user confirmation calls `project.create_or_get` + `requirement.create` per item.
2. **Triage** — agent-created and scan-surfaced rows default to `triage_state=proposed_by_*` and land in the **Triage drawer** above the kanban. A human clicks **通过 / 拒绝** (the latter requires a free-text reason that lands on the activity timeline). User-typed REST creates default to `triage_state=approved` for back-compat.
3. **Execute** — open any approved Backlog card and click **新建一次运行 / Start fresh run** in the detail panel. The button mints a new conversation tied to the requirement, flips status to `in_progress`, and jumps you into chat.
4. **Auto** — set an `assignee_id` on a card and start the binary with `JARVIS_WORK_MODE=auto`. The background scheduler picks `Approved` rows whose `depends_on` are all `done`, drives one run per tick (configurable via `JARVIS_WORK_MAX_UNITS_PER_TICK`), and runs the per-requirement `verification_plan.commands` after each agent loop. Runs that need worktree isolation are scoped through `git worktree add` (`JARVIS_WORKTREE_MODE=per_run`).
5. **Verify** — every `RequirementRun` carries its `verification` result (stdout / stderr / exit_code per command, aggregate `passed/failed/needs_review`). Failed runs flip the card back to Backlog up to `JARVIS_WORK_MAX_RETRIES` times before writing a `Blocked` activity.

The full spec is in [docs/proposals/work-orchestration.zh-CN.md](docs/proposals/work-orchestration.zh-CN.md).

## Quick Start

### 1. Build the Web UI

The release binary embeds the web bundle at compile time, so build the frontend before building `jarvis`:

```bash
cd apps/jarvis-web
npm install
npm run build
cd ../..
```

### 2. Configure a Provider

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

### 3. Configure Workspace and Persistence

```bash
export JARVIS_ADDR=0.0.0.0:7001
export JARVIS_FS_ROOT=.
export JARVIS_DB_URL=sqlite://./jarvis.db
```

Optional tool switches:

```bash
export JARVIS_ENABLE_FS_WRITE=1
export JARVIS_ENABLE_FS_EDIT=1
export JARVIS_ENABLE_FS_PATCH=1
export JARVIS_ENABLE_SHELL_EXEC=1
export JARVIS_SHELL_TIMEOUT_MS=30000
```

### 4. Run

```bash
cargo run -p jarvis -- serve --workspace /path/to/repo
```

Or build and run the release binary:

```bash
cargo build --release -p jarvis
target/release/jarvis serve
```

Then open [http://127.0.0.1:7001/](http://127.0.0.1:7001/).

## Configuration Reference

Important environment variables:

| variable | purpose |
| --- | --- |
| `JARVIS_PROVIDER` | Provider name, for example `openai`, `anthropic`, `google`, `codex`, `ollama`. |
| `JARVIS_MODEL` | Default model for the selected provider. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` | Provider credentials. |
| `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_BASE_URL`, `OLLAMA_BASE_URL` | Compatible gateway or proxy base URLs. |
| `JARVIS_ADDR` | HTTP bind address. Defaults to `0.0.0.0:7001`. |
| `JARVIS_FS_ROOT` | Default workspace root for filesystem, git, and shell tools. |
| `JARVIS_DB_URL` | Conversation/project store URL, for example `sqlite://./jarvis.db`. |
| `JARVIS_MCP_SERVERS` | Comma-separated external MCP servers, such as `fs=uvx mcp-server-filesystem /tmp`. |
| `JARVIS_MEMORY_MODE` | `window` or `summary`. |
| `JARVIS_MEMORY_TOKENS` | Heuristic memory budget. |
| `JARVIS_PERMISSION_MODE` | `ask` / `accept-edits` / `plan` / `auto` / `bypass`. (Replaces the deprecated `JARVIS_APPROVAL_MODE`.) |
| `JARVIS_WORK_MODE` | `off` (default) or `auto`. When `auto`, the background scheduler drives Approved Requirements with an assignee. |
| `JARVIS_WORK_MAX_UNITS_PER_TICK` | Cap on Requirements picked per scheduler tick (default `1`). |
| `JARVIS_WORK_MAX_RETRIES` | Retry cap per Requirement before the loop stops re-picking it (default `1`). |
| `JARVIS_WORK_TICK_SECONDS` | Scheduler tick interval (default `30`). |
| `JARVIS_WORKTREE_MODE` | `off` (default) / `per_run` / `per_unit`. Auto mode upgrades to `per_run` if left `off`. |
| `JARVIS_WORKTREE_ROOT` | Directory under the workspace where `git worktree add` lands child trees (default `.jarvis/worktrees`). |
| `RUST_LOG` | Rust tracing filter. |

## Built-In Tools

Jarvis ships with a namespaced toolset:

- `echo`, `time.now`
- `http.fetch`
- `fs.read`, `fs.list`, `fs.write`, `fs.edit`, `fs.patch`
- `code.grep`
- `shell.exec`
- `git.status`, `git.diff`, `git.log`, `git.show`, `git.add`, `git.commit`, `git.merge`
- `workspace.context`, `project.checks`
- `plan.update`, `ask.text`, `exit_plan`
- `todo.{list,add,update,delete}` — workspace-scoped lightweight backlog
- `project.{list,get,create,update,archive,restore,delete}` — project CRUD
- `requirement.{list,create,update,delete,start,complete,block}` — kanban row CRUD; agent-created rows default to `triage_state=proposed_by_agent` and wait for human approval
- `triage.scan_candidates` — surface follow-up Requirement candidates from `TODO|FIXME|XXX|HACK` markers (more sources planned)
- `roadmap.import` — bootstrap a project + Requirements from `docs/proposals/`, `docs/roadmap/`, or `ROADMAP.md`
- `doc.{list,get,create,update,delete,draft.{get,save}}` — long-form document CRUD
- `codex.run`, `claude_code.run` — opt-in sub-agent runners

Mutation tools are opt-in and approval-aware. The binary composition root decides which tools are registered; `harness-core` only sees the `ToolRegistry`.

## Architecture

Jarvis is a Cargo workspace:

```text
crates/
  harness-core/    Agent loop, message model, Tool/LlmProvider/Store traits
  harness-llm/     Provider implementations
  harness-mcp/     MCP client and server bridge
  harness-memory/  Sliding-window and summarizing memory
  harness-server/  Axum HTTP, SSE, WebSocket, and UI serving
  harness-store/   SQLite/Postgres/MySQL stores
  harness-tools/   Built-in tools
  harness-cloud/   Optional cloud / edge runtimes via harness-cloud
apps/
  jarvis/          Server binary and composition root
  jarvis-cli/      Terminal coding-agent UI
  jarvis-web/      React web app bundled into the server binary
```

The main design rule:

> `harness-core` knows nothing about HTTP, providers, storage, MCP, or the web UI.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed layering and request lifecycle.

## MCP Mode

Run Jarvis as an MCP server exposing its local `ToolRegistry` over stdio:

```bash
cargo run -p jarvis -- --mcp-serve
```

Or consume external MCP servers at runtime:

```bash
export JARVIS_MCP_SERVERS='fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git'
```

## Development

```bash
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix apps/jarvis-web run build
cargo build --release -p jarvis
```

When editing the web UI served by `target/release/jarvis`, rebuild the frontend first, then rebuild the Rust binary so the new `dist/` bundle is embedded.

## Documentation

- [README.zh-CN.md](README.zh-CN.md) — Chinese translation.
- [CHANGELOG.md](CHANGELOG.md) — product changes.
- [docs/user-guide.md](docs/user-guide.md) — full user guide.
- [docs/user-guide-web.md](docs/user-guide-web.md) — web UI guide.
- [docs/user-guide-cli.md](docs/user-guide-cli.md) — terminal UI guide.
- [docs/user-guide-coding-agent.md](docs/user-guide-coding-agent.md) — coding-agent walkthrough.
- [ARCHITECTURE.md](ARCHITECTURE.md) — system architecture.
- [DB.md](DB.md) — persistence schema and store details.

## Status

Jarvis is usable as a local coding-agent runtime and extensible agent harness. The core loop, multiple providers, web and terminal frontends, persistent sessions, workspace-aware tools, MCP bridge, approvals, and memory are implemented. Some product surfaces are still evolving, especially long-term memory, richer project/document workflows, and provider-specific polish.
