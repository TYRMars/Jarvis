//! In-process [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_core::ProjectStore).
//!
//! Useful for tests and as the zero-dep reference impl of both traits.
//! Not intended for production — data is lost when the process exits.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{
    Activity, ActivityEvent, ActivityStore, AgentProfile, AgentProfileEvent, AgentProfileStore,
    BoxError, Conversation, ConversationMetadata, ConversationRecord, ConversationStore, DocDraft,
    DocEvent, DocProject, DocStore, Project, ProjectStore, Requirement, RequirementEvent,
    RequirementRun, RequirementRunEvent, RequirementRunStore, RequirementStore, TodoEvent,
    TodoItem, TodoStore,
};
use tokio::sync::{broadcast, RwLock};

#[derive(Clone)]
struct ConversationEntry {
    conversation: Conversation,
    metadata: ConversationMetadata,
    created_at: String,
    updated_at: String,
}

/// Stores conversations (with metadata) in a `HashMap` behind an async
/// `RwLock`. Pair-shared with [`MemoryProjectStore`] via [`MemoryStores`]
/// when both are needed in tests.
#[derive(Default, Clone)]
pub struct MemoryConversationStore {
    inner: Arc<RwLock<HashMap<String, ConversationEntry>>>,
}

impl MemoryConversationStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ConversationStore for MemoryConversationStore {
    async fn save_envelope(
        &self,
        id: &str,
        conversation: &Conversation,
        metadata: &ConversationMetadata,
    ) -> Result<(), BoxError> {
        let now = Utc::now().to_rfc3339();
        let mut guard = self.inner.write().await;
        guard
            .entry(id.to_string())
            .and_modify(|e| {
                e.conversation = conversation.clone();
                e.metadata = metadata.clone();
                e.updated_at = now.clone();
            })
            .or_insert_with(|| ConversationEntry {
                conversation: conversation.clone(),
                metadata: metadata.clone(),
                created_at: now.clone(),
                updated_at: now,
            });
        Ok(())
    }

    async fn load_envelope(
        &self,
        id: &str,
    ) -> Result<Option<(Conversation, ConversationMetadata)>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard
            .get(id)
            .map(|e| (e.conversation.clone(), e.metadata.clone())))
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<ConversationRecord> = guard
            .iter()
            .map(|(id, e)| ConversationRecord {
                id: id.clone(),
                created_at: e.created_at.clone(),
                updated_at: e.updated_at.clone(),
                message_count: e.conversation.messages.len(),
                project_id: e.metadata.project_id.clone(),
            })
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

/// In-process [`ProjectStore`]. Slug uniqueness is enforced by a
/// linear scan inside `save` — fine for the test-scale row counts
/// this backend serves.
#[derive(Default, Clone)]
pub struct MemoryProjectStore {
    inner: Arc<RwLock<HashMap<String, Project>>>,
}

impl MemoryProjectStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ProjectStore for MemoryProjectStore {
    async fn save(&self, project: &Project) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        // Slug uniqueness check: any other row with the same slug?
        for (id, existing) in guard.iter() {
            if id != &project.id && existing.slug == project.slug {
                return Err(format!(
                    "project slug '{}' already in use by id={}",
                    project.slug, id
                )
                .into());
            }
        }
        guard.insert(project.id.clone(), project.clone());
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Project>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.values().find(|p| p.slug == slug).cloned())
    }

    async fn list(&self, include_archived: bool, limit: u32) -> Result<Vec<Project>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<Project> = guard
            .values()
            .filter(|p| include_archived || !p.archived)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        if let Some(p) = guard.get_mut(id) {
            p.archive();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

/// In-process [`TodoStore`]. Items keyed by id; broadcast fanout
/// shared by every clone of this struct via `Arc`.
#[derive(Clone)]
pub struct MemoryTodoStore {
    inner: Arc<RwLock<HashMap<String, TodoItem>>>,
    tx: broadcast::Sender<TodoEvent>,
}

impl Default for MemoryTodoStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryTodoStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl TodoStore for MemoryTodoStore {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<TodoItem> = guard
            .values()
            .filter(|t| t.workspace == workspace)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if rows.len() > 500 {
            tracing::warn!(
                workspace,
                count = rows.len(),
                "todo list exceeded 500-item soft cap"
            );
            rows.truncate(500);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError> {
        {
            let mut guard = self.inner.write().await;
            guard.insert(item.id.clone(), item.clone());
        }
        let _ = self.tx.send(TodoEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let removed = {
            let mut guard = self.inner.write().await;
            guard.remove(id)
        };
        match removed {
            Some(item) => {
                let _ = self.tx.send(TodoEvent::Deleted {
                    workspace: item.workspace,
                    id: item.id,
                });
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<TodoEvent> {
        self.tx.subscribe()
    }
}

/// In-process [`RequirementStore`]. Items keyed by id; broadcast
/// fanout shared by every clone via `Arc`.
#[derive(Clone)]
pub struct MemoryRequirementStore {
    inner: Arc<RwLock<HashMap<String, Requirement>>>,
    tx: broadcast::Sender<RequirementEvent>,
}

impl Default for MemoryRequirementStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryRequirementStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl RequirementStore for MemoryRequirementStore {
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<Requirement> = guard
            .values()
            .filter(|r| r.project_id == project_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if rows.len() > 500 {
            tracing::warn!(
                project_id,
                count = rows.len(),
                "requirement list exceeded 500-item soft cap"
            );
            rows.truncate(500);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<Requirement>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(&self, item: &Requirement) -> Result<(), BoxError> {
        {
            let mut guard = self.inner.write().await;
            guard.insert(item.id.clone(), item.clone());
        }
        let _ = self.tx.send(RequirementEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let removed = {
            let mut guard = self.inner.write().await;
            guard.remove(id)
        };
        match removed {
            Some(item) => {
                let _ = self.tx.send(RequirementEvent::Deleted {
                    project_id: item.project_id,
                    id: item.id,
                });
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<RequirementEvent> {
        self.tx.subscribe()
    }
}

/// In-process [`RequirementRunStore`]. Run rows keyed by id; broadcast
/// fanout shared by every clone via `Arc`.
#[derive(Clone)]
pub struct MemoryRequirementRunStore {
    inner: Arc<RwLock<HashMap<String, RequirementRun>>>,
    tx: broadcast::Sender<RequirementRunEvent>,
}

impl Default for MemoryRequirementRunStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryRequirementRunStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl RequirementRunStore for MemoryRequirementRunStore {
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<RequirementRun> = guard
            .values()
            .filter(|r| r.requirement_id == requirement_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        if rows.len() > 200 {
            tracing::warn!(
                requirement_id,
                count = rows.len(),
                "requirement run list exceeded 200-item soft cap"
            );
            rows.truncate(200);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<RequirementRun>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn list_all(&self, limit: u32) -> Result<Vec<RequirementRun>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<RequirementRun> = guard.values().cloned().collect();
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn upsert(&self, run: &RequirementRun) -> Result<(), BoxError> {
        let event = {
            let mut guard = self.inner.write().await;
            let prior = guard.insert(run.id.clone(), run.clone());
            classify_run_event(prior.as_ref(), run)
        };
        if let Some(ev) = event {
            let _ = self.tx.send(ev);
        }
        Ok(())
    }

    fn broadcast(&self, ev: RequirementRunEvent) {
        let _ = self.tx.send(ev);
    }

    fn subscribe(&self) -> broadcast::Receiver<RequirementRunEvent> {
        self.tx.subscribe()
    }
}

/// Decide which (if any) [`RequirementRunEvent`] to broadcast given
/// the row already on disk and the incoming row.
///
/// - Absent → present with non-terminal status ⇒ `Started`.
/// - Present (or absent) → terminal status that wasn't already
///   terminal ⇒ `Finished`.
/// - Otherwise ⇒ `None` (e.g. summary tweak on an in-flight run).
pub(crate) fn classify_run_event(
    prior: Option<&RequirementRun>,
    next: &RequirementRun,
) -> Option<RequirementRunEvent> {
    let was_terminal = prior.map(|r| r.status.is_terminal()).unwrap_or(false);
    let now_terminal = next.status.is_terminal();
    if !was_terminal && now_terminal {
        Some(RequirementRunEvent::Finished(next.clone()))
    } else if prior.is_none() && !now_terminal {
        Some(RequirementRunEvent::Started(next.clone()))
    } else {
        None
    }
}

/// In-process [`AgentProfileStore`]. Profiles keyed by id;
/// broadcast fanout shared by every clone via `Arc`.
#[derive(Clone)]
pub struct MemoryAgentProfileStore {
    inner: Arc<RwLock<HashMap<String, AgentProfile>>>,
    tx: broadcast::Sender<AgentProfileEvent>,
}

impl Default for MemoryAgentProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryAgentProfileStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl AgentProfileStore for MemoryAgentProfileStore {
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<AgentProfile> = guard.values().cloned().collect();
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        if rows.len() > 200 {
            tracing::warn!(
                count = rows.len(),
                "agent profile list exceeded 200-item soft cap"
            );
            rows.truncate(200);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<AgentProfile>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(&self, profile: &AgentProfile) -> Result<(), BoxError> {
        {
            let mut guard = self.inner.write().await;
            guard.insert(profile.id.clone(), profile.clone());
        }
        let _ = self.tx.send(AgentProfileEvent::Upserted(profile.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let removed = {
            let mut guard = self.inner.write().await;
            guard.remove(id)
        };
        match removed {
            Some(_) => {
                let _ = self
                    .tx
                    .send(AgentProfileEvent::Deleted { id: id.to_string() });
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<AgentProfileEvent> {
        self.tx.subscribe()
    }
}

/// In-process [`ActivityStore`]. Append-only timeline keyed by
/// `requirement_id` with a single broadcast fanout shared across
/// every clone via `Arc`.
#[derive(Clone)]
pub struct MemoryActivityStore {
    inner: Arc<RwLock<HashMap<String, Vec<Activity>>>>,
    tx: broadcast::Sender<ActivityEvent>,
}

impl Default for MemoryActivityStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryActivityStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl ActivityStore for MemoryActivityStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Activity>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows = guard.get(requirement_id).cloned().unwrap_or_default();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if rows.len() > 500 {
            tracing::warn!(
                requirement_id,
                count = rows.len(),
                "activity list exceeded 500-item soft cap"
            );
            rows.truncate(500);
        }
        Ok(rows)
    }

    async fn append(&self, activity: &Activity) -> Result<(), BoxError> {
        {
            let mut guard = self.inner.write().await;
            let list = guard.entry(activity.requirement_id.clone()).or_default();
            list.push(activity.clone());
        }
        let _ = self.tx.send(ActivityEvent::Appended(activity.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<ActivityEvent> {
        self.tx.subscribe()
    }
}

/// In-process [`DocStore`]. Projects + drafts in two `HashMap`s
/// behind a single `RwLock`; broadcast fanout shared via `Arc`.
#[derive(Clone)]
pub struct MemoryDocStore {
    projects: Arc<RwLock<HashMap<String, DocProject>>>,
    drafts: Arc<RwLock<HashMap<String, DocDraft>>>,
    tx: broadcast::Sender<DocEvent>,
}

impl Default for MemoryDocStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryDocStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            projects: Arc::new(RwLock::new(HashMap::new())),
            drafts: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl DocStore for MemoryDocStore {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
        let guard = self.projects.read().await;
        let mut rows: Vec<DocProject> = guard
            .values()
            .filter(|p| p.workspace == workspace)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if rows.len() > 500 {
            tracing::warn!(
                workspace,
                count = rows.len(),
                "doc project list exceeded 500-item soft cap"
            );
            rows.truncate(500);
        }
        Ok(rows)
    }

    async fn get_project(&self, id: &str) -> Result<Option<DocProject>, BoxError> {
        let guard = self.projects.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
        {
            let mut guard = self.projects.write().await;
            guard.insert(project.id.clone(), project.clone());
        }
        let _ = self.tx.send(DocEvent::ProjectUpserted(project.clone()));
        Ok(())
    }

    async fn delete_project(&self, id: &str) -> Result<bool, BoxError> {
        let removed = {
            let mut guard = self.projects.write().await;
            guard.remove(id)
        };
        let Some(project) = removed else {
            return Ok(false);
        };
        // Cascade-delete drafts.
        {
            let mut guard = self.drafts.write().await;
            guard.retain(|_, d| d.project_id != project.id);
        }
        let _ = self.tx.send(DocEvent::ProjectDeleted {
            workspace: project.workspace,
            id: project.id,
        });
        Ok(true)
    }

    async fn list_drafts(&self, project_id: &str) -> Result<Vec<DocDraft>, BoxError> {
        let guard = self.drafts.read().await;
        let mut rows: Vec<DocDraft> = guard
            .values()
            .filter(|d| d.project_id == project_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn upsert_draft(&self, draft: &DocDraft) -> Result<(), BoxError> {
        {
            let mut guard = self.drafts.write().await;
            guard.insert(draft.id.clone(), draft.clone());
        }
        let _ = self.tx.send(DocEvent::DraftUpserted(draft.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<DocEvent> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Message;

    #[tokio::test]
    async fn save_load_delete_roundtrip() {
        let store = MemoryConversationStore::new();
        let mut conv = Conversation::new();
        conv.push(Message::user("hi"));

        store.save("abc", &conv).await.unwrap();
        let loaded = store.load("abc").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);

        assert!(store.delete("abc").await.unwrap());
        assert!(store.load("abc").await.unwrap().is_none());
        assert!(!store.delete("abc").await.unwrap());
    }

    #[tokio::test]
    async fn envelope_round_trips_metadata() {
        let store = MemoryConversationStore::new();
        let conv = Conversation::new();
        let meta = ConversationMetadata::with_project("proj-1");
        store.save_envelope("c1", &conv, &meta).await.unwrap();

        let (_, loaded_meta) = store.load_envelope("c1").await.unwrap().unwrap();
        assert_eq!(loaded_meta.project_id.as_deref(), Some("proj-1"));

        // Listing surfaces project_id without rehydrating the row.
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].project_id.as_deref(), Some("proj-1"));
    }

    #[tokio::test]
    async fn list_by_project_filters_correctly() {
        let store = MemoryConversationStore::new();
        store
            .save_envelope(
                "a",
                &Conversation::new(),
                &ConversationMetadata::with_project("p1"),
            )
            .await
            .unwrap();
        store
            .save_envelope("b", &Conversation::new(), &ConversationMetadata::default())
            .await
            .unwrap();
        store
            .save_envelope(
                "c",
                &Conversation::new(),
                &ConversationMetadata::with_project("p1"),
            )
            .await
            .unwrap();

        let rows = store.list_by_project("p1", 10).await.unwrap();
        let ids: std::collections::HashSet<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("a") && ids.contains("c"));
    }

    #[tokio::test]
    async fn list_orders_newest_first() {
        let store = MemoryConversationStore::new();
        store.save("a", &Conversation::new()).await.unwrap();
        // Spin until chrono's rfc3339 string advances; micro/nanoseconds are
        // included, so one `sleep(1ms)` is plenty.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        store.save("b", &Conversation::new()).await.unwrap();

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b");
        assert_eq!(rows[1].id, "a");

        let rows = store.list(1).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "b");
    }

    // ---- ProjectStore --------------------------------------------------

    #[tokio::test]
    async fn project_save_load_round_trip() {
        let store = MemoryProjectStore::new();
        let p = Project::new("My", "instructions").with_slug("my");
        store.save(&p).await.unwrap();

        let loaded = store.load(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);

        let by_slug = store.find_by_slug("my").await.unwrap().unwrap();
        assert_eq!(by_slug, p);
    }

    #[tokio::test]
    async fn project_save_rejects_duplicate_slug() {
        let store = MemoryProjectStore::new();
        let a = Project::new("A", "x").with_slug("dup");
        let b = Project::new("B", "y").with_slug("dup");
        store.save(&a).await.unwrap();
        let err = store.save(&b).await.unwrap_err();
        assert!(err.to_string().contains("dup"));
    }

    #[tokio::test]
    async fn project_save_overwrites_same_id_keeps_slug() {
        let store = MemoryProjectStore::new();
        let mut p = Project::new("Original", "x").with_slug("same");
        store.save(&p).await.unwrap();
        p.set_name("Renamed");
        // Same id, same slug — should overwrite cleanly.
        store.save(&p).await.unwrap();
        assert_eq!(store.load(&p.id).await.unwrap().unwrap().name, "Renamed");
    }

    #[tokio::test]
    async fn project_archive_hides_from_default_list() {
        let store = MemoryProjectStore::new();
        let mut p = Project::new("Z", "x").with_slug("z");
        store.save(&p).await.unwrap();
        store.archive(&p.id).await.unwrap();

        // Reload reflects archived state.
        let loaded = store.load(&p.id).await.unwrap().unwrap();
        assert!(loaded.archived);

        assert!(store.list(false, 10).await.unwrap().is_empty());
        assert_eq!(store.list(true, 10).await.unwrap().len(), 1);
        let _ = &mut p;
    }

    #[tokio::test]
    async fn project_delete_returns_existence() {
        let store = MemoryProjectStore::new();
        let p = Project::new("D", "x").with_slug("d");
        store.save(&p).await.unwrap();
        assert!(store.delete(&p.id).await.unwrap());
        assert!(!store.delete(&p.id).await.unwrap());
    }

    // ---- TodoStore -----------------------------------------------------

    use harness_core::TodoStatus;

    #[tokio::test]
    async fn todo_upsert_list_round_trip_filters_by_workspace() {
        let store = MemoryTodoStore::new();
        let mut a = TodoItem::new("/repo-a", "fix parser");
        let b = TodoItem::new("/repo-b", "rewrite docs");
        store.upsert(&a).await.unwrap();
        store.upsert(&b).await.unwrap();

        let only_a = store.list("/repo-a").await.unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].id, a.id);

        // Update flips status; upsert overwrites.
        a.status = TodoStatus::Completed;
        a.touch();
        store.upsert(&a).await.unwrap();
        let updated = store.get(&a.id).await.unwrap().unwrap();
        assert_eq!(updated.status, TodoStatus::Completed);

        // Delete by id reports existence.
        assert!(store.delete(&b.id).await.unwrap());
        assert!(!store.delete(&b.id).await.unwrap());
    }

    #[tokio::test]
    async fn todo_subscribe_fires_on_upsert_and_delete() {
        let store = MemoryTodoStore::new();
        let mut rx = store.subscribe();
        let t = TodoItem::new("/r", "x");
        store.upsert(&t).await.unwrap();
        let evt = rx.recv().await.unwrap();
        match evt {
            TodoEvent::Upserted(item) => assert_eq!(item.id, t.id),
            _ => panic!("expected Upserted"),
        }
        store.delete(&t.id).await.unwrap();
        let evt = rx.recv().await.unwrap();
        match evt {
            TodoEvent::Deleted { id, workspace } => {
                assert_eq!(id, t.id);
                assert_eq!(workspace, "/r");
            }
            _ => panic!("expected Deleted"),
        }
    }

    #[tokio::test]
    async fn todo_delete_no_op_does_not_emit() {
        let store = MemoryTodoStore::new();
        let mut rx = store.subscribe();
        assert!(!store.delete("never-existed").await.unwrap());
        // No event in the channel.
        assert!(rx.try_recv().is_err());
    }

    // ---- RequirementStore -----------------------------------------------

    use harness_core::RequirementStatus;

    #[tokio::test]
    async fn requirement_upsert_list_round_trip_filters_by_project() {
        let store = MemoryRequirementStore::new();
        let mut a = Requirement::new("p-a", "ship the kanban");
        let b = Requirement::new("p-b", "rewrite docs");
        store.upsert(&a).await.unwrap();
        store.upsert(&b).await.unwrap();

        let only_a = store.list("p-a").await.unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].id, a.id);

        // Update flips status; upsert overwrites.
        a.status = RequirementStatus::Review;
        a.touch();
        store.upsert(&a).await.unwrap();
        let updated = store.get(&a.id).await.unwrap().unwrap();
        assert_eq!(updated.status, RequirementStatus::Review);

        // Delete by id reports existence.
        assert!(store.delete(&b.id).await.unwrap());
        assert!(!store.delete(&b.id).await.unwrap());
    }

    #[tokio::test]
    async fn requirement_subscribe_fires_on_upsert_and_delete() {
        let store = MemoryRequirementStore::new();
        let mut rx = store.subscribe();
        let r = Requirement::new("p", "x");
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementEvent::Upserted(item) => assert_eq!(item.id, r.id),
            other => panic!("expected Upserted, got {other:?}"),
        }
        store.delete(&r.id).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementEvent::Deleted { project_id, id } => {
                assert_eq!(project_id, "p");
                assert_eq!(id, r.id);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn requirement_delete_no_op_does_not_emit() {
        let store = MemoryRequirementStore::new();
        let mut rx = store.subscribe();
        assert!(!store.delete("never-existed").await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- RequirementRunStore --------------------------------------------

    use harness_core::RequirementRunStatus;

    #[tokio::test]
    async fn requirement_run_round_trip_filters_and_sorts() {
        let store = MemoryRequirementRunStore::new();
        let r1 = RequirementRun::new("req-a", "conv-a-1");
        // Sleep so started_at differs at second resolution if the
        // platform clock is coarse — but mostly we rely on rfc3339
        // string ordering with sub-second precision.
        let mut r2 = RequirementRun::new("req-a", "conv-a-2");
        r2.started_at = "2027-01-01T00:00:00+00:00".into();
        let r3 = RequirementRun::new("req-b", "conv-b-1");

        store.upsert(&r1).await.unwrap();
        store.upsert(&r2).await.unwrap();
        store.upsert(&r3).await.unwrap();

        let only_a = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(only_a.len(), 2);
        // Newest first.
        assert_eq!(only_a[0].id, r2.id);
        assert_eq!(only_a[1].id, r1.id);

        let only_b = store.list_for_requirement("req-b").await.unwrap();
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].id, r3.id);
    }

    #[tokio::test]
    async fn requirement_run_subscribe_emits_started_then_finished() {
        let store = MemoryRequirementRunStore::new();
        let mut rx = store.subscribe();
        let mut r = RequirementRun::new("req", "conv");
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Started(run) => assert_eq!(run.id, r.id),
            other => panic!("expected Started, got {other:?}"),
        }

        // Flip terminal — should fire Finished.
        r.finish(RequirementRunStatus::Completed);
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Finished(run) => {
                assert_eq!(run.id, r.id);
                assert_eq!(run.status, RequirementRunStatus::Completed);
            }
            other => panic!("expected Finished, got {other:?}"),
        }

        // A no-op summary tweak on the now-terminal row should NOT
        // emit anything.
        r.summary = Some("cleaned up".into());
        store.upsert(&r).await.unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn requirement_run_inserted_terminal_emits_finished_only() {
        // If the first ever upsert is already terminal (e.g. the
        // server records a Cancelled run that never made it past
        // Pending), we should hear Finished, not Started.
        let store = MemoryRequirementRunStore::new();
        let mut rx = store.subscribe();
        let mut r = RequirementRun::new("req", "conv");
        r.finish(RequirementRunStatus::Cancelled);
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Finished(run) => assert_eq!(run.id, r.id),
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    // ---- AgentProfileStore ----------------------------------------------

    #[tokio::test]
    async fn agent_profile_round_trip_sorted_by_name() {
        let store = MemoryAgentProfileStore::new();
        let alice = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        let bob = AgentProfile::new("Bob", "anthropic", "claude-3-5-sonnet-latest");
        store.upsert(&bob).await.unwrap();
        store.upsert(&alice).await.unwrap();
        let listed = store.list().await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "Alice", "sorted by name asc");
        assert_eq!(listed[1].name, "Bob");
    }

    #[tokio::test]
    async fn agent_profile_subscribe_fires_on_upsert_and_delete() {
        let store = MemoryAgentProfileStore::new();
        let mut rx = store.subscribe();
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        store.upsert(&p).await.unwrap();
        match rx.recv().await.unwrap() {
            AgentProfileEvent::Upserted(got) => assert_eq!(got.id, p.id),
            other => panic!("expected Upserted, got {other:?}"),
        }
        store.delete(&p.id).await.unwrap();
        match rx.recv().await.unwrap() {
            AgentProfileEvent::Deleted { id } => assert_eq!(id, p.id),
            other => panic!("expected Deleted, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_profile_delete_no_op_does_not_emit() {
        let store = MemoryAgentProfileStore::new();
        let mut rx = store.subscribe();
        assert!(!store.delete("never").await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- ActivityStore --------------------------------------------------

    use harness_core::{ActivityActor, ActivityKind};
    use serde_json::json;

    #[tokio::test]
    async fn activity_append_and_list_filters_by_requirement() {
        let store = MemoryActivityStore::new();
        let a1 = Activity::new(
            "req-a",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({"from": "backlog", "to": "in_progress"}),
        );
        let mut a2 = Activity::new(
            "req-a",
            ActivityKind::RunStarted,
            ActivityActor::System,
            json!({"run_id": "r1"}),
        );
        a2.created_at = "2027-01-01T00:00:00+00:00".into();
        let a3 = Activity::new(
            "req-b",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({}),
        );

        store.append(&a1).await.unwrap();
        store.append(&a2).await.unwrap();
        store.append(&a3).await.unwrap();

        let only_a = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(only_a.len(), 2);
        // Newest first.
        assert_eq!(only_a[0].id, a2.id);
        assert_eq!(only_a[1].id, a1.id);

        let only_b = store.list_for_requirement("req-b").await.unwrap();
        assert_eq!(only_b.len(), 1);

        // Empty for unknown.
        assert!(store
            .list_for_requirement("never")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn activity_subscribe_emits_appended() {
        let store = MemoryActivityStore::new();
        let mut rx = store.subscribe();
        let a = Activity::new(
            "req",
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({"run_id": "r1", "status": "completed"}),
        );
        store.append(&a).await.unwrap();
        match rx.recv().await.unwrap() {
            ActivityEvent::Appended(got) => assert_eq!(got.id, a.id),
        }
    }

    // ---- DocStore -------------------------------------------------------

    use harness_core::DocKind;

    #[tokio::test]
    async fn doc_project_round_trip_filters_by_workspace() {
        let store = MemoryDocStore::new();
        let a = DocProject::new("/repo-a", "weekly review");
        let b = DocProject::new("/repo-b", "design doc");
        store.upsert_project(&a).await.unwrap();
        store.upsert_project(&b).await.unwrap();

        let only_a = store.list_projects("/repo-a").await.unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].id, a.id);

        let loaded = store.get_project(&a.id).await.unwrap().unwrap();
        assert_eq!(loaded, a);
    }

    #[tokio::test]
    async fn doc_delete_cascades_to_drafts() {
        let store = MemoryDocStore::new();
        let p = DocProject::new("/r", "x");
        store.upsert_project(&p).await.unwrap();
        let d1 = DocDraft::new(&p.id, "# draft one");
        let d2 = DocDraft::new(&p.id, "# draft two");
        store.upsert_draft(&d1).await.unwrap();
        store.upsert_draft(&d2).await.unwrap();
        assert_eq!(store.list_drafts(&p.id).await.unwrap().len(), 2);

        assert!(store.delete_project(&p.id).await.unwrap());
        assert!(store.list_drafts(&p.id).await.unwrap().is_empty());
        assert!(store.get_project(&p.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn doc_latest_draft_picks_newest() {
        let store = MemoryDocStore::new();
        let p = DocProject::new("/r", "x");
        store.upsert_project(&p).await.unwrap();
        let d1 = DocDraft::new(&p.id, "first");
        store.upsert_draft(&d1).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let d2 = DocDraft::new(&p.id, "second");
        store.upsert_draft(&d2).await.unwrap();

        let latest = store.latest_draft(&p.id).await.unwrap().unwrap();
        assert_eq!(latest.id, d2.id);
    }

    #[tokio::test]
    async fn doc_subscribe_fires_on_upsert_and_delete() {
        let store = MemoryDocStore::new();
        let mut rx = store.subscribe();
        let mut p = DocProject::new("/r", "x");
        p.kind = DocKind::Design;
        store.upsert_project(&p).await.unwrap();
        match rx.recv().await.unwrap() {
            DocEvent::ProjectUpserted(item) => assert_eq!(item.id, p.id),
            other => panic!("expected ProjectUpserted, got {other:?}"),
        }
        let d = DocDraft::new(&p.id, "body");
        store.upsert_draft(&d).await.unwrap();
        match rx.recv().await.unwrap() {
            DocEvent::DraftUpserted(item) => assert_eq!(item.id, d.id),
            other => panic!("expected DraftUpserted, got {other:?}"),
        }
        store.delete_project(&p.id).await.unwrap();
        match rx.recv().await.unwrap() {
            DocEvent::ProjectDeleted { workspace, id } => {
                assert_eq!(workspace, "/r");
                assert_eq!(id, p.id);
            }
            other => panic!("expected ProjectDeleted, got {other:?}"),
        }
    }
}
