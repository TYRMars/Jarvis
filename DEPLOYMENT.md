# Deployment Guide

How to run Jarvis somewhere other than `cargo run`. Three deployment shapes,
ordered from "trying it out" to "running it for real".

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
make web        # build the React bundle into apps/jarvis-web/dist
make build      # release-build target/release/jarvis (embeds the bundle)

OPENAI_API_KEY=sk-... \
JARVIS_FS_ROOT=$PWD \
./target/release/jarvis serve
```

Or, in dev (debug build, slower but rebuilds fast):

```bash
make dev        # cargo run -p jarvis (assumes web is prebuilt or stale)
```

Two-process dev workflow with hot-reload on the UI:

```bash
make web-dev    # terminal 1 — Vite dev server on :5173 (proxies API to :7001)
make dev        # terminal 2 — Rust server on :7001
```

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

Anatomy of the image:

| Stage | What it does |
|-------|--------------|
| `web`     | `npm ci && npm run build` → `apps/jarvis-web/dist/` |
| `rust`    | `cargo build --release -p jarvis` (with BuildKit cache mounts) |
| `runtime` | `debian:bookworm-slim` + `git`, `ca-certificates`, `libssl3`, `tini`, `curl`. Runs as non-root user `jarvis` (uid 10001). |

The binary is **self-contained** — the React bundle is baked in via Rust's
`include_dir!`. No nginx, no separate static-file server.

Two volumes the runtime expects:

- `/data` — persistent state. Default `JARVIS_DB_URL` writes JSON files
  under `$HOME/.local/share/jarvis/conversations/`, where `$HOME=/data`.
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

### Switching to Postgres

The default JSON-file backend is fine up to a few thousand conversations.
For larger fleets or multi-instance deploys, switch to Postgres:

1. Rebuild the image with the cargo feature enabled. Edit `Dockerfile`'s
   stage 2 build line to read:
   ```dockerfile
   cargo build --release --locked -p jarvis --features postgres
   ```
   (or pass `--build-arg` and parameterise — left as an exercise so this
   guide doesn't drift.)
2. Uncomment the `postgres` service in `docker-compose.yml` and the
   matching `JARVIS_DB_URL: "postgres://..."` line.
3. `docker compose up -d --build`.

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

### Persistence

| Var | Default | Notes |
|---|---|---|
| `JARVIS_DB_URL` | `json://...` | Scheme picks backend: `json:` (always available) / `sqlite:` / `postgres:` / `mysql:` (cargo features) |
| `JARVIS_DISABLE_TODOS` | (off) | Set any value to disable the project TODO board |

### Permissions / tool gates

| Var | Default | Notes |
|---|---|---|
| `JARVIS_PERMISSION_MODE` | `ask` | `ask` / `accept-edits` / `plan` / `auto` / `bypass` |
| `JARVIS_ENABLE_FS_WRITE` | (off) | Any value enables `fs.write` |
| `JARVIS_ENABLE_FS_EDIT` | (off) | Any value enables `fs.edit` |
| `JARVIS_ENABLE_FS_PATCH` | (off) | Any value enables `fs.patch` |
| `JARVIS_ENABLE_SHELL_EXEC` | (off) | Any value enables `shell.exec` |
| `JARVIS_DISABLE_GIT_READ` | (off) | Set to drop the read-only `git.*` toolset (e.g. when `git` isn't on PATH) |

### Auto mode (background scheduler)

| Var | Default | Notes |
|---|---|---|
| `JARVIS_WORK_MODE` | `off` | Set `auto` to enable the auto loop |
| `JARVIS_WORK_TICK_SECONDS` | `30` | Scheduler tick interval |
| `JARVIS_WORK_MAX_UNITS_PER_TICK` | `1` | Concurrency cap per tick |
| `JARVIS_WORK_MAX_RETRIES` | `1` | Retry ceiling per requirement |
| `JARVIS_WORK_RUN_TIMEOUT_MS` | `300000` | Wall-clock budget per agent run; the watchdog reaps stuck Pending after this and stuck Running after `× 3` |
| `JARVIS_WORKTREE_MODE` | `off` (auto upgrades to `per_run`) | `off` / `per_run` |
| `JARVIS_WORKTREE_ROOT` | `.jarvis/worktrees` | Where per-run git worktrees live |

### Logging

| Var | Default | Notes |
|---|---|---|
| `RUST_LOG` | `jarvis=info,harness_server=info` (in image) | Standard `tracing-subscriber` filter syntax |

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

Logs are JSON-friendly when `RUST_LOG_FORMAT=json` (set on the binary's
side via `tracing-subscriber`'s env-filter) — useful when shipping to
Loki / CloudWatch / a stdout sidecar.

---

## Upgrading

```bash
git pull
docker compose up -d --build
```

The JSON store schema is forward-compatible. SQL backends auto-migrate on
startup; `JARVIS_DB_URL` rows referenced by migrations are added in-place.
Conversations whose key starts with `__memory__.` are internal summary
caches and are filtered out of `GET /v1/conversations` — they survive
upgrades cleanly.

---

## Troubleshooting

- **`error: include_dir! could not find ...dist`** at compile time. The
  Vite bundle wasn't built before `cargo build`. Run `make web` first or
  use the multi-stage Dockerfile, which orders this correctly.
- **`shell.exec` returns "tool denied"** — `JARVIS_ENABLE_SHELL_EXEC` is
  off, or `JARVIS_PERMISSION_MODE=ask` is rejecting the call. Check the
  WS frame for the synthetic `tool denied: <reason>` message.
- **Auto mode picks nothing up.** All five guards must clear: triage
  state Approved, assignee set, depends_on done, no in-flight run,
  failed_count below max_retries. Lift `RUST_LOG=harness_server::auto_mode=debug`
  to see the per-tick decisions.
- **Image rebuild is slow.** Make sure BuildKit is enabled
  (`DOCKER_BUILDKIT=1`, default in modern Docker) so the cache mounts
  in stage 2 actually persist.
