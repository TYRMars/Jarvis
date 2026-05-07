//! Pluggable persistence for [`Conversation`](crate::Conversation)s and
//! [`Project`](crate::Project)s.
//!
//! `harness-core` defines only the traits and a few value types; concrete
//! backends live in `harness-store` so callers can pick SQLite, Postgres,
//! MySQL, JSON-file, or in-memory without paying for the others' deps.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::activity::{Activity, ActivityEvent};
use crate::agent_profile::{AgentProfile, AgentProfileEvent};
use crate::comment::{Comment, CommentEvent};
use crate::conversation::Conversation;
use crate::doc::{DocDraft, DocEvent, DocProject};
use crate::error::BoxError;
use crate::label::{Label, LabelEvent};
use crate::project::Project;
use crate::requirement::{Requirement, RequirementEvent};
use crate::requirement_run::{RequirementRun, RequirementRunEvent};
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

/// Persistence operations on per-requirement [`RequirementRun`]s — one
/// row per execution attempt against a kanban [`Requirement`].
///
/// Mirrors [`RequirementStore`]: a single `subscribe()` fanout for
/// every status change, `list_for_requirement` returns the run history
/// for one card, `get` / `upsert` operate by globally-unique id; each
/// row carries its own `requirement_id`. WS sessions don't currently
/// filter by run id — every connected client sees every event — but
/// the broadcast shape leaves room for that later.
///
/// [`upsert`](Self::upsert) is the only mutating verb; it must
/// broadcast a [`RequirementRunEvent`] derived from the diff between
/// the row already on disk (if any) and the incoming row:
///
/// - Absent → present with non-terminal status ⇒
///   [`RequirementRunEvent::Started`] (pending or running).
/// - Present → terminal status (per [`crate::RequirementRunStatus::is_terminal`])
///   ⇒ [`RequirementRunEvent::Finished`].
/// - Otherwise no event (e.g. summary tweak on an in-flight run); a
///   client wanting fine-grained progress reads `AgentEvent` from the
///   conversation socket instead.
///
/// `Verified` events are emitted explicitly by the caller (typically
/// the verification gate handler) via the `subscribe()` channel — not
/// by `upsert`, because verification can be re-run against a row
/// whose terminal status is already set without changing the row's
/// shape.
///
/// There is intentionally no `delete` — runs are append-only history;
/// a run row's lifecycle ends at a terminal status. Cleaning up old
/// runs is a Phase 5 doctor concern.
#[async_trait]
pub trait RequirementRunStore: Send + Sync {
    /// Return up to ~200 runs for `requirement_id`, sorted by
    /// `started_at` descending (newest first). Implementations should
    /// `tracing::warn!` when the cap is hit so operators notice
    /// runaway run history.
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError>;

    /// Look up by id. Returns `None` if absent. Note that this is
    /// NOT requirement-scoped — id is globally unique (UUID v4) and
    /// the row carries its own `requirement_id`.
    async fn get(&self, id: &str) -> Result<Option<RequirementRun>, BoxError>;

    /// Phase 5c — return up to `limit` runs across **all**
    /// requirements, sorted by `started_at` descending. Used by
    /// the doctor / `/v1/diagnostics/runs/*` endpoints to surface
    /// stuck / failed runs without enumerating every requirement
    /// id first. Default impl returns an empty list so existing
    /// backends keep compiling — every shipped backend overrides it.
    async fn list_all(&self, _limit: u32) -> Result<Vec<RequirementRun>, BoxError> {
        Ok(Vec::new())
    }

    /// Insert or overwrite a run row. Implementations must
    /// broadcast a [`RequirementRunEvent`] reflecting the
    /// transition, per the trait-level rules.
    async fn upsert(&self, run: &RequirementRun) -> Result<(), BoxError>;

    /// Send an event into the broadcast channel without writing to
    /// disk. Used by callers (specifically the verification gate
    /// handler) that need to fan out a
    /// [`RequirementRunEvent::Verified`] frame separately from the
    /// upsert that wrote the verification result. Implementations
    /// must publish on the same channel that backs
    /// [`subscribe`](Self::subscribe).
    fn broadcast(&self, ev: RequirementRunEvent);

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver; lagged receivers will see [`broadcast::error::RecvError::Lagged`]
    /// and should refetch via `list_for_requirement`.
    fn subscribe(&self) -> broadcast::Receiver<RequirementRunEvent>;
}

/// Persistence operations on named [`AgentProfile`] rows.
///
/// Process-wide (not project- or workspace-scoped) — a profile is
/// just a named bundle of provider / model / system_prompt that
/// any [`Requirement`] can be assigned to. The set is small (think
/// dozens, not thousands) so the trait stays plain CRUD with no
/// pagination.
///
/// Mutations broadcast [`AgentProfileEvent`] on a shared channel
/// so WS sessions can render `agent_profile_upserted` /
/// `agent_profile_deleted` frames without polling.
#[async_trait]
pub trait AgentProfileStore: Send + Sync {
    /// Return all profiles, sorted by `name` ascending. Soft-cap
    /// at ~200 — operators with that many named agents probably
    /// want filtering, which is a v2 concern.
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError>;

    /// Look up by id. Returns `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<AgentProfile>, BoxError>;

    /// Insert or overwrite. Implementations must broadcast
    /// `AgentProfileEvent::Upserted(profile.clone())` after a
    /// successful write.
    async fn upsert(&self, profile: &AgentProfile) -> Result<(), BoxError>;

    /// Delete by id. Returns `true` if a row was removed; `false`
    /// if it was already absent (idempotent). Implementations
    /// must broadcast `AgentProfileEvent::Deleted { id }` after
    /// a successful delete (skip the broadcast on the no-op
    /// `false` path so listeners don't see ghost events).
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver; lagged receivers will see [`broadcast::error::RecvError::Lagged`]
    /// and should refetch via `list`.
    fn subscribe(&self) -> broadcast::Receiver<AgentProfileEvent>;
}

/// Persistence operations on per-requirement [`Activity`] rows — the
/// audit timeline surfaced under each kanban card.
///
/// Append-only by design: there is no `upsert` / `delete` /
/// `update`. Once a row is written it is immutable forever; the
/// only mutating verb is `append`. This matches the trail's
/// purpose — "what happened, in order" — and keeps every backend
/// trivial (insert + broadcast, no diff classification).
///
/// `append` must broadcast [`ActivityEvent::Appended`] after a
/// successful write. Per-requirement filtering happens at the WS
/// layer; the broadcast itself fans every event to every
/// subscriber.
///
/// `list_for_requirement` returns rows newest-first with a soft
/// cap (~500) so a runaway audit log doesn't OOM the request
/// handler. Older rows are still on disk; future paging /
/// truncation is a Phase-5 doctor concern.
#[async_trait]
pub trait ActivityStore: Send + Sync {
    /// Return up to ~500 activities for `requirement_id`, sorted
    /// by `created_at` descending (newest first). Implementations
    /// should `tracing::warn!` when the cap is hit so operators
    /// notice runaway audit logs.
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Activity>, BoxError>;

    /// Append a single activity row. Implementations must
    /// broadcast [`ActivityEvent::Appended`] after a successful
    /// write.
    async fn append(&self, activity: &Activity) -> Result<(), BoxError>;

    /// Subscribe to mutation events. Each call returns a fresh
    /// receiver; lagged receivers will see [`broadcast::error::RecvError::Lagged`]
    /// and should refetch via `list_for_requirement`.
    fn subscribe(&self) -> broadcast::Receiver<ActivityEvent>;
}

// ---------- CommentStore --------------------------------------------------

/// Persistence operations on [`Comment`] rows.
///
/// Like [`ActivityStore`], rows are scoped to a parent
/// [`Requirement`](crate::Requirement). Unlike `ActivityStore`,
/// comments are **not** append-only: operators can edit typos and
/// delete comments they regret. Implementations enforce three
/// invariants:
///
/// 1. `create` rejects [`Comment::parent_id`] entries that don't
///    exist or that themselves have a non-None parent (i.e. depth
///    > 1). The store is the only place that can check this
///    cheaply because the row layout is its own.
/// 2. `update` only mutates `body` + `updated_at` — `id`,
///    `requirement_id`, `parent_id`, `author`, and `created_at` are
///    immutable across edits. Implementations may reject mismatching
///    payloads or silently overwrite at their discretion; the REST
///    layer normalises before calling.
/// 3. `delete` cascades: removing a top-level comment removes its
///    direct replies. The trait surfaces a single `delete` for
///    convenience; implementations may issue multiple writes
///    underneath.
///
/// `list_for_requirement` returns rows oldest-first (the chat-style
/// order the UI wants for direct rendering), capped at ~500. The
/// soft cap matches `ActivityStore` so a single Requirement's
/// timeline page can render both streams without further paging.
#[async_trait]
pub trait CommentStore: Send + Sync {
    /// Return up to ~500 comments for `requirement_id`, sorted by
    /// `created_at` ascending (oldest-first; chat order).
    /// Implementations should `tracing::warn!` when the cap is hit
    /// so operators notice runaway threads.
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError>;

    /// Insert a fresh comment. Returns `Err` when `parent_id` is
    /// set but doesn't reference an existing top-level comment in
    /// the same requirement, or when the parent itself is a reply
    /// (depth-1 invariant). On success, broadcasts
    /// [`CommentEvent::Posted`].
    async fn create(&self, comment: &Comment) -> Result<(), BoxError>;

    /// Replace an existing comment's body + `updated_at`. Returns
    /// `Ok(false)` if `id` doesn't exist (caller maps to 404), or
    /// `Ok(true)` after a successful write. Broadcasts
    /// [`CommentEvent::Edited`].
    async fn update(&self, comment: &Comment) -> Result<bool, BoxError>;

    /// Hard-delete `comment_id`. When the row is a top-level
    /// comment, every direct reply is also removed. Returns
    /// `Ok(false)` if the id wasn't found. Broadcasts one
    /// [`CommentEvent::Deleted`] per row removed.
    async fn delete(&self, requirement_id: &str, comment_id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Same lag behaviour as the
    /// other stores — refetch on `Lagged`.
    fn subscribe(&self) -> broadcast::Receiver<CommentEvent>;
}

// ---------- LabelStore ----------------------------------------------------

/// Persistence operations on [`Label`] rows.
///
/// Labels are scoped to a [`Project`]. Two projects with a label
/// named "bug" hold two independent rows; uniqueness is enforced
/// per project, case-insensitively, on `create` / `update`.
///
/// The trait deliberately does NOT cascade label deletion into
/// requirements that reference the label id. Reasoning: a deleted
/// label leaves dangling ids in `Requirement.label_ids`, but that's
/// fine — the REST layer filters unknown ids on read, and a future
/// migration sweep can clean them up. Cascading would mean rewriting
/// every Requirement on every label delete, which is the exact
/// problem the indirection was meant to avoid.
#[async_trait]
pub trait LabelStore: Send + Sync {
    /// Every label scoped to `project_id`, sorted by `name`
    /// case-insensitively (stable UI ordering across backends).
    async fn list_for_project(&self, project_id: &str) -> Result<Vec<Label>, BoxError>;

    /// Lookup by id. Returns `None` when the id isn't found in any
    /// project. The caller usually knows which project the row
    /// should belong to and validates after the lookup.
    async fn get(&self, id: &str) -> Result<Option<Label>, BoxError>;

    /// Insert a fresh label. Errors when another label in the same
    /// project already has the same name (case-insensitive). On
    /// success, broadcasts [`LabelEvent::Created`].
    async fn create(&self, label: &Label) -> Result<(), BoxError>;

    /// Replace an existing label's `name` / `colour` / `description`
    /// / `updated_at`. `id` and `project_id` are immutable across
    /// updates; implementations reject mismatching payloads. Returns
    /// `Ok(false)` if `id` doesn't exist. Broadcasts
    /// [`LabelEvent::Updated`].
    async fn update(&self, label: &Label) -> Result<bool, BoxError>;

    /// Hard-delete `label_id`. Returns `Ok(false)` if the id wasn't
    /// found. Does NOT touch any `Requirement.label_ids` — see the
    /// trait-level note on dangling ids. Broadcasts
    /// [`LabelEvent::Deleted`].
    async fn delete(&self, project_id: &str, label_id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events. Same lag behaviour as the
    /// other stores — refetch on `Lagged`.
    fn subscribe(&self) -> broadcast::Receiver<LabelEvent>;
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

// ---------- ProjectMemoryStore -------------------------------------------

/// Persistence operations on [`ProjectMemory`](crate::ProjectMemory)
/// rows.
///
/// Memories are project-scoped: the auto loop loads them by
/// `project_id` before each run and the agent / operator append /
/// edit them via tools or REST. There is no broadcast channel —
/// memories don't drive UI in real time the way Activity / Comment
/// do; clients re-list when they want a refresh.
///
/// `list` returns rows newest-first (by `updated_at`) capped at the
/// implementation's discretion (~200 is what the in-memory backend
/// uses; SQL backends can paginate). `delete` is hard; archive
/// semantics aren't useful here because rows are short-lived
/// guidance, not historical artefacts.
#[async_trait]
pub trait ProjectMemoryStore: Send + Sync {
    /// Return memories for `project_id`, newest-first by
    /// `updated_at`. Implementations decide their own soft cap;
    /// the auto loop budgets bytes inside the prompt injector,
    /// not by row count.
    async fn list(&self, project_id: &str) -> Result<Vec<crate::ProjectMemory>, BoxError>;

    /// Look up by id. Returns `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<crate::ProjectMemory>, BoxError>;

    /// Insert or overwrite a memory. The store does NOT mutate
    /// `updated_at`; callers (or [`crate::ProjectMemory::touch`])
    /// own that.
    async fn upsert(&self, memory: &crate::ProjectMemory) -> Result<(), BoxError>;

    /// Hard-delete by id. Returns `true` if a row was removed.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}
