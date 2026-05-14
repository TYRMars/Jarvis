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
use crate::error::BoxError;
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
    /// Lifecycle state of the conversation. Defaults to
    /// [`ConversationLifecycle::Active`] for legacy rows that predate
    /// the field, so existing UI clients keep rendering them
    /// unchanged.
    pub lifecycle: ConversationLifecycle,
}

/// User-driven terminal-ish state for a Conversation. Distinct from
/// the per-turn `RequirementRun.status` (Pending/Running/.../Cancelled);
/// `lifecycle` is "what the human said about this whole session".
///
/// The three states form a simple progression with no automatic
/// transitions (only the REST `set_lifecycle` route mutates the
/// field):
///
/// - `Active`: default; conversation is alive and shown in the sidebar.
/// - `Archived`: user is done with it but wants to keep it for
///   reference. Hidden from the default sidebar; visible on the
///   archive page.
/// - `Abandoned`: user explicitly gave up on this session — distinct
///   from "naturally completed" and from "agent error". Used to
///   distinguish "my reconciler missed it" from "I didn't want this
///   session to finish". Hidden by default; visible only when the
///   user opts into the abandoned filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationLifecycle {
    #[default]
    Active,
    Archived,
    Abandoned,
}

impl ConversationLifecycle {
    /// Wire-form representation used by the REST API and the
    /// JSON-on-disk format. Stable strings so changing the Rust
    /// enum order doesn't break persistence.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
            Self::Abandoned => "abandoned",
        }
    }

    /// Parse from a wire string. Returns `None` for unknown values
    /// (REST handlers turn this into a 400; persistence layers may
    /// silently fall back to `Active` for forward compat).
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "archived" => Some(Self::Archived),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }

    /// True for the default state — used by `serde(skip_serializing_if)`
    /// so legacy rows + Active rows omit the field on the wire.
    pub fn is_default(&self) -> bool {
        matches!(self, Self::Active)
    }

    /// True when the conversation is no longer in the live working
    /// set (Archived or Abandoned). Drives the default sidebar
    /// hide-from-list behaviour.
    pub fn is_inactive(&self) -> bool {
        !matches!(self, Self::Active)
    }
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
    /// User-facing lifecycle state. Defaults to `Active`; legacy rows
    /// that predate the field rehydrate as `Active` automatically.
    pub lifecycle: ConversationLifecycle,
}

impl ConversationMetadata {
    /// Convenience constructor for the common "bind to project X" case.
    pub fn with_project(project_id: impl Into<String>) -> Self {
        Self {
            project_id: Some(project_id.into()),
            lifecycle: ConversationLifecycle::default(),
        }
    }

    /// Builder-style setter for the lifecycle field. Used by the
    /// `set_lifecycle` REST handler when re-saving.
    pub fn with_lifecycle(mut self, lifecycle: ConversationLifecycle) -> Self {
        self.lifecycle = lifecycle;
        self
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

// `ProjectStore`, `RequirementStore`, `RequirementRunStore`,
// `ActivityStore`, `CommentStore`, `LabelStore`, `DocStore`,
// `ProjectMemoryStore` all moved to the `harness-project` crate.
// Import via `use harness_project::{ProjectStore, RequirementStore,
// ...};` from consumer crates.

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

// `ChannelBindingStore` / `ChannelInstanceStore` moved to the
// `harness-channel` crate together with the value types they
// reference. Import via `harness_channel::{ChannelBindingStore,
// ChannelInstanceStore}` from consumer crates.
