//! Pluggable persistence for [`Conversation`](crate::Conversation)s and
//! [`Project`](crate::Project)s.
//!
//! `harness-core` defines only the traits and a few value types; concrete
//! backends live in `harness-store` so callers can pick SQLite, Postgres,
//! MySQL, JSON-file, or in-memory without paying for the others' deps.

use async_trait::async_trait;

use crate::conversation::Conversation;
use crate::error::BoxError;
use crate::project::Project;

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
