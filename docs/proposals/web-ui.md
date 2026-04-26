# Minimal browser UI

**Status:** Adopted (initial implementation landed in `apps/jarvis-web/`
+ `crates/harness-server/src/ui.rs`; `include_dir!` bundling, three-
column layout, REST CRUD + WS interactive approval all working)
**Touches:** new `apps/jarvis-web/` (static assets), small change to
`harness-server` to mount them; no library changes.

## Motivation

The WS protocol carries everything a real product needs (streaming
output, interactive approval, persisted-conversation
resume/list/delete) but you can only test it with `wscat` today.
A small in-tree web UI does three things at once:

1. End-to-end smoke test for the WS protocol on every change.
2. Live demo for new users — `cargo run -p jarvis` and visit
   `localhost:7001/ui`.
3. Reference implementation for the SDKs proposed in
   [client-sdks.md](client-sdks.md).

Goal is **minimum-viable**, not a polished product. No framework
build step, no design system, no auth. ~600 lines of vanilla JS +
HTML + CSS, fits in three files.

## UX target

Single page, three columns:

```
┌─────────────────┬───────────────────────────────┬──────────────────┐
│  Conversations  │  Chat                         │  Approvals       │
│                 │                               │                  │
│  + new          │  user: read README            │  fs.edit         │
│                 │  assistant: …                 │  arguments {…}   │
│  → 7b6f… (3)    │  ▶ tool fs.read (12ms)        │  [approve][deny] │
│    a13c… (8)    │  user: now write a summary    │                  │
│    d802… (1)    │  assistant: …                 │                  │
│                 │  ⚠ awaiting approval          │                  │
│                 │  ┌──────────────────┐         │                  │
│                 │  │ type a message   │         │                  │
│                 │  └──────────────────┘         │                  │
└─────────────────┴───────────────────────────────┴──────────────────┘
```

Required:

- Pick / create / delete a conversation (left rail). `new` + `resume`
  WS frames + REST `GET /v1/conversations`.
- Live-streamed assistant output (token by token).
- Tool calls render as collapsible blocks: name, arguments, output.
- Pending `ApprovalRequest` events surface in the right rail with
  approve / deny buttons; clicking sends `{"type":"approve",
  "tool_call_id":...}` over the same socket.
- Errors (server-side or transport) surface as a banner.

Nice-to-have:

- Markdown rendering for assistant text.
- Syntax-highlighted code blocks.
- Light/dark toggle.
- "Always-allow this tool for this conversation" (mirrors CLI
  proposal).

## File layout

```
apps/jarvis-web/
  index.html        # single-page shell
  style.css         # ~150 LOC
  app.js            # WebSocket + REST client, render loop
  README.md         # how to dev locally
```

Bundled into the binary at build time via `include_dir!` (or just
read from disk in dev). `harness-server` adds one route:

```rust
// crates/harness-server/src/routes.rs
.nest_service("/ui", ServeDir::new("apps/jarvis-web"))
```

For release builds, switch to `axum::routing::get(static_handler)`
backed by `include_dir!` so the binary ships self-contained.

## Wire usage

The UI is a faithful WS client; no shape fanning-out. State machine:

```
[idle]
   ├── click `+ new` ──► POST /v1/conversations → id
   │                     ws send {"type":"new","id":id}
   │                     state = active(id)
   │
   ├── click row ───────► ws send {"type":"resume","id":id}
   │                     state = active(id)
   │
   └── (idle on first load: ws connected, no convo loaded)

[active]
   ├── type & enter ────► ws send {"type":"user","content":...}
   │                     state = waiting
   │
   └── ApprovalRequest ─► render in right rail (button enables)

[waiting]
   ├── Delta / ToolStart / ToolEnd / AssistantMessage / Approval*
   │                     append to chat pane
   ├── click approve/deny ► ws send {"type":"approve",...}
   ├── Done             ─► state = active(id)
   └── Error            ─► banner + state = active(id)
```

## REST surface used

- `POST /v1/conversations` — create (server-side allocates id).
- `GET  /v1/conversations?limit=50` — populate the rail.
- `DELETE /v1/conversations/:id` — delete-button confirm.
- `GET  /v1/conversations/:id` — used once on resume to render
  history before the WS catches up (the WS doesn't replay).

WS handles the rest.

## Auth / multi-user

**Out of scope.** No auth in the UI or the server today. If this UI
ships behind a reverse proxy with auth (nginx basic auth / Cloudflare
Access / similar), it works. Real auth is a separate, larger
proposal — and shouldn't live in the demo UI; it belongs to the
server.

## Implementation cuts

1. **Static asset mount.** Add `tower-http`'s `ServeDir`,
   `include_dir!`, route `/ui`. Empty `index.html` proves the wiring.
2. **WS connect + chat.** `app.js` opens WS, sends `user` frames,
   renders `Delta` events. No conversations sidebar yet.
3. **Tool rendering.** Collapsible blocks for `ToolStart` / `ToolEnd`.
4. **Conversation rail.** REST list/create/delete + WS resume/new.
5. **Approval pane.** Render `ApprovalRequest` → button → `approve`.
   Persistent "awaiting" indicator until matching `ApprovalDecision`.
6. *(Optional)* Markdown render via a tiny inline parser or `marked`
   from CDN.

## Risks / open questions

- **Bundle size.** Vanilla JS keeps it under 50 KB. If the UI grows,
  this proposal hits its ceiling and we'd want a real frontend
  project. The intent is to *not* let it grow.
- **CORS.** Bundled UI hits the same origin → no CORS issue. If
  someone wants to host the UI separately, the server needs a
  permissive `Access-Control-Allow-Origin` config — covered by a
  `tower_http::cors::CorsLayer`. Out of scope for the v0.
- **Reconnection.** First pass: page reload required if the WS drops.
  Auto-reconnect + replay-on-reconnect is meaningful but a follow-up.
- **History rendering on resume.** WS doesn't replay; we GET the
  conversation once on resume to backfill the chat pane. Make sure
  this matches what the user sees in subsequent live frames (no
  duplicates).

## Out of scope

- Auth / multi-tenant.
- File-tree / diff view (would push us toward a real bundler).
- Embedded code editor.
- Mobile layouts.
