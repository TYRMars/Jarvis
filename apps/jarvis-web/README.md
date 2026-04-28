# jarvis-web - browser client

Vite + React 19 + TypeScript client for the Jarvis HTTP/WebSocket UI.
The production build in `dist/` is loaded into the binary at compile
time via `include_dir!` and served from the server root `/` by
`harness-server`. Routing is handled client-side by `react-router-dom`
v7 (`/` → chat, `/settings` → settings center).

## Run

```
npm install
npm run build
cargo run -p jarvis
```

Then open `http://localhost:7001/`. The page connects to
`ws://localhost:7001/v1/chat/ws` and uses the REST CRUD endpoints
under `/v1/conversations/`. Persistence is optional: set
`JARVIS_DB_URL` to enable the conversation rail.

For frontend-only iteration:

```
npm run dev
```

The Vite dev server serves the same app shell with hot reload. Backend
API calls still expect Jarvis on port `7001`.

## Files

- `index.html` - Vite HTML entry with the React root.
- `src/main.tsx` - React mount and first-paint theme setup.
- `src/App.tsx` - current workspace shell markup.
- `src/styles.css` - responsive workbench layout and light/dark
  tokens.
- `src/legacy.ts` - WebSocket + REST client, render loop, model menu,
  account menu, and English/Chinese language switch. This file keeps
  the pre-migration controller intact while the UI is componentized
  incrementally.

## Edit

Use `npm run dev` while editing. Before rebuilding the Rust binary,
run `npm run build` so `apps/jarvis-web/dist/` contains the static
assets that `harness-server` embeds. Production builds stay on
`include_dir!` so a single binary ships self-contained.

## Wire shape

The client speaks the same protocol documented in `CLAUDE.md`:

- WS client → server: `{type: "user" | "reset" | "resume" | "new"
  | "approve" | "deny", ...}`.
- WS server → client: `AgentEvent` JSON variants (`delta`,
  `assistant_message`, `tool_start`, `tool_end`, `approval_request`,
  `approval_decision`, `done`, `error`) plus three control frames
  (`started`, `resumed`, `reset`).
- REST: `POST/GET/DELETE /v1/conversations[/:id]`.

No client-side schema validation — the harness is the source of truth.
