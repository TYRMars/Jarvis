# P8 · Rust decommission — `/v1` contract gap inventory

> **✅ DONE — Rust decommissioned (P8.2).** All blocker-priority gaps below are
> closed (or graceful-stubbed for memory-sync); the Node server passes its full
> test gate and the Rust crates/apps were removed (tag
> `rust-archive-pre-takedown`). Node is the sole runtime. Remaining P8 items are
> non-blocking: 8.3 perf/load compare, 8.4 OTel verify, 8.5 docs rewrite,
> 8.6 security baseline, and the full memory-sync git/iCloud subsystem (below).

**Goal:** make the Node server (`packages/server`) a drop-in replacement for the
Rust server on the `/v1` surface so the Rust service can be turned off
(tasklist [P8.1/8.2](nodejs-rewrite-tasklist.zh-CN.md)).

**Method:** route-by-route diff of Rust vs Node registrations, each gap tagged
with the real client that consumes it (web SPA / iOS / SDK), a port-size, and a
priority. A gap is a **blocker** only when a real client breaks if Rust is off.
Source: contract audit on the `feat/node-rust-decommission` branch (70 raw
gaps; deduped below). Re-run by grepping `.route(`/`app.<method>(` paths in both
trees + grepping `apps/jarvis-web/src` for the path.

> **Note on shapes:** after Rust is gone the *web client* is the contract. Match
> what the web service-layer files (`apps/jarvis-web/src/services/*.ts`) expect.

---

## Decommission blockers (a real web/iOS client breaks if Rust is off)

| Route | Client | Size | Status |
|-------|--------|------|--------|
| `GET /v1/conversations` (**divergent** — title/source/requirement/lifecycle/workspace_path enrichment) | web sidebar **+ iOS** | L | ✅ done (`849a784`) |
| `GET /v1/conversations/:id/work-context`, `POST /v1/conversations/:id/lifecycle` | web | M | ✅ done (`849a784`) |
| `GET /v1/tools` + `PATCH /v1/tools/:name` (catalog + mute toggle) | web Settings·ToolsSection | M+S | ✅ done (`cacbb54`) |
| `GET/POST /v1/mcp/servers`, `PUT/DELETE /v1/mcp/servers/:prefix`, `POST …/:prefix/{health,reload}` | web Settings·McpSection | M×6 | ✅ done (`2975613`) |
| `GET /v1/chat/runs`, `…/:conversation_id/events`, `POST …/:conversation_id/interrupt` | web turn-status badge + Stop | S×3 | ✅ done (`58fab49`; interrupt cooperative) |
| `GET /v1/workspace`, `GET /v1/workspace/probe` | web WorkspaceBadge + folder picker | S | ✅ done (`039aecc`) |
| `POST /v1/workspace/commit`, `GET /v1/workspace/pr/preview`, `POST /v1/workspace/pr` | web Commit/PR dialogs | M | ☐ — shell out to git + `gh` |
| `GET /v1/server/info` (runtime config snapshot, ~15 fields, no secrets) | web Settings·ServerSection, ContextWindowBadge, SDK | M | ☐ |
| `POST /v1/providers/:name/probe` (connectivity ping) | web Settings·ProvidersSection | M | ☐ |
| `GET/PUT /v1/routing` + `PATCH/DELETE /v1/routing/:slot` (ModelRoutePolicy CRUD) | web Settings·RoutingSection | S×4 | ☐ — needs a `ModelRoutePolicy` AppState holder; risk of being **hollow** until Node's subagent/summariser model-selection reads it |
| `GET /v1/memory/sync_status`, `POST /v1/memory/sync`, `…/sync_setup`, `…/sync_setup_icloud`; `GET/POST/DELETE /v1/memory/includes`, `POST …/includes/refresh` | web MemorySyncSection + MemoryIncludesPanel | M each | ☐ — thin passthroughs; the work is porting the memory git/iCloud + include **tools** |
| `POST /v1/requirements/:id/conversations`, `…/todos` CRUD, `POST /v1/runs/:id/verify` + `/verification` | web Projects/RequirementDetail | S–L | ☐ |

## Operator-only / low priority (no client found, or degrades gracefully)

- `GET /v1/openapi.json` (L) — SDK-generation only; no UI break.
- `GET /v1/model-catalog` (M) — web currently uses `/v1/providers`, not this.
- `POST /v1/roadmap/import` (M) — no web/iOS caller (CLI/tool only); needs the
  `harness-requirement` roadmap port.
- `GET /v1/conversations/search` (M) — QuickSwitcher; degrades to "no results".
- `DELETE /v1/runs/:id/worktree` (S), project-memory editor tail — niche.

## Landed (branch `feat/node-rust-decommission`)

`GET /v1/tools` + mute, `GET /v1/conversations` enrichment + `work-context` +
`lifecycle`, chat-runs (`runs`/`events`/`interrupt`), workspace git reads
(`workspace` + `probe`), and the MCP manager + six `/v1/mcp/servers*` routes.
Plus the P7.9 foundation: wire types own-sourced in `@jarvis/shared-types` and
the Rust `ts_rs` codegen removed.

## Remaining order

1. **Mechanical reads/toggles:** `GET /v1/server/info` (config snapshot),
   `POST /v1/providers/:name/probe`. Independent, M each.
2. **`/v1/routing` ×4** — small, but wire the `ModelRoutePolicy` into Node's
   subagent/summariser model-selection so it isn't hollow.
3. **Workspace commit/PR cluster** (git + `gh`) and the **memory-sync tool
   passthroughs** (the work is porting the underlying memory git/iCloud tools).
4. **Requirement todos / run verify** + the low-priority operator routes.

When the blocker rows are all ✅, do **P8.2**: flip the default backend to Node,
archive the Rust crates (keep git history), and run the iOS/web contract smoke
tests against Node as the cutover gate.
