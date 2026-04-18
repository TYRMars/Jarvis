# Database

Persistence lives in the `harness-store` crate. `harness-core` only defines
the `ConversationStore` trait; everything concrete is here. Higher layers
open a store via `harness_store::connect(url)` and receive an
`Arc<dyn ConversationStore>` — they never name the backend type directly.

See `ARCHITECTURE.md` for how persistence fits into the overall system.

## Selecting a backend

Driver selection is **compile-time** (cargo features on `harness-store`)
and **runtime** (URL scheme):

| feature    | URL prefixes                    | backend            |
|------------|---------------------------------|--------------------|
| `sqlite`   | `sqlite:`, `sqlite::memory:`    | SQLite (default)   |
| `postgres` | `postgres://`, `postgresql://`  | Postgres           |
| `mysql`    | `mysql://`, `mariadb://`        | MySQL / MariaDB    |

Only `sqlite` is on by default. Enable others at the binary level, e.g.:

```toml
# apps/jarvis/Cargo.toml
harness-store = { workspace = true, features = ["postgres"] }
```

`harness-store` also ships `MemoryConversationStore` (always compiled) for
tests and examples. It isn't selectable via `connect()` by design — wire
it up directly.

## Wire-up in the binary

Set `JARVIS_DB_URL` and `apps/jarvis` opens the store at startup and
places it on `AppState`:

```bash
JARVIS_DB_URL=sqlite://./jarvis.db cargo run -p jarvis
```

No HTTP handler reads the store yet — that's the next increment. The
trait and the `AppState` slot are ready; endpoints that save / load /
list / delete conversations by id plug into `routes.rs`.

## Schema

Every backend uses the same shape — a single table storing each
conversation as a JSON blob plus RFC-3339 timestamp strings. The
`harness-core` public API deliberately avoids naming a time crate; ISO
strings cross the boundary cleanly.

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
