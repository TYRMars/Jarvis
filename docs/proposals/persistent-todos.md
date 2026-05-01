# Persistent project TODO board

**Status:** Adopted (initial cut shipped).
**Touches:** new `harness_core::todo` module + `TodoStore` trait,
new `*TodoStore` impls in `harness-store` (memory / json-file /
sqlite / postgres / mysql), new `harness_tools::todo` (`todo.list` /
`add` / `update` / `delete`), new `harness_server::todos_routes`
(REST `/v1/todos` family) + WS bridge for `todo_upserted` /
`todo_deleted`, new `apps/jarvis-web` panel `TodosRail.tsx`,
composition wiring in `apps/jarvis/src/serve.rs`.

## Motivation

`plan.update` (per-turn ephemeral checklist via the
`harness_core::plan` task-local channel) is great for showing the
agent's *current working steps*, but it's wiped on every reset and
doesn't survive a restart. Real Work sessions, long Chat threads,
and Doc drafting flows need a separate **long-lived backlog** the
agent and the human can both edit:

- During a long refactor, the agent surfaces follow-ups (`"add a
  test for the negative branch"`, `"run cargo udeps"`) that
  shouldn't pollute the per-turn plan but can't be lost either.
- The human jots project ideas in advance and wants the agent to
  see them next turn.
- The list outlives `Reset`, conversation deletion, and process
  restarts.

`plan.update` stays for the per-turn working checklist. This
proposal adds a *parallel* persistent surface; nothing replaces.

## Product alignment

Under the Chat / Work / Doc product design, the TODO board is the
already-shipped lightweight backlog for **Work**. It also appears in
Chat as "save this for later" and in Doc as extracted action items,
but Work owns the durable task lifecycle above it:

- Chat message → TODO.
- TODO → Work task.
- Work run → follow-up TODO.
- Doc action item → TODO / Work task.

This proposal should stay intentionally small. It is not the Work
state machine and should not grow milestones, verification, runs, or
artifact management; those belong to `work-orchestration.zh-CN.md`.

## Non-goals

- Multi-tenant ownership keys on TODOs (single-user assumption holds).
- Rich-text bodies, attachments, threaded comments — TODOs are a
  flat list, not an issue tracker.
- Sync to GitHub Issues / Linear (a future MCP server can do that
  on top of the existing tools).

## Wire model

`TodoItem` is the row shape. Stable, JSON-serialised:

```rust
pub struct TodoItem {
    pub id: String,           // UUID v4, server-allocated
    pub workspace: String,    // canonicalised absolute path
    pub title: String,
    pub status: TodoStatus,   // see below
    pub notes: Option<String>,
    pub created_at: String,   // RFC-3339
    pub updated_at: String,   // RFC-3339
}

pub enum TodoStatus {
    Pending, InProgress, Completed, Cancelled, Blocked,
}
```

Wire format: snake_case for status (`"pending"` /
`"in_progress"` / `"completed"` / `"cancelled"` / `"blocked"`),
identical to `PlanStatus` plus a new `Blocked`. `notes` is
`#[serde(skip_serializing_if = "Option::is_none")]` so future
fields can be added without breaking clients.

`TodoEvent` is the broadcast envelope:

```rust
pub enum TodoEvent {
    Upserted(TodoItem),
    Deleted { workspace: String, id: String },
}
```

WS sessions filter by `event.workspace()` against their pinned
root; multi-window UIs targeting different workspaces don't
cross-contaminate.

## Storage

`TodoStore` trait (in `harness_core::store`):

```rust
#[async_trait]
pub trait TodoStore: Send + Sync {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError>;
    async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError>;
    async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
    fn subscribe(&self) -> broadcast::Receiver<TodoEvent>;
}
```

Five backends in `harness-store`. **JSON-file is the default**;
SQL backends are opt-in cargo features (`--features sqlite` /
`postgres` / `mysql`) so the zero-config build doesn't pull in
sqlx and friends:

| backend | URL prefix | feature flag | impl |
|---|---|---|---|
| memory | (test-only) | always-on | `MemoryTodoStore` |
| json-file | `json:` | **default**, always-on | `JsonFileTodoStore` — `<base>/todos/<encode_id(workspace)>/<encode_id(id)>.json` |
| sqlite | `sqlite:` / `sqlite::memory:` | `sqlite` (opt-in) | `SqliteTodoStore` |
| postgres | `postgres://` / `postgresql://` | `postgres` (opt-in) | `PostgresTodoStore` |
| mysql | `mysql://` / `mariadb://` | `mysql` (opt-in) | `MysqlTodoStore` |

SQL backends share the existing pool with the conversation /
project stores. The `migrate()` function in each backend was
extended to also create a `todos(id PK, workspace, title, status,
notes NULL, created_at, updated_at)` table + index on `workspace`.
`StoreBundle::todos: Arc<dyn TodoStore>` is populated alongside
`conversations` / `projects` in `connect_all`.

**Single broadcast path.** Every backend exposes `subscribe()`
returning `broadcast::Receiver<TodoEvent>`. Both REST handlers and
the agent's `todo.*` tools call store mutators, which fan out to
subscribers. There is **no** `AgentEvent::TodoUpdate` — the agent
loop stays uninvolved, which avoids the duplicate-emit bug a
parallel agent-side path would create.

## Tools

`harness_tools::todo` ships four tools, all
`ToolCategory::Read` (no approval gate — TODOs are metadata):

| name | params | notes |
|---|---|---|
| `todo.list` | `{workspace?: string}` | Defaults to active workspace. |
| `todo.add` | `{title, status?, notes?, workspace?}` | Server-allocated UUID. |
| `todo.update` | `{id, title?, status?, notes?}` | Empty-string `notes` clears the note. |
| `todo.delete` | `{ids: string[]}` | Capped at **50 ids** per call. |

Mass-delete protection lives in the input schema: the `ids` array
is required (no wildcard `{all: true}`). Operators wanting stricter
control can attach a `RuleApprover` rule for `todo.*`.

Tools register conditionally — `BuiltinsConfig::todo_store =
Some(...)` enables them. Without a store the tools are
unregistered (the model just can't see them); we do **not**
silently fall back to in-memory storage, which would defeat the
persistence promise.

Each tool resolves its workspace key per-invocation via
`harness_core::active_workspace_or(default_root)` →
`canonicalize_workspace(...)`. A single agent process serving WS
sockets pinned to different roots stays cleanly partitioned.

## REST + WS

```
GET    /v1/todos?workspace=<abs>
POST   /v1/todos                  body: {title, status?, notes?, workspace?}
PATCH  /v1/todos/:id              body: {title?, status?, notes?}
DELETE /v1/todos/:id
```

All return `503` when `AppState::todos` is `None` — same
convention as `/v1/permissions` / `/v1/projects`.

WS frames sent on the existing chat socket (`/v1/chat/ws`):

- `{"type":"todo_upserted","todo":TodoItem}` — fired on every
  upsert (REST or tool).
- `{"type":"todo_deleted","id":"...","workspace":"..."}` — fired on
  every successful delete.

Both filtered by socket workspace before send.

## Composition root

`apps/jarvis/src/serve.rs`:

- Persistence is opened *before* `register_builtins` so the
  todo store can flow into `BuiltinsConfig::todo_store`.
- **Default URL**: when neither `JARVIS_DB_URL` nor
  `[persistence].url` is configured, falls back to
  `json:///<XDG_DATA_HOME or ~/.local/share>/jarvis/conversations`.
  Out-of-the-box deployments are persistent without any setup.
- `JARVIS_DISABLE_TODOS=1` opts out of the TODO board even when a
  store is configured.
- `AppState::with_todo_store(...)` plugs the same handle into
  REST + WS.

```bash
# Default: JSON-file at ~/.local/share/jarvis/conversations
cargo run -p jarvis -- serve --workspace ~/code/myproj

# Opt in to SQLite when a real DB makes sense:
JARVIS_DB_URL=sqlite:/path/to.db \
  cargo run -p jarvis --features sqlite -- serve --workspace ~/code/myproj
```

## Web UI

`apps/jarvis-web/src/components/Workspace/TodosRail.tsx` is the
new panel — distinct from `PlanList.tsx`. Add via the workspace
panel menu; hydrates from `GET /v1/todos` on mount, updates live
via the WS `todo_upserted` / `todo_deleted` frames the chat
socket already streams. Inline add form, click-to-cycle status,
delete button.

## Safety model

- TODOs are metadata — no approval gate.
- Mass-delete cap (50 ids) in tool input schema.
- Mutation events filtered by socket workspace (no cross-contam).
- 503 when no store configured (no silent fallback).

## Verification

Backend:

- `cargo test --workspace` — new tests across `harness-core` (7),
  `harness-store` (10 across mem + sqlite + json-file), `harness-tools`
  (8), `harness-server` (4 axum integration). All green.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.

End-to-end smoke (manual, run from a temp workspace):

```bash
JARVIS_DB_URL=sqlite:/tmp/t.db cargo run -p jarvis -- \
  serve --workspace /tmp/myrepo &

curl -X POST localhost:7001/v1/todos \
  -d '{"title":"refactor parser"}' -H 'content-type: application/json'
curl localhost:7001/v1/todos
# Restart the server. Re-list. The row survives.
```

UI smoke: open the web UI, enable the TODOs panel from the panel
menu, add via the form, observe a `todo_upserted` frame on a
parallel WS connection.

## Future extensions (v2)

- Inject the current TODO list into the system prompt (read-only)
  so the model has cheap awareness without a tool call.
- `priority`, `due_date`, `tags` fields — wire-format already
  forward-compat via `#[serde(default, skip_serializing_if = "...")]`.
- Per-turn mutation budget enforced via `task_local` counter (the
  per-call `delete` cap covers the immediate spam vector; a
  per-turn `add`/`update` cap would round it out).
- Plugin / MCP bridge to GitHub Issues / Linear so a TODO can sync
  to an external tracker.
