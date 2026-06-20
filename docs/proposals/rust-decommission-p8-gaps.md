# P8 · Rust decommission — `/v1` contract gap inventory

**Goal:** make the Node server (`packages/server`) a drop-in replacement for the
Rust server (`crates/harness-server`) on the `/v1` surface so the Rust service
can be turned off (tasklist [P8.1/8.2](nodejs-rewrite-tasklist.zh-CN.md)).

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
| `GET /v1/conversations` (**divergent** — needs title extraction + source/requirement enrichment + `lifecycle` + `workspace_path`; today Node returns the bare store list) | web sidebar **+ iOS** | L | ☐ |
| `GET /v1/server/info` (runtime config snapshot, ~15 fields, no secrets) | web Settings·ServerSection, ContextWindowBadge, SDK | M | ☐ |
| `GET /v1/tools` + `PATCH /v1/tools/:name` (catalog + mute toggle) | web Settings·ToolsSection | M+S | ✅ done (`cacbb54`) |
| `POST /v1/providers/:name/probe` (connectivity ping) | web Settings·ProvidersSection | M | ☐ |
| `GET/PUT /v1/routing` + `PATCH/DELETE /v1/routing/:slot` (ModelRoutePolicy CRUD) | web Settings·RoutingSection | S×4 | ☐ — needs a `ModelRoutePolicy` AppState holder; risk of being **hollow** until Node's subagent/summariser model-selection reads it |
| `GET/POST /v1/mcp/servers`, `PUT/DELETE /v1/mcp/servers/:prefix`, `POST …/:prefix/health`, `…/reload` | web Settings·McpSection | M×6 | ☐ — greenfield; needs an AppState MCP **manager** (spawn/track/mute/health), then routes are thin |
| `GET /v1/chat/runs`, `…/:conversation_id/events`, `POST …/:conversation_id/interrupt` | web turn-status badge + Stop | S×3 | ☐ |
| `GET /v1/workspace`, `GET /v1/workspace/probe`, `POST /v1/workspace/commit`, `GET /v1/workspace/pr/preview`, `POST /v1/workspace/pr` | web WorkspaceBadge + Commit/PR dialogs | S–M | ☐ — Node already has the workspace terminal PTY route |
| `GET /v1/memory/sync_status`, `POST /v1/memory/sync`, `…/sync_setup`, `…/sync_setup_icloud`; `GET/POST/DELETE /v1/memory/includes`, `POST …/includes/refresh` | web MemorySyncSection + MemoryIncludesPanel | M each | ☐ — thin passthroughs; the work is porting the memory git/iCloud + include **tools** |
| `GET /v1/conversations/:id/work-context`, `POST /v1/conversations/:id/lifecycle` | web | M | ☐ — share the conversation-load/enrichment helper with the list route |
| `POST /v1/requirements/:id/conversations`, `…/todos` CRUD, `POST /v1/runs/:id/verify` + `/verification` | web Projects/RequirementDetail | S–L | ☐ |

## Operator-only / low priority (no client found, or degrades gracefully)

- `GET /v1/openapi.json` (L) — SDK-generation only; no UI break.
- `GET /v1/model-catalog` (M) — web currently uses `/v1/providers`, not this.
- `POST /v1/roadmap/import` (M) — no web/iOS caller (CLI/tool only); needs the
  `harness-requirement` roadmap port.
- `GET /v1/conversations/search` (M) — QuickSwitcher; degrades to "no results".
- `DELETE /v1/runs/:id/worktree` (S), project-memory editor tail — niche.

## Recommended order

1. **`GET /v1/conversations` enrichment** — the only blocker that breaks *two*
   clients and is divergent (silent wrong shape, not a 404). Get the
   conversation-load + requirements-join helper right once; `work-context` and
   `lifecycle` reuse it.
2. **All-S clusters for fast visible progress:** chat-runs (`runs`/`events`/
   `interrupt`) and the workspace git reads (`workspace` + `probe`).
3. **MCP manager** abstraction in AppState → the six `/v1/mcp/servers*` routes.

After those, the remainder is mechanical: `server/info`, `providers/:name/probe`,
the workspace commit/PR cluster, and the memory-sync tool passthroughs.
