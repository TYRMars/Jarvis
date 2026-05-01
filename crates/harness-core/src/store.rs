//! Pluggable persistence for [`Conversation`](crate::Conversation)s and
//! [`Project`](crate::Project)s.
//!
//! `harness-core` defines only the traits and a few value types; concrete
//! backends live in `harness-store` so callers can pick SQLite, Postgres,
//! MySQL, JSON-file, or in-memory without paying for the others' deps.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::agent_profile::{AgentProfile, AgentProfileEvent};
use crate::conversation::Conversation;
use crate::doc::{DocDraft, DocEvent, DocProject};
use crate::error::BoxError;
use crate::project::Project;
use crate::requirement::{Requirement, RequirementEvent};
use crate::todo::{TodoEvent, TodoItem};

/// Summary record returned by [`ConversationStore::list`].
#[derive(Debug, Clone)]
pub struct ConversationRecord {
    pub id: String,
    /// ISO-8601 / RFC-3339 timestamps. We keep these as strings to avoid
    /// forcing a time crate into the public surface of `harness-core`.
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    /// Project this conversation is bound to, if any. Carried through
    /// the persistence layer so listings can filter by project without
    /// rehydrating each row.
    pub project_id: Option<String>,
}

/// Per-conversation metadata that lives alongside (but not inside) the
/// `Conversation` value type. Backends serialise this together with the
/// conversation but the harness-core agent loop never sees it.
///
/// Adding a new metadata field here is preferable to extending
/// [`Conversation`] — `Conversation` is a pure value type used by the
/// in-process [`Agent`](crate::Agent), and shouldn't accumulate
/// server / persistence concerns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConversationMetadata {
    /// Project this conversation is bound to, if any. `None` for "free
    /// chat" sessions.
    pub project_id: Option<String>,
}

impl ConversationMetadata {
    /// Convenience constructor for the common "bind to project X" case.
    pub fn with_project(project_id: impl Into<String>) -> Self {
        Self {
            project_id: Some(project_id.into()),
        }
    }
}

/// Persistence operations on conversations, keyed by an opaque id chosen
/// by the caller (e.g. a session UUID).
///
/// Implementations must be safe to share across tasks.
///
/// ## Envelope vs. legacy methods
///
/// The [`save_envelope`](Self::save_envelope) /
/// [`load_envelope`](Self::load_envelope) pair carries
/// [`ConversationMetadata`] alongside the conversation. The historical
/// [`save`](Self::save) / [`load`](Self::load) pair is preserved as a
/// thin default-implemented wrapper that uses an empty metadata bag, so
/// existing call sites keep working unchanged. New code (server
/// handlers, CLI subcommands) should prefer the envelope methods.
#[async_trait]
pub trait ConversationStore: Send + Sync {
    /// Insert or overwrite the conversation stored at `id`, *with*
    /// per-conversation metadata (project binding etc.).
    async fn save_envelope(
        &self,
        id: &str,
        conversation: &Conversation,
        metadata: &ConversationMetadata,
    ) -> Result<(), BoxError>;

    /// Load the conversation and its metadata at `id`, or `None` if
    /// absent.
    async fn load_envelope(
        &self,
        id: &str,
    ) -> Result<Option<(Conversation, ConversationMetadata)>, BoxError>;

    /// List up to `limit` conversations, newest first.
    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError>;

    /// Same as [`Self::list`] but filtered to a single project.
    /// Default impl scans `list(limit*4)` and filters in-process —
    /// acceptable for small stores; SQL backends should override with
    /// a `WHERE project_id = ?` query.
    async fn list_by_project(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<ConversationRecord>, BoxError> {
        let scan_limit = limit.saturating_mul(4).max(limit);
        let rows = self.list(scan_limit).await?;
        Ok(rows
            .into_iter()
            .filter(|r| r.project_id.as_deref() == Some(project_id))
            .take(limit as usize)
            .collect())
    }

    /// Delete the conversation at `id`. Deleting a non-existent id is a
    /// no-op and returns `Ok(false)`; deleting an existing row returns
    /// `Ok(true)`.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    // --- Backward-compatible wrappers -------------------------------------

    /// Insert or overwrite the conversation stored at `id`. Equivalent
    /// to [`save_envelope`](Self::save_envelope) with the default
    /// (empty) metadata.
    async fn save(&self, id: &str, conversation: &Conversation) -> Result<(), BoxError> {
        self.save_envelope(id, conversation, &ConversationMetadata::default())
            .await
    }

    /// Load the conversation at `id`, dropping the metadata. Equivalent
    /// to [`load_envelope`](Self::load_envelope) with the metadata
    /// discarded.
    async fn load(&self, id: &str) -> Result<Option<Conversation>, BoxError> {
        Ok(self.load_envelope(id).await?.map(|(c, _)| c))
    }
}

/// Persistence operations on [`Project`]s.
///
/// The store is the source of truth for project identity and
/// uniqueness. Slug uniqueness in particular is enforced here (via a
/// UNIQUE index in SQL backends, an in-memory check in the JSON / mem
/// backends): callers that race a `save` for the same slug get a
/// backend-specific conflict error from the second writer.
///
/// `delete` and `archive` are distinct: `archive` flips the soft-delete
/// flag (and is what the UI's "delete" button typically calls);
/// `delete` removes the row entirely. Higher layers should refuse to
/// hard-delete projects with bound conversations.
#[async_trait]
pub trait ProjectStore: Send + Sync {
    /// Insert or overwrite a project. The store is responsible for
    /// rejecting duplicate slugs (matching by slug across rows whose
    /// id differs from the incoming `project.id`).
    async fn save(&self, project: &Project) -> Result<(), BoxError>;

    /// Load by primary id (UUID). Returns `None` if absent.
    async fn load(&self, id: &str) -> Result<Option<Project>, BoxError>;

    /// Look up by slug. Returns `None` if absent. Slugs are unique so
    /// at most one row matches.
    async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError>;

    /// List projects, newest-updated first. When `include_archived` is
    /// `false`, soft-deleted projects are skipped.
    async fn list(&self, include_archived: bool, limit: u32) -> Result<Vec<Project>, BoxError>;

    /// Hard-delete a project row. Returns `true` if a row was removed.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Soft-delete: flip `archived = true` on the row. Returns `true`
    /// if a row was found and updated. Idempotent — archiving an
    /// already-archived project still returns `true`.
    async fn archive(&self, id: &str) -> Result<bool, BoxError>;
}

/// Persistence operations on persistent project [`TodoItem`]s.
///
/// Distinct from [`crate::plan`] (the per-turn working checklist) —
/// see [`crate::todo`] for the full design. The store is the only
/// fanout point: `subscribe()` returns a [`broadcast::Receiver`]
/// that yields [`TodoEvent`]s for every successful mutation,
/// regardless of whether the mutator was a `todo.*` tool call or a
/// REST request. WS sessions filter by `TodoEvent::workspace()`
/// against their pinned root.
///
/// All methods are workspace-scoped at the row level; there is no
/// "global" listing. Callers that don't know the workspace yet
/// should use the store via the REST query parameter or the
/// session-pinned root.
#[async_trait]
pub trait TodoStore: Send + Sync {
    /// Return up to ~500 TODOs for `workspace`, sorted by
    /// `updated_at` descending. Implementations should
    /// `tracing::warn!` when the cap is hit so operators notice
    /// runaway backlogs.
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError>;

    /// Look up by id. Returns `None` if absent. Note that this is
    /// NOT workspace-scoped — id is globally unique (UUID v4) and
    /// the row carries its own workspace field.
    async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError>;

    /// Insert or overwrite a TODO. Implementations must broadcast
    /// `TodoEvent::Upserted(item.clone())` after a successful write.
    async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError>;

    /// Delete by id. Returns `true` if a row was removed; `false`
    /// if it was already absent (idempotent). Implementations must
    /// broadcast `TodoEvent::Deleted { workspace, id }` after a
    /// successful delete (skip the broadcast on the no-op `false`
    /// path so listeners don't see ghost events).
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver; lagged receivers will see [`broadcast::error::RecvError::Lagged`]
    /// and should refetch via `list`.
    fn subscribe(&self) -> broadcast::Receiver<TodoEvent>;
}

/// Persistence operations on per-project [`Requirement`]s — the
/// kanban backlog under each [`Project`].
///
/// Mirrors [`TodoStore`]: a single `subscribe()` fanout for both REST
/// mutations and (later) `requirement.*` tool calls; `list` is
/// project-scoped, `get` / `delete` operate by globally-unique id;
/// each row carries its own `project_id`. WS sessions filter
/// [`RequirementEvent`]s by `project_id` against the socket's pinned
/// project — a multi-window UI focused on different projects only sees
/// its own kanban move.
///
/// All methods are project-scoped at the row level; there is no
/// cross-project listing. Callers that don't know the project yet
/// should use the REST query parameter or the session-pinned project
/// id. There is intentionally no soft-delete equivalent of
/// [`ProjectStore::archive`] — the kanban's `done` column is the
/// graveyard, and deletes here are hard.
#[async_trait]
pub trait RequirementStore: Send + Sync {
    /// Return up to ~500 requirements for `project_id`, sorted by
    /// `updated_at` descending. Implementations should
    /// `tracing::warn!` when the cap is hit so operators notice
    /// runaway backlogs.
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError>;

    /// Look up by id. Returns `None` if absent. Note that this is
    /// NOT project-scoped — id is globally unique (UUID v4) and the
    /// row carries its own `project_id`.
    async fn get(&self, id: &str) -> Result<Option<Requirement>, BoxError>;

    /// Insert or overwrite a requirement. Implementations must
    /// broadcast `RequirementEvent::Upserted(item.clone())` after a
    /// successful write.
    async fn upsert(&self, item: &Requirement) -> Result<(), BoxError>;

    /// Delete by id. Returns `true` if a row was removed; `false`
    /// if it was already absent (idempotent). Implementations must
    /// broadcast `RequirementEvent::Deleted { project_id, id }`
    /// after a successful delete (skip the broadcast on the no-op
    /// `false` path so listeners don't see ghost events).
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver; lagged receivers will see [`broadcast::error::RecvError::Lagged`]
    /// and should refetch via `list`.
    fn subscribe(&self) -> broadcast::Receiver<RequirementEvent>;
}

/// Persistence operations on [`AgentProfile`]s — named provider /
/// model / system_prompt bundles users can save and reuse as
/// requirement assignees, @mentions, or auto-loop dispatch targets.
///
/// Mirrors the `RequirementStore` shape but is **server-global**, not
/// project-scoped: there is no `project_id` filter on `list`. WS
/// listeners see every mutation; the UI can scope by name in the
/// settings page itself if needed.
///
/// Consistent with the rest of the store traits, mutations broadcast
/// through `subscribe()` regardless of whether the call came from a
/// REST handler or a future tool. Lagged receivers should refetch via
/// `list`.
#[async_trait]
pub trait AgentProfileStore: Send + Sync {
    /// Return all profiles, sorted by `updated_at` descending. The
    /// expected cardinality is small (single-digit to low double-digit
    /// per server), so no pagination — implementations are free to cap
    /// at ~500 and `tracing::warn!` on overflow if that ever becomes
    /// realistic.
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError>;

    /// Look up by id. Returns `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<AgentProfile>, BoxError>;

    /// Insert or overwrite a profile. Implementations must broadcast
    /// `AgentProfileEvent::Upserted(item.clone())` after a successful
    /// write.
    async fn upsert(&self, item: &AgentProfile) -> Result<(), BoxError>;

    /// Delete by id. Returns `true` if a row was removed; `false`
    /// if it was already absent (idempotent). Implementations must
    /// broadcast `AgentProfileEvent::Deleted { id }` after a
    /// successful delete (skip the broadcast on the no-op `false`
    /// path so listeners don't see ghost events).
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver.
    fn subscribe(&self) -> broadcast::Receiver<AgentProfileEvent>;
}

/// Persistence operations on [`DocProject`] + [`DocDraft`] rows.
///
/// One trait covers both halves of the doc workspace because they
/// share a fanout — REST mutations on either type broadcast through
/// the same `subscribe()` channel as [`DocEvent`]s.
///
/// Layout:
/// - `list_projects(workspace)` — projects scoped to a workspace
///   (newest-first, soft cap of 500).
/// - `get_project(id)` — globally-unique project lookup.
/// - `upsert_project(p)` — insert or replace.
/// - `delete_project(id)` — removes the project AND all of its
///   drafts; broadcasts `ProjectDeleted` only (one event per call).
/// - `list_drafts(project_id)` — drafts belonging to a project,
///   newest-first.
/// - `latest_draft(project_id)` — the single most-recent draft, or
///   `None`. v0 UIs use this for "the body".
/// - `upsert_draft(d)` — save draft (insert by id or replace).
#[async_trait]
pub trait DocStore: Send + Sync {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError>;

    async fn get_project(&self, id: &str) -> Result<Option<DocProject>, BoxError>;

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError>;

    /// Hard-delete a project and every draft attached to it.
    /// Returns `true` if the project existed.
    async fn delete_project(&self, id: &str) -> Result<bool, BoxError>;

    async fn list_drafts(&self, project_id: &str) -> Result<Vec<DocDraft>, BoxError>;

    /// Convenience for v0 UIs: the most-recent draft by `updated_at`.
    /// Default impl scans `list_drafts` and picks the head; SQL
    /// backends can override with `ORDER BY updated_at DESC LIMIT 1`.
    async fn latest_draft(&self, project_id: &str) -> Result<Option<DocDraft>, BoxError> {
        let rows = self.list_drafts(project_id).await?;
        Ok(rows.into_iter().next())
    }

    async fn upsert_draft(&self, draft: &DocDraft) -> Result<(), BoxError>;

    /// Subscribe to mutation events.
    fn subscribe(&self) -> broadcast::Receiver<DocEvent>;
}
