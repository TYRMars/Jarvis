//! Persistence traits for the project domain.
//!
//! 8 stores, each scoped to a different row family. All follow the
//! same conventions as the channel store traits in `harness-channel`:
//! - `Send + Sync` so they can live in an `Arc<dyn _>` and be cloned
//!   across the request graph;
//! - `BoxError` is the leaf-friendly alias (no `harness-core` dep);
//! - mutating verbs publish on a `broadcast` channel that the WS
//!   layer fans out as the corresponding `*Event` frames.
//!
//! Implementations live in `harness-store`; this crate just owns the
//! trait surface so anything that needs to **talk about** the
//! project domain (HTTP routes, agent tools, tests) doesn't drag in
//! a backend choice.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::activity::{Activity, ActivityEvent};
use crate::comment::{Comment, CommentEvent};
use crate::doc::{DocDraft, DocEvent, DocProject};
use crate::label::{Label, LabelEvent};
use crate::project::Project;
use crate::project_memory::ProjectMemory;
use crate::requirement::{Requirement, RequirementEvent};
use crate::requirement_run::{RequirementRun, RequirementRunEvent};

/// `Send + Sync`-bounded boxed error. Same shape as
/// `harness_core::BoxError` and `harness_channel::BoxError` — they're
/// all `Box<dyn std::error::Error + Send + Sync>` underneath and
/// fully interchangeable because Rust type aliases are transparent.
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Persistence operations on [`Project`] rows.
///
/// One row per project; slug is unique. `delete` and `archive` are
/// distinct: `archive` flips the soft-delete flag (and is what the
/// UI's "delete" button typically calls); `delete` removes the row
/// entirely. Higher layers should refuse to hard-delete projects
/// with bound conversations.
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

/// Persistence operations on per-project [`Requirement`]s — the
/// kanban backlog under each [`Project`].
///
/// All methods are project-scoped at the row level; there is no
/// cross-project listing. There is intentionally no soft-delete
/// equivalent of [`ProjectStore::archive`] — the kanban's `done`
/// column is the graveyard, and deletes here are hard.
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
    /// receiver; lagged receivers will see `RecvError::Lagged` and
    /// should refetch via `list`.
    fn subscribe(&self) -> broadcast::Receiver<RequirementEvent>;
}

/// Persistence operations on per-requirement [`RequirementRun`]s —
/// one row per execution attempt against a kanban [`Requirement`].
///
/// `upsert` is the only mutating verb; it must broadcast a
/// [`RequirementRunEvent`] derived from the diff between the row
/// already on disk (if any) and the incoming row:
///
/// - Absent → present with non-terminal status ⇒
///   [`RequirementRunEvent::Started`] (pending or running).
/// - Present → terminal status ⇒ [`RequirementRunEvent::Finished`].
/// - Otherwise no event.
///
/// `Verified` events are emitted explicitly by the caller (typically
/// the verification gate handler) via [`Self::broadcast`].
///
/// There is intentionally no `delete` — runs are append-only history.
#[async_trait]
pub trait RequirementRunStore: Send + Sync {
    /// Return up to ~200 runs for `requirement_id`, sorted by
    /// `started_at` descending (newest first). Implementations
    /// should `tracing::warn!` when the cap is hit so operators
    /// notice runaway run history.
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError>;

    /// Look up by id. Returns `None` if absent. Not requirement-
    /// scoped — id is globally unique (UUID v4) and the row carries
    /// its own `requirement_id`.
    async fn get(&self, id: &str) -> Result<Option<RequirementRun>, BoxError>;

    /// Return up to `limit` runs across **all** requirements, sorted
    /// by `started_at` descending. Used by the doctor /
    /// `/v1/diagnostics/runs/*` endpoints. Default impl returns an
    /// empty list so existing backends keep compiling.
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
    /// upsert that wrote the verification result.
    fn broadcast(&self, ev: RequirementRunEvent);

    /// Subscribe to mutation events.
    fn subscribe(&self) -> broadcast::Receiver<RequirementRunEvent>;
}

/// Append-only [`Activity`] audit log scoped to a [`Requirement`].
#[async_trait]
pub trait ActivityStore: Send + Sync {
    /// Return up to ~500 activities for `requirement_id`, sorted by
    /// `created_at` descending (newest first).
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Activity>, BoxError>;

    /// Append a single activity row. Implementations must broadcast
    /// [`ActivityEvent::Appended`] after a successful write.
    async fn append(&self, activity: &Activity) -> Result<(), BoxError>;

    /// Subscribe to mutation events.
    fn subscribe(&self) -> broadcast::Receiver<ActivityEvent>;
}

/// Persistence operations on [`Comment`] rows.
///
/// Like [`ActivityStore`], rows are scoped to a parent [`Requirement`].
/// Unlike `ActivityStore`, comments are **not** append-only:
/// operators can edit typos and delete comments they regret.
/// Implementations enforce:
///
/// 1. `create` rejects [`Comment::parent_id`] entries that don't
///    exist or that themselves have a non-None parent (depth > 1).
/// 2. `update` only mutates `body` + `updated_at`.
/// 3. `delete` cascades: removing a top-level comment removes its
///    direct replies.
#[async_trait]
pub trait CommentStore: Send + Sync {
    /// Return up to ~500 comments for `requirement_id`, sorted by
    /// `created_at` ascending (oldest-first; chat order).
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError>;

    /// Insert a fresh comment. Returns `Err` when `parent_id` is set
    /// but doesn't reference an existing top-level comment in the
    /// same requirement, or when the parent itself is a reply
    /// (depth-1 invariant). On success, broadcasts
    /// [`CommentEvent::Posted`].
    async fn create(&self, comment: &Comment) -> Result<(), BoxError>;

    /// Replace an existing comment's body + `updated_at`. Returns
    /// `Ok(false)` if `id` doesn't exist. Broadcasts
    /// [`CommentEvent::Edited`].
    async fn update(&self, comment: &Comment) -> Result<bool, BoxError>;

    /// Hard-delete `comment_id`. When the row is a top-level comment,
    /// every direct reply is also removed. Returns `Ok(false)` if
    /// the id wasn't found. Broadcasts one [`CommentEvent::Deleted`]
    /// per row removed.
    async fn delete(&self, requirement_id: &str, comment_id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events.
    fn subscribe(&self) -> broadcast::Receiver<CommentEvent>;
}

/// Persistence operations on [`Label`] rows.
///
/// Labels are scoped to a [`Project`]. Uniqueness is enforced per
/// project, case-insensitively, on `create` / `update`. Deletion
/// does NOT cascade into `Requirement.label_ids` — a deleted label
/// leaves dangling ids that the REST layer filters on read.
#[async_trait]
pub trait LabelStore: Send + Sync {
    /// Every label scoped to `project_id`, sorted by `name`
    /// case-insensitively.
    async fn list_for_project(&self, project_id: &str) -> Result<Vec<Label>, BoxError>;

    /// Lookup by id. Returns `None` when the id isn't found in any
    /// project.
    async fn get(&self, id: &str) -> Result<Option<Label>, BoxError>;

    /// Insert a fresh label. Errors when another label in the same
    /// project already has the same name (case-insensitive). On
    /// success, broadcasts [`LabelEvent::Created`].
    async fn create(&self, label: &Label) -> Result<(), BoxError>;

    /// Replace an existing label's `name` / `colour` / `description`
    /// / `updated_at`. Returns `Ok(false)` if `id` doesn't exist.
    /// Broadcasts [`LabelEvent::Updated`].
    async fn update(&self, label: &Label) -> Result<bool, BoxError>;

    /// Hard-delete `label_id`. Returns `Ok(false)` if the id wasn't
    /// found. Broadcasts [`LabelEvent::Deleted`].
    async fn delete(&self, project_id: &str, label_id: &str) -> Result<bool, BoxError>;

    /// Subscribe to mutation events.
    fn subscribe(&self) -> broadcast::Receiver<LabelEvent>;
}

/// Persistence operations on [`DocProject`] + [`DocDraft`] rows.
///
/// One trait covers both halves of the doc workspace because they
/// share a fanout — REST mutations on either type broadcast through
/// the same `subscribe()` channel as [`DocEvent`]s.
#[async_trait]
pub trait DocStore: Send + Sync {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError>;

    async fn get_project(&self, id: &str) -> Result<Option<DocProject>, BoxError>;

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError>;

    /// Hard-delete a project and every draft attached to it. Returns
    /// `true` if the project existed.
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

/// Persistence operations on [`ProjectMemory`] rows.
///
/// Memories are project-scoped: the auto loop loads them by
/// `project_id` before each run; the agent / operator append / edit
/// them via tools or REST. No broadcast channel — memories don't
/// drive UI in real time the way Activity / Comment do; clients
/// re-list when they want a refresh.
#[async_trait]
pub trait ProjectMemoryStore: Send + Sync {
    /// Return memories for `project_id`, newest-first by
    /// `updated_at`.
    async fn list(&self, project_id: &str) -> Result<Vec<ProjectMemory>, BoxError>;

    /// Look up by id. Returns `None` if absent.
    async fn get(&self, id: &str) -> Result<Option<ProjectMemory>, BoxError>;

    /// Insert or overwrite a memory. The store does NOT mutate
    /// `updated_at`; callers (or [`ProjectMemory::touch`]) own that.
    async fn upsert(&self, memory: &ProjectMemory) -> Result<(), BoxError>;

    /// Hard-delete by id. Returns `true` if a row was removed.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}
