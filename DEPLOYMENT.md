# Deployment Guide

How to run Jarvis somewhere other than `make dev`. Three deployment shapes,
ordered from "trying it out" to "running it for real".

Jarvis is a **Node/TypeScript** agent runtime: the server runs the TypeScript
composition root directly via `node --experimental-strip-types` (Node ≥ 22.6),
with no separate build step. The React SPA is built once with Vite and served
from the same process.

The single source of truth for **all** environment variables remains
[CLAUDE.md](CLAUDE.md); this guide selects the subset that matters at deploy
time and explains how the pieces fit together.

---

## TL;DR

```bash
cp .env.example .env
$EDITOR .env                # set OPENAI_API_KEY (or your provider of choice)
docker compose up -d
open http://127.0.0.1:7001
```

That's the whole story for a personal install.

---

## Mode 1 — Local, no containers

Use when: you're hacking on Jarvis itself.

```bash
make install    # pnpm install (the workspace under packages/*)
make dev        # build the web bundle, then run the Node server with the
                # embedded UI on :7001 (needs OPENAI_API_KEY in the env)
```

`make dev` is a single process: it builds `apps/jarvis-web/dist/`, then runs the
composition root with `JARVIS_WEB_DIST` pointed at it so the SPA is served at
`/`. Under the hood:

```bash
JARVIS_WEB_DIST=$PWD/apps/jarvis-web/dist \
OPENAI_API_KEY=sk-... \
JARVIS_FS_ROOT=$PWD \
  node --experimental-strip-types packages/jarvis-app/src/main.ts serve
```

Two-process dev workflow with hot-reload on the UI:

```bash
make web-dev    # terminal 1 — Vite dev server on :5173 (proxies API to :7001)
make dev        # terminal 2 — Node server on :7001
```

Before shipping, run the same gate CI does:

```bash
make check      # pnpm -r typecheck + eslint + pnpm -r test
```

(or the individual targets `make typecheck` / `make lint` / `make test`, or the
raw `pnpm -r typecheck && pnpm -r test`). A single package's tests:
`pnpm --filter @jarvis/core test`.

---

## Mode 2 — Single Docker container

Use when: you want to share Jarvis with someone, run it on a different
machine, or pin a specific version.

```bash
make docker                       # builds image `jarvis:local`
docker run --rm -it \
  -p 127.0.0.1:7001:7001 \
  -e OPENAI_API_KEY=sk-... \
  -v jarvis-data:/data \
  -v "$PWD":/workspace \
  jarvis:local
```

Anatomy of the image (multi-stage, see [`Dockerfile`](Dockerfile)):

| Stage | What it does |
|-------|--------------|
| `web`     | `npm ci && npm run build` → `apps/jarvis-web/dist/` |
| `deps`    | `pnpm install --frozen-lockfile` over the `packages/*` workspace (with a toolchain for native modules like `better-sqlite3` / `node-pty`) |
| `runtime` | `node:22-bookworm-slim` + `git`, `ca-certificates`, `tini`, `curl`. Runs as non-root user `jarvis` (uid 10001). Entrypoint runs `node --experimental-strip-types packages/jarvis-app/src/main.ts serve` — no transpile step. |

The runtime runs the TypeScript sources directly — there is **no** compiled
binary and no build step at container start. The React bundle is copied in from
the `web` stage and served by the Node server (`JARVIS_WEB_DIST`). No nginx, no
separate static-file server.

Two volumes the runtime expects:

- `/data` — persistent state. With `HOME=/data` (set in the image), the default
  `JARVIS_DB_URL` writes JSON files under
  `/data/.local/share/jarvis/conversations/`.
- `/workspace` — the project the agent operates on. Mount whatever
  directory should be the agent's sandbox; `JARVIS_FS_ROOT=/workspace`
  is set at the image level.

---

## Mode 3 — Docker Compose (recommended for self-hosting)

Use when: you want it running unattended with restarts, persisted data,
and a clear path to upgrade.

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
docker compose logs -f
```

The default compose file binds Jarvis to `127.0.0.1:7001`. **Do not**
publish on `0.0.0.0` directly — there's no built-in auth on the chat /
project endpoints today. Front it with:

- A reverse proxy (Caddy, Traefik, nginx) terminating TLS and handling
  auth (basic, OAuth-proxy, Tailscale Funnel, Cloudflare Tunnel, …).
- Or a private network (Tailscale, Wireguard, your VPC) and bind to the
  private interface.

See [`docs/security/p8-security-baseline.md`](docs/security/p8-security-baseline.md)
for the current security posture (no built-in auth, SSRF guard on `http.fetch`,
tool gates, sandboxing).

### Switching to Postgres / SQLite / MySQL

The default JSON-file backend is fine up to a few thousand conversations.
For larger fleets or multi-instance deploys, switch the backend. The Node
server selects the store from the `JARVIS_DB_URL` **scheme** at runtime — there
is no compile-time flag:

1. Point `JARVIS_DB_URL` at the backend you want:
   - `json:///data/.local/share/jarvis/conversations` (default)
   - `sqlite:///data/jarvis.db`
   - `postgres://jarvis:jarvis@postgres:5432/jarvis`
   - `mysql://jarvis:jarvis@mysql:3306/jarvis`
2. For Postgres: uncomment the `postgres` service in `docker-compose.yml` and
   the matching `JARVIS_DB_URL: "postgres://..."` line.
3. `docker compose up -d`.

The schema migrates automatically on startup.

---

## Environment variable reference (deployment subset)

The full list is in [CLAUDE.md](CLAUDE.md). What matters for ops:

### Provider selection

| Var | Default | Notes |
|---|---|---|
| `JARVIS_PROVIDER` | `openai` | `openai` / `openai-responses` / `anthropic` / `google` / `codex` / `kimi` / `ollama` |
| `OPENAI_API_KEY` | — | Required when provider is `openai` / `openai-responses` |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic` |
| `GOOGLE_API_KEY` | — | Required for `google`; `GEMINI_API_KEY` also accepted |
| `KIMI_API_KEY` | — | Required for `kimi`; `MOONSHOT_API_KEY` aliases it |
| `JARVIS_MODEL` | per-provider | Override the per-provider default |
| `*_BASE_URL` | per-provider | For self-hosted gateways / EU regions / Azure proxies |

### Networking

| Var | Default | Notes |
|---|---|---|
| `JARVIS_ADDR` | `0.0.0.0:7001` | Listen address. Image keeps the default; bind on the host side instead |
| `JARVIS_FS_ROOT` | `.` | Sandbox root for `fs.*`, `git.*`, `code.grep`, `shell.exec`. Image sets `/workspace` |
| `JARVIS_WEB_DIST` | (unset) | Path to the built SPA (`apps/jarvis-web/dist`). Set by `make dev` and the image; serves the UI at `/` |

### Persistence

| Var | Default | Notes |
|---|---|---|
| `JARVIS_DB_URL` | `json:///<data>/jarvis/conversations` | Scheme picks the backend at runtime: `json:` (default, zero deps) / `sqlite:` / `postgres:` / `mysql:` |
| `JARVIS_DISABLE_TODOS` | (off) | Set any value to disable the project TODO board |

The JSON store is the default — one `<id>.json` per conversation under
`$HOME/.local/share/jarvis/conversations/`. SQLite / Postgres / MySQL are
opt-in via the URL scheme only.

### Permissions / tool gates

| Var | Default | Notes |
|---|---|---|
| `JARVIS_PERMISSION_MODE` | `ask` | `ask` / `accept-edits` / `plan` / `auto` / `bypass` |
| `JARVIS_ENABLE_FS_WRITE` | (off) | Any value enables `fs.write` |
| `JARVIS_ENABLE_FS_EDIT` | (off) | Any value enables `fs.edit` |
| `JARVIS_ENABLE_FS_PATCH` | (off) | Any value enables `fs.patch` |
| `JARVIS_ENABLE_SHELL_EXEC` | (off) | Any value enables `shell.exec` |
| `JARVIS_DISABLE_GIT_READ` | (off) | Set to drop the read-only `git.*` toolset (e.g. when `git` isn't on PATH) |
| `JARVIS_HTTP_ALLOW_PRIVATE` | (off) | `http.fetch` blocks loopback / private / metadata hosts by default (SSRF guard). Set to allow them (e.g. localhost dev servers) |

### Memory + git/iCloud sync

| Var | Default | Notes |
|---|---|---|
| `JARVIS_ENABLE_MEMORY` | (off) | Registers the `memory.*` agent tools + enables the `/v1/memory/*` routes |
| `JARVIS_MEMORY_SYNC_BACKEND` | `none` | `none` / `git` / `icloud` — backing transport for `/v1/memory/sync*` |
| `JARVIS_MEMORY_USER_ROOT` | (unset) | Parent of the user-scope `.jarvis/memory/` tree |

### Observability (OpenTelemetry)

| Var | Default | Notes |
|---|---|---|
| `JARVIS_OTEL_ENABLED` | (off) | Enables the OTLP/HTTP exporter; honours the standard `OTEL_EXPORTER_OTLP_*` vars. Emits `jarvis.agent.run` + `gen_ai.tool.call` spans |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | Setting it implicitly enables tracing (e.g. `http://collector:4318`) |
| `JARVIS_OTEL_CONSOLE` | (off) | Print spans to stderr (verify/debug, no collector needed) |

### Auto mode (background scheduler)

| Var | Default | Notes |
|---|---|---|
| `JARVIS_WORK_MODE` | `off` | Set `auto` to enable the auto loop |
| `JARVIS_WORK_TICK_SECONDS` | `30` | Scheduler tick interval |
| `JARVIS_WORK_MAX_UNITS_PER_TICK` | `1` | Per-tick burst budget |
| `JARVIS_WORK_MAX_RETRIES` | `1` | Retry ceiling per requirement |
| `JARVIS_WORK_RUN_TIMEOUT_MS` | `600000` | Wall-clock budget per agent run; the watchdog reaps stuck Pending after this and stuck Running after `× 3` |
| `JARVIS_WORKTREE_MODE` | `off` (auto upgrades to `per_run`) | `off` / `per_run` / `per_unit` |
| `JARVIS_WORKTREE_ROOT` | `.jarvis/worktrees` | Where per-run git worktrees live |

### Logging

There is no log-level env var to set. Jarvis logs to the console (stdout/stderr)
in plain text — capture it with `docker compose logs` or your container
platform's log driver and ship from there to Loki / CloudWatch / a stdout
sidecar. For structured traces, enable OpenTelemetry (see above).

---

## Health and observability

- `GET /health` — `{"status":"ok"}`. Always available, no auth, no provider
  required. Wired up as the Docker `HEALTHCHECK`.
- `GET /v1/diagnostics/runs/stuck?threshold_seconds=3600` — list of runs
  that have been Pending/Running past the threshold. The auto-mode
  watchdog auto-reaps these, but the endpoint is the manual escape hatch.
- `GET /v1/diagnostics/worktrees/orphans` — list of on-disk worktrees
  whose run row has been deleted; `POST .../cleanup` removes them.
- `GET /v1/diagnostics/runs/failed?limit=20` — recent failed runs,
  newest-first, for paging-duty / dashboards.
- `GET /v1/diagnostics/memory` — memory backend telemetry.

For span-level tracing, enable OpenTelemetry (`JARVIS_OTEL_ENABLED` /
`JARVIS_OTEL_CONSOLE`). The performance baseline + how to reproduce it
(`make perf`) is documented in
[`docs/observability/perf-baseline.md`](docs/observability/perf-baseline.md).

---

## Upgrading

```bash
git pull
docker compose up -d --build
```

The JSON store schema is forward-compatible. SQL backends auto-migrate on
startup. Conversations whose key starts with `__memory__.` are internal summary
caches and are filtered out of `GET /v1/conversations` — they survive
upgrades cleanly.

---

## Troubleshooting

- **The UI 404s / the page is blank.** `JARVIS_WEB_DIST` isn't pointed at a
  built bundle. Run `make web` (or `make dev`, which builds it first), or use
  the multi-stage Dockerfile, which copies the bundle in for you.
- **`shell.exec` returns "tool denied"** — `JARVIS_ENABLE_SHELL_EXEC` is
  off, or `JARVIS_PERMISSION_MODE=ask` is rejecting the call. Check the
  WS frame for the synthetic `tool denied: <reason>` message.
- **`http.fetch` can't reach a local server.** The SSRF guard blocks
  loopback / private / metadata hosts by default. Set
  `JARVIS_HTTP_ALLOW_PRIVATE=1` only if the agent genuinely needs to reach
  localhost dev servers.
- **Auto mode picks nothing up.** All the guards must clear: triage
  state Approved, assignee set, depends_on done, no in-flight run, and
  failed_count below max_retries. Enable `JARVIS_OTEL_CONSOLE=1` (or watch the
  console logs) to see the per-tick decisions.
- **Native module fails to load in the image** (`better-sqlite3` / `node-pty`).
  The `deps` stage installs `python3 make g++` to build them; make sure
  BuildKit is enabled (`DOCKER_BUILDKIT=1`, default in modern Docker) so the
  pnpm store cache mount persists across rebuilds.
