# Database

Persistence lives in the `harness-store` crate. `harness-core` only defines
the `ConversationStore` trait; everything concrete is here. Higher layers
open a store via `harness_store::connect(url)` and receive an
`Arc<dyn ConversationStore>` — they never name the backend type directly.

See `ARCHITECTURE.md` for how persistence fits into the overall system.

## Selecting a backend

Driver selection is **compile-time** (cargo features on `harness-store`)
and **runtime** (URL scheme):

| feature    | URL prefixes                    | backend                  |
|------------|---------------------------------|--------------------------|
| (always on)| `json:`, `json://`              | JSON files in a directory — the `jarvis init` default |
| `sqlite`   | `sqlite:`, `sqlite::memory:`    | SQLite                   |
| `postgres` | `postgres://`, `postgresql://`  | Postgres                 |
| `mysql`    | `mysql://`, `mariadb://`        | MySQL / MariaDB          |

`json` and `sqlite` are on by default; enable Postgres / MySQL at the
binary level, e.g.:

```toml
# apps/jarvis/Cargo.toml
harness-store = { workspace = true, features = ["postgres"] }
```

`harness-store` also ships `MemoryConversationStore` (always compiled,
in-process only) for tests and examples. It isn't selectable via
`connect()` by design — wire it up directly.

### Why JSON is the default

Zero-dep, zero-setup, `cat conversations/<id>.json` debuggable, the
file is also the "git-friendly" format if anyone wants to commit
their convos. The trade-off: `list()` is O(N) file reads, so this
backend isn't right past a few hundred conversations. Switch to
sqlite for personal-but-heavy use; postgres / mysql for
multi-process / multi-server.

## Wire-up in the binary

Set `JARVIS_DB_URL` and `apps/jarvis` opens the store at startup and
places it on `AppState`:

```bash
# Default — JSON files
JARVIS_DB_URL=json:///Users/me/.local/share/jarvis/conversations cargo run -p jarvis

# Switch to sqlite when needed
JARVIS_DB_URL=sqlite://./jarvis.db cargo run -p jarvis
```

`jarvis init` writes the JSON URL into config.toml automatically
when the user opts into persistence.

The HTTP layer reads the store via `harness-server`'s
`/v1/conversations` CRUD routes plus the WebSocket `resume` / `new`
frames; see `CLAUDE.md` for the route shapes. `AppState` carries the
optional `Arc<dyn ConversationStore>` and routes return `503` when
no store is configured.

## Schema

All backends store the same logical shape — a record per conversation
with id + RFC-3339 timestamps + JSON messages. Layout differs:

### JSON file backend

One file per conversation in a directory.

```text
<dir>/
  <id>.json                # one per conversation
  <id>.json.tmp            # transient, only during writes
```

The id is the on-disk filename, percent-encoded for any byte that
isn't `[A-Za-z0-9._-]` (so internal `__memory__.summary:<hash>`
ids land as `__memory__.summary%3A<hash>.json`, safe on Windows).
File contents:

```json
{
  "id": "...",
  "created_at": "RFC-3339",
  "updated_at": "RFC-3339",
  "messages": [/* Vec<Message> */]
}
```

Atomic write: `<id>.json.tmp` then rename. Permissions on unix are
`0700` for the directory, `0600` for each file.

### SQL backends

```sql
-- sqlite / postgres
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    messages   TEXT NOT NULL,   -- JSON-serialised Conversation
    created_at TEXT NOT NULL,   -- RFC-3339
    updated_at TEXT NOT NULL    -- RFC-3339
);

-- mysql (TEXT can't be a primary key without a prefix length, and the
-- JSON payload can easily exceed TEXT's 64 KiB limit).
CREATE TABLE IF NOT EXISTS conversations (
    id         VARCHAR(255) NOT NULL PRIMARY KEY,
    messages   LONGTEXT     NOT NULL,
    created_at VARCHAR(64)  NOT NULL,
    updated_at VARCHAR(64)  NOT NULL
);
```

Upserts use the dialect-native path (`ON CONFLICT … DO UPDATE` on
SQLite / Postgres; `ON DUPLICATE KEY UPDATE` on MySQL) so `save()` is
idempotent for a given `id`.

Migrations are run idempotently inside each backend's `connect()`; there
is no separate migration tool today. When the schema grows (messages as
a child table, metadata columns, etc.) we'll switch to `sqlx migrate`
with a `migrations/` directory per backend.

## Trait surface

```rust
// harness-core
#[async_trait]
pub trait ConversationStore: Send + Sync {
    async fn save(&self, id: &str, c: &Conversation) -> Result<(), BoxError>;
    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError>;
    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}

pub struct ConversationRecord {
    pub id: String,
    pub created_at: String,   // RFC-3339
    pub updated_at: String,   // RFC-3339
    pub message_count: usize,
}
```

- `id` is opaque — the caller chooses (session UUID, user id, etc.).
- `save` is upsert: updating an existing id bumps `updated_at` and
  replaces the blob.
- `list` returns newest-first, capped at `limit`.
- `delete` returns `Ok(false)` for a missing id (never an error).

## Adding a backend

Copy the pattern from `crates/harness-store/src/sqlite.rs`:

1. New module `crates/harness-store/src/<backend>.rs` with a pool
   wrapper, an idempotent `migrate()`, and a `ConversationStore` impl
   that round-trips JSON + RFC-3339 timestamps.
2. Gate the module and its sqlx feature via a cargo feature in
   `crates/harness-store/Cargo.toml`.
3. Add a `match` arm for the URL scheme in `connect()` in
   `crates/harness-store/src/lib.rs`.
4. Add tests — mirror `sqlite.rs`'s in-module tests and the dispatcher
   test in `tests/connect.rs`. Skip Postgres / MySQL tests in CI if no
   server is available; use `#[ignore]` or env-gated `#[test]`s.

## Not yet persisted

Only `Conversation` has a store. The repository does **not** persist:

- Agent configuration / prompts / tool manifests (recreated on each
  boot from env vars + `register_builtins`).
- Tool call history separately from the embedded `Conversation` blob —
  it's all inside the JSON.
- Users, sessions, auth tokens, rate-limit counters, or any kind of
  memory tier.

These were all in the previous TypeScript codebase but were not carried
over. Treat that earlier schema as a feature inventory, not a design to
copy — most of those tables stored JSON blobs in `TEXT` columns anyway.
