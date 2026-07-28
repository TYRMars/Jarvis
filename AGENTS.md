# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

> **⚠️ Runtime is Node/TypeScript — Rust fully decommissioned (P8).** This file
> is a short orientation for Codex; **[CLAUDE.md](CLAUDE.md) is the authoritative,
> up-to-date guide** (full package layout, env vars, architecture). The old Rust
> Cargo workspace was removed (history tag `rust-archive-pre-takedown`).

## Project Overview

Jarvis is a Node/TypeScript agent runtime organised as a **pnpm workspace** around a
small, runtime-independent harness. The single design rule: **`@jarvis/core` knows
nothing about HTTP, providers, storage, or MCP** — it owns only the agent loop and the
interfaces everything else implements. Sibling packages plug in; `packages/jarvis-app/src/main.ts`
is the sole composition root (the only place that reads `process.env`).

## Workspace layout

Libraries live under `packages/*` (published internally as `@jarvis/<name>`): `core`,
`llm`, `router`, `mcp`, `memory`, `server`, `store`, `tools`, `project`, `workflow`,
`channel`, `skill`, `subagents`, `learning`, `automation`, `observability`, `plugin`,
`connectors`, `agent-profile`, `todo`, `shared-types`, plus `jarvis-app` (server +
composition root) and `jarvis-cli`. Apps live under `apps/`: `jarvis-web` (React 19 +
Vite SPA), `jarvis-desktop` (Tauri), `jarvis-ios`. New libraries go under `packages/*`
and are picked up by `pnpm-workspace.yaml`. See **CLAUDE.md** for the per-package detail.

## Commands

```bash
make check                                   # pnpm -r typecheck + lint + test (what CI runs)
make typecheck                               # tsc --noEmit per package
make lint                                    # eslint . (the CI gate)
make test                                    # node --test per package
pnpm --filter @jarvis/core test              # one package
node --experimental-strip-types packages/jarvis-app/src/main.ts serve   # run the server (needs OPENAI_API_KEY)
```

Runtime is Node ≥ 22.6 (`--experimental-strip-types` runs the TS sources with no build
step). **eslint is the gate.** The web SPA (`apps/jarvis-web`) is a standalone npm app
built into `dist/` and served by the Node server.

Common env vars (the full, authoritative list is in [CLAUDE.md](CLAUDE.md)):
`OPENAI_API_KEY` (required unless the `mcp-serve` subcommand is used),
`JARVIS_MODEL`, `OPENAI_BASE_URL`, `JARVIS_ADDR` (default `0.0.0.0:7001`),
`JARVIS_FS_ROOT` (default `.`, sandboxes `fs.*` tools),
`JARVIS_ENABLE_FS_WRITE` (any value opts into `fs.write`),
`JARVIS_MCP_SERVERS` (comma-separated `prefix=command args...` list of
external MCP servers to spawn and adapt into Tools),
`JARVIS_DB_URL` (optional; opens a `ConversationStore` at startup — scheme
picks backend: `json:` (default), `sqlite:`, `postgres://`, `mysql://`).

The `mcp-serve` subcommand runs the server as an MCP server on stdio,
exposing the local ToolRegistry — no LLM/HTTP setup is performed.

## Architecture

The architecture is documented authoritatively in **[CLAUDE.md](CLAUDE.md)** — read it
there rather than duplicating it here. It covers the harness loop (`@jarvis/core`'s
`Agent.run` / `Agent.runStream`), the `Tool` / `ToolRegistry` surface + MCP bridge, the
`LlmProvider` implementations, the Fastify HTTP server and `/v1` route modules, the
plan/progress/approval channels, short-term memory, and persistence (JSON-file by default;
SQLite / Postgres / MySQL selected by the `JARVIS_DB_URL` scheme).

**Composition root:** `packages/jarvis-app/src/main.ts` is the only place that reads env
vars, picks default models, and wires tools (subcommands: serve / mcp-serve / init / login /
status / workspace). Library packages under `packages/*` must not read `process.env` — an
eslint rule enforces this; the composition root is the sole exception.

## Conventions

- **Library packages never read `process.env`.** Configuration is injected from the
  `packages/jarvis-app` composition root; an eslint `no-restricted-properties` rule
  enforces this for `packages/**` (composition roots are exempt).
- **Errors:** library code returns/throws typed errors from `@jarvis/core`; provider
  failures are wrapped (e.g. `Error.Provider`) rather than leaking transport errors.
- **eslint is the gate.** `make lint` (`eslint .`) must pass clean; CI runs the same.
  Also keep `make typecheck` (tsc) + `make test` green — `make check` runs all three.
- **Streaming lives on its own method.** `LlmProvider.completeStream` parallels
  `complete`; don't retrofit `complete`'s return type. New providers can skip it — the
  default wraps `complete` and emits a single `Finish` chunk.
- **Tool naming collisions** are silent — registering two tools with the same `name`
  overwrites; prefer unique, namespaced names (`fs.read`, `http.fetch`).
- **Wire-shape types** live in `@jarvis/shared-types` (the single source of truth for
  types crossing the SPA boundary).
