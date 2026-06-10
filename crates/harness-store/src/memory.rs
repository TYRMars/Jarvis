//! In-process [`ConversationStore`](harness_core::ConversationStore) and
//! [`ProjectStore`](harness_project::ProjectStore).
//!
//! Useful for tests and as the zero-dep reference impl of both traits.
//! Not intended for production — data is lost when the process exits.

use std::collections::HashMap;
use std::sync::Arc;

use crate::StoreError;
use async_trait::async_trait;
use chrono::Utc;
use harness_automation::{AutomationStore, AutomationTask};
use harness_channel::{ChannelBinding, ChannelBindingStore};
use harness_workflow::{WorkflowDefinition, WorkflowRun, WorkflowStore};
use harness_learning::{
    fold_events_into_rows, validate_memory_safe, MemoryFilter, MemoryItem, MemoryPatch,
    MemoryStore, SkillLifecycle, SkillLifecycleStore, SkillUsageEvent, SkillUsageFilter,
    SkillUsageRow, SkillUsageStore,
};
use harness_core::{
    AgentProfile, AgentProfileEvent, AgentProfileStore, BoxError, Conversation,
    ConversationMetadata, ConversationRecord, ConversationStore, Tenant, TenantStore, TodoEvent,
    TodoItem, TodoStore,
};
use harness_project::{
    Activity, ActivityEvent, ActivityStore, Comment, CommentEvent, CommentStore, DocDraft,
    DocEvent, DocProject, DocStore, Label, LabelEvent, LabelStore, Project, ProjectMemory,
    ProjectMemoryStore, ProjectStore, Requirement, RequirementEvent, RequirementRun,
    RequirementRunEvent, RequirementRunStore, RequirementStore,
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
                lifecycle: e.metadata.lifecycle,
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

#[derive(Clone)]
pub struct MemoryAutomationStore {
    inner: Arc<RwLock<HashMap<String, AutomationTask>>>,
}

impl Default for MemoryAutomationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryAutomationStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl AutomationStore for MemoryAutomationStore {
    async fn list(&self) -> Result<Vec<AutomationTask>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<AutomationTask> = guard.values().cloned().collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<AutomationTask>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(&self, task: &AutomationTask) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        guard.insert(task.id.clone(), task.clone());
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

/// In-process [`WorkflowStore`] holding both definitions and runs in
/// separate maps. Useful for tests and as the SQL-backend fallback until
/// a SQL impl lands.
#[derive(Clone, Default)]
pub struct MemoryWorkflowStore {
    defs: Arc<RwLock<HashMap<String, WorkflowDefinition>>>,
    runs: Arc<RwLock<HashMap<String, WorkflowRun>>>,
}

impl MemoryWorkflowStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl WorkflowStore for MemoryWorkflowStore {
    async fn list(&self) -> Result<Vec<WorkflowDefinition>, BoxError> {
        let guard = self.defs.read().await;
        let mut rows: Vec<WorkflowDefinition> = guard.values().cloned().collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<WorkflowDefinition>, BoxError> {
        Ok(self.defs.read().await.get(id).cloned())
    }

    async fn upsert(&self, def: &WorkflowDefinition) -> Result<(), BoxError> {
        self.defs.write().await.insert(def.id.clone(), def.clone());
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        Ok(self.defs.write().await.remove(id).is_some())
    }

    async fn list_runs(
        &self,
        workflow_id: Option<&str>,
        requirement_id: Option<&str>,
    ) -> Result<Vec<WorkflowRun>, BoxError> {
        let guard = self.runs.read().await;
        let mut rows: Vec<WorkflowRun> = guard
            .values()
            .filter(|r| {
                workflow_id.map_or(true, |w| r.workflow_id == w)
                    && requirement_id.map_or(true, |req| r.requirement_id.as_deref() == Some(req))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(rows)
    }

    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRun>, BoxError> {
        Ok(self.runs.read().await.get(run_id).cloned())
    }

    async fn upsert_run(&self, run: &WorkflowRun) -> Result<(), BoxError> {
        self.runs.write().await.insert(run.id.clone(), run.clone());
        Ok(())
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

/// In-process [`ProjectMemoryStore`]. Memories keyed by id; project
/// scoping is a runtime filter on `list`. Insert/update overwrite
/// by id with no broadcast — memories don't drive realtime UI.
#[derive(Default, Clone)]
pub struct MemoryProjectMemoryStore {
    inner: Arc<RwLock<HashMap<String, ProjectMemory>>>,
}

impl MemoryProjectMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ProjectMemoryStore for MemoryProjectMemoryStore {
    async fn list(&self, project_id: &str) -> Result<Vec<ProjectMemory>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<ProjectMemory> = guard
            .values()
            .filter(|m| m.project_id == project_id)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        if rows.len() > 200 {
            tracing::warn!(
                project_id,
                count = rows.len(),
                "project memory list exceeded 200-item soft cap"
            );
            rows.truncate(200);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<ProjectMemory>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(&self, memory: &ProjectMemory) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        guard.insert(memory.id.clone(), memory.clone());
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
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

// ---------- CommentStore --------------------------------------------------

/// In-process [`CommentStore`]. Comments stored by `requirement_id`
/// in a `HashMap<String, Vec<Comment>>` behind one `RwLock`.
/// Single broadcast fanout shared via `Arc`. Behaviourally identical
/// to the JSON / SQL backends; used as the test reference impl.
#[derive(Clone)]
pub struct MemoryCommentStore {
    inner: Arc<RwLock<HashMap<String, Vec<Comment>>>>,
    tx: broadcast::Sender<CommentEvent>,
}

impl Default for MemoryCommentStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryCommentStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl CommentStore for MemoryCommentStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows = guard.get(requirement_id).cloned().unwrap_or_default();
        // Oldest-first (chat order).
        rows.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        if rows.len() > 500 {
            tracing::warn!(
                requirement_id,
                count = rows.len(),
                "comment list exceeded 500-item soft cap"
            );
            rows.truncate(500);
        }
        Ok(rows)
    }

    async fn create(&self, comment: &Comment) -> Result<(), BoxError> {
        // Validate parent_id depth-1 invariant before writing.
        if let Some(parent_id) = comment.parent_id.as_deref() {
            let guard = self.inner.read().await;
            let bucket = guard.get(&comment.requirement_id);
            let parent = bucket.and_then(|rows| rows.iter().find(|c| c.id == parent_id));
            match parent {
                None => {
                    return Err(
                        format!("parent comment `{parent_id}` not found in requirement").into(),
                    )
                }
                Some(p) if p.parent_id.is_some() => {
                    return Err(
                        "comment threading is limited to depth 1 (cannot reply to a reply)".into(),
                    )
                }
                _ => {}
            }
        }
        {
            let mut guard = self.inner.write().await;
            let list = guard.entry(comment.requirement_id.clone()).or_default();
            // Reject duplicate id (caller bug). Mirrors the JSON / SQL
            // behaviour of failing the atomic write rather than silently
            // overwriting on `create`.
            if list.iter().any(|c| c.id == comment.id) {
                return Err(format!("comment id `{}` already exists", comment.id).into());
            }
            list.push(comment.clone());
        }
        let _ = self.tx.send(CommentEvent::Posted(comment.clone()));
        Ok(())
    }

    async fn update(&self, comment: &Comment) -> Result<bool, BoxError> {
        let updated = {
            let mut guard = self.inner.write().await;
            let Some(list) = guard.get_mut(&comment.requirement_id) else {
                return Ok(false);
            };
            let Some(slot) = list.iter_mut().find(|c| c.id == comment.id) else {
                return Ok(false);
            };
            // The trait pins `id`, `requirement_id`, `parent_id`,
            // `author`, `created_at` as immutable. We overwrite
            // `body` + `updated_at` and leave the rest of the in-memory
            // row untouched.
            slot.body = comment.body.clone();
            slot.updated_at = comment.updated_at.clone();
            slot.clone()
        };
        let _ = self.tx.send(CommentEvent::Edited(updated));
        Ok(true)
    }

    async fn delete(&self, requirement_id: &str, comment_id: &str) -> Result<bool, BoxError> {
        // Cascade: collect ids to remove (top-level + its replies).
        let removed_ids: Vec<String> = {
            let mut guard = self.inner.write().await;
            let Some(list) = guard.get_mut(requirement_id) else {
                return Ok(false);
            };
            let target_idx = match list.iter().position(|c| c.id == comment_id) {
                Some(i) => i,
                None => return Ok(false),
            };
            let target_is_top_level = list[target_idx].parent_id.is_none();
            let target_id = list[target_idx].id.clone();
            let mut to_remove = vec![target_id.clone()];
            if target_is_top_level {
                for c in list.iter() {
                    if c.parent_id.as_deref() == Some(target_id.as_str()) {
                        to_remove.push(c.id.clone());
                    }
                }
            }
            list.retain(|c| !to_remove.contains(&c.id));
            to_remove
        };
        for id in removed_ids {
            let _ = self.tx.send(CommentEvent::Deleted {
                requirement_id: requirement_id.to_string(),
                comment_id: id,
            });
        }
        Ok(true)
    }

    fn subscribe(&self) -> broadcast::Receiver<CommentEvent> {
        self.tx.subscribe()
    }
}

// ---------- LabelStore ----------------------------------------------------

/// In-process [`LabelStore`]. Labels stored by `project_id` in a
/// `HashMap<String, Vec<Label>>`. Name uniqueness is checked
/// case-insensitively per project.
#[derive(Clone)]
pub struct MemoryLabelStore {
    inner: Arc<RwLock<HashMap<String, Vec<Label>>>>,
    tx: broadcast::Sender<LabelEvent>,
}

impl Default for MemoryLabelStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryLabelStore {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }
}

#[async_trait]
impl LabelStore for MemoryLabelStore {
    async fn list_for_project(&self, project_id: &str) -> Result<Vec<Label>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows = guard.get(project_id).cloned().unwrap_or_default();
        rows.sort_by_key(|l| l.name.to_lowercase());
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<Label>, BoxError> {
        let guard = self.inner.read().await;
        for bucket in guard.values() {
            if let Some(l) = bucket.iter().find(|l| l.id == id) {
                return Ok(Some(l.clone()));
            }
        }
        Ok(None)
    }

    async fn create(&self, label: &Label) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        let bucket = guard.entry(label.project_id.clone()).or_default();
        let lower = label.name.to_lowercase();
        if bucket
            .iter()
            .any(|l| l.name.eq_ignore_ascii_case(&label.name))
        {
            return Err(format!("label name `{}` already exists in project", label.name).into());
        }
        if bucket.iter().any(|l| l.id == label.id) {
            return Err(format!("label id `{}` already exists", label.id).into());
        }
        let _ = lower; // silence "unused" if we ever drop the case-fold check
        bucket.push(label.clone());
        let _ = self.tx.send(LabelEvent::Created(label.clone()));
        Ok(())
    }

    async fn update(&self, label: &Label) -> Result<bool, BoxError> {
        let updated = {
            let mut guard = self.inner.write().await;
            let Some(bucket) = guard.get_mut(&label.project_id) else {
                return Ok(false);
            };
            // Name-uniqueness check skips the row we're about to update.
            let conflict = bucket
                .iter()
                .any(|l| l.id != label.id && l.name.eq_ignore_ascii_case(&label.name));
            if conflict {
                return Err(
                    format!("label name `{}` already exists in project", label.name).into(),
                );
            }
            let Some(slot) = bucket.iter_mut().find(|l| l.id == label.id) else {
                return Ok(false);
            };
            slot.name = label.name.clone();
            slot.colour = label.colour.clone();
            slot.description = label.description.clone();
            slot.updated_at = label.updated_at.clone();
            slot.clone()
        };
        let _ = self.tx.send(LabelEvent::Updated(updated));
        Ok(true)
    }

    async fn delete(&self, project_id: &str, label_id: &str) -> Result<bool, BoxError> {
        let removed = {
            let mut guard = self.inner.write().await;
            let Some(bucket) = guard.get_mut(project_id) else {
                return Ok(false);
            };
            let before = bucket.len();
            bucket.retain(|l| l.id != label_id);
            before != bucket.len()
        };
        if removed {
            let _ = self.tx.send(LabelEvent::Deleted {
                project_id: project_id.to_string(),
                label_id: label_id.to_string(),
            });
        }
        Ok(removed)
    }

    fn subscribe(&self) -> broadcast::Receiver<LabelEvent> {
        self.tx.subscribe()
    }
}

// ---------- TenantStore -------------------------------------------------

/// In-process [`TenantStore`]. Tenants keyed by id; slug uniqueness is
/// enforced by a linear scan inside `save`.
#[derive(Default, Clone)]
pub struct MemoryTenantStore {
    inner: Arc<RwLock<HashMap<String, Tenant>>>,
}

impl MemoryTenantStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl TenantStore for MemoryTenantStore {
    async fn save(&self, tenant: &Tenant) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        for (id, existing) in guard.iter() {
            if id != &tenant.id && existing.slug == tenant.slug {
                return Err(StoreError::DuplicateSlug(tenant.slug.clone()).into());
            }
        }
        guard.insert(tenant.id.clone(), tenant.clone());
        Ok(())
    }

    async fn load(&self, id: &str) -> Result<Option<Tenant>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Tenant>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.values().find(|t| t.slug == slug).cloned())
    }

    async fn list(&self) -> Result<Vec<Tenant>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<Tenant> = guard.values().filter(|t| !t.archived).cloned().collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        if let Some(t) = guard.get_mut(id) {
            t.archive();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

/// In-process [`ChannelBindingStore`]. Bindings keyed by
/// `(channel, channel_chat_id)` — concatenated with a `\0` separator
/// because both halves are caller-supplied strings and `\0` is the
/// only byte we can guarantee won't appear in either.
#[derive(Default, Clone)]
pub struct MemoryChannelBindingStore {
    inner: Arc<RwLock<HashMap<String, ChannelBinding>>>,
}

impl MemoryChannelBindingStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn channel_binding_key(channel: &str, chat_id: &str) -> String {
    format!("{channel}\0{chat_id}")
}

#[async_trait]
impl ChannelBindingStore for MemoryChannelBindingStore {
    async fn upsert(&self, binding: &ChannelBinding) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        guard.insert(
            channel_binding_key(&binding.channel, &binding.channel_chat_id),
            binding.clone(),
        );
        Ok(())
    }

    async fn lookup(
        &self,
        channel: &str,
        channel_chat_id: &str,
    ) -> Result<Option<ChannelBinding>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard
            .get(&channel_binding_key(channel, channel_chat_id))
            .cloned())
    }

    async fn list_for_channel(&self, channel: &str) -> Result<Vec<ChannelBinding>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<ChannelBinding> = guard
            .values()
            .filter(|b| b.channel == channel)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn delete(&self, channel: &str, channel_chat_id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard
            .remove(&channel_binding_key(channel, channel_chat_id))
            .is_some())
    }

    async fn delete_for_conversation(&self, conversation_id: &str) -> Result<usize, BoxError> {
        let mut guard = self.inner.write().await;
        let before = guard.len();
        guard.retain(|_, b| b.conversation_id != conversation_id);
        Ok(before - guard.len())
    }
}

/// In-process [`ChannelInstanceStore`]. Settings-page rows; keyed by
/// the instance's stable UUID.
#[derive(Default, Clone)]
pub struct MemoryChannelInstanceStore {
    inner: Arc<RwLock<HashMap<String, harness_channel::ChannelInstance>>>,
}

impl MemoryChannelInstanceStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl harness_channel::ChannelInstanceStore for MemoryChannelInstanceStore {
    async fn upsert(&self, instance: &harness_channel::ChannelInstance) -> Result<(), BoxError> {
        let mut guard = self.inner.write().await;
        guard.insert(instance.id.clone(), instance.clone());
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<harness_channel::ChannelInstance>, BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn list(&self) -> Result<Vec<harness_channel::ChannelInstance>, BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<harness_channel::ChannelInstance> = guard.values().cloned().collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

/// In-memory [`SkillUsageStore`] for tests and the zero-config reference
/// path. Events live in a single `Vec` behind an async `RwLock`; ids are
/// stamped from a monotonic counter so concurrent writes get distinct ids
/// inside the same nanosecond.
#[derive(Default, Clone)]
pub struct MemorySkillUsageStore {
    inner: Arc<RwLock<Vec<SkillUsageEvent>>>,
}

impl MemorySkillUsageStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl SkillUsageStore for MemorySkillUsageStore {
    async fn record_event(
        &self,
        mut event: SkillUsageEvent,
    ) -> Result<SkillUsageEvent, harness_learning::BoxError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        if event.created_at.is_empty() {
            event.created_at = Utc::now().to_rfc3339();
        }
        if event.id.is_empty() {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            event.id = format!("{}-{n:08}", event.created_at);
        }
        let mut guard = self.inner.write().await;
        guard.push(event.clone());
        Ok(event)
    }

    async fn list_events(
        &self,
        filter: SkillUsageFilter,
    ) -> Result<Vec<SkillUsageEvent>, harness_learning::BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<SkillUsageEvent> = guard
            .iter()
            .filter(|r| {
                filter.skill_name.as_ref().map_or(true, |n| &r.skill_name == n)
                    && filter.scope.as_ref().map_or(true, |s| &r.scope == s)
                    && filter.action.as_ref().map_or(true, |a| &r.action == a)
                    && filter
                        .conversation_id
                        .as_ref()
                        .map_or(true, |c| r.conversation_id.as_deref() == Some(c.as_str()))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if let Some(limit) = filter.limit {
            rows.truncate(limit as usize);
        }
        Ok(rows)
    }

    async fn report(
        &self,
        filter: SkillUsageFilter,
    ) -> Result<Vec<SkillUsageRow>, harness_learning::BoxError> {
        let mut wide = filter.clone();
        wide.limit = None;
        let events = self.list_events(wide).await?;
        Ok(fold_events_into_rows(events))
    }
}

/// In-memory [`MemoryStore`] for tests and the zero-config reference
/// path. Rows live in a `HashMap` keyed by id behind an async `RwLock`.
#[derive(Default, Clone)]
pub struct MemoryMemoryStore {
    inner: Arc<RwLock<HashMap<String, MemoryItem>>>,
}

impl MemoryMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl MemoryStore for MemoryMemoryStore {
    async fn list(
        &self,
        filter: MemoryFilter,
    ) -> Result<Vec<MemoryItem>, harness_learning::BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<MemoryItem> = guard
            .values()
            .filter(|r| {
                filter.scope.as_ref().map_or(true, |s| &r.scope == s)
                    && filter.kind.as_ref().map_or(true, |k| &r.kind == k)
                    && filter.pinned.map_or(true, |p| r.pinned == p)
                    && filter
                        .tags
                        .iter()
                        .all(|req| r.tags.iter().any(|t| t == req))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        if let Some(limit) = filter.limit {
            rows.truncate(limit as usize);
        }
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<MemoryItem>, harness_learning::BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(id).cloned())
    }

    async fn upsert(
        &self,
        mut item: MemoryItem,
    ) -> Result<MemoryItem, harness_learning::BoxError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let now = Utc::now().to_rfc3339();
        if item.created_at.is_empty() {
            item.created_at = now.clone();
        }
        item.updated_at = now.clone();
        if item.id.is_empty() {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            item.id = format!("mem_{now}-{n:08}");
        }
        let mut guard = self.inner.write().await;
        guard.insert(item.id.clone(), item.clone());
        Ok(item)
    }

    /// Atomic read-modify-write: the whole get → apply → validate →
    /// insert sequence runs under a single write-lock acquisition, so it
    /// serialises against concurrent `patch` (no lost update) and against
    /// `delete` (which takes the same lock). A `delete` that wins the
    /// race leaves the id absent, so we return `Ok(None)` instead of
    /// re-inserting a zombie row.
    async fn patch(
        &self,
        id: &str,
        patch: MemoryPatch,
    ) -> Result<Option<MemoryItem>, harness_learning::BoxError> {
        let mut guard = self.inner.write().await;
        let Some(existing) = guard.get(id) else {
            return Ok(None);
        };
        let mut item = existing.clone();
        patch.apply(&mut item);
        validate_memory_safe(&item)
            .map_err(|e| -> harness_learning::BoxError { Box::new(e) })?;
        item.updated_at = Utc::now().to_rfc3339();
        guard.insert(item.id.clone(), item.clone());
        Ok(Some(item))
    }

    async fn delete(&self, id: &str) -> Result<bool, harness_learning::BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(id).is_some())
    }
}

/// In-memory [`SkillLifecycleStore`] for tests / zero-config use.
/// Keyed by `skill_name`.
#[derive(Default, Clone)]
pub struct MemorySkillLifecycleStore {
    inner: Arc<RwLock<HashMap<String, SkillLifecycle>>>,
}

impl MemorySkillLifecycleStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl SkillLifecycleStore for MemorySkillLifecycleStore {
    async fn list(&self) -> Result<Vec<SkillLifecycle>, harness_learning::BoxError> {
        let guard = self.inner.read().await;
        let mut rows: Vec<SkillLifecycle> = guard.values().cloned().collect();
        rows.sort_by(|a, b| a.skill_name.cmp(&b.skill_name));
        Ok(rows)
    }

    async fn get(
        &self,
        skill_name: &str,
    ) -> Result<Option<SkillLifecycle>, harness_learning::BoxError> {
        let guard = self.inner.read().await;
        Ok(guard.get(skill_name).cloned())
    }

    async fn upsert(
        &self,
        mut row: SkillLifecycle,
    ) -> Result<SkillLifecycle, harness_learning::BoxError> {
        let now = Utc::now().to_rfc3339();
        if row.created_at.is_empty() {
            row.created_at = now.clone();
        }
        row.updated_at = now;
        let mut guard = self.inner.write().await;
        guard.insert(row.skill_name.clone(), row.clone());
        Ok(row)
    }

    async fn delete(&self, skill_name: &str) -> Result<bool, harness_learning::BoxError> {
        let mut guard = self.inner.write().await;
        Ok(guard.remove(skill_name).is_some())
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

    use harness_project::RequirementStatus;

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

    use harness_project::RequirementRunStatus;

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

    use harness_project::{ActivityActor, ActivityKind};
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

    // ---- CommentStore ---------------------------------------------------
    // (`ActivityActor` is already in scope from the activity tests above.)

    #[tokio::test]
    async fn comment_create_and_list_returns_oldest_first() {
        let store = MemoryCommentStore::new();
        let mut c1 = Comment::new("req-a", ActivityActor::Human, "first");
        c1.created_at = "2026-01-01T00:00:00+00:00".into();
        c1.updated_at = c1.created_at.clone();
        let mut c2 = Comment::new("req-a", ActivityActor::Human, "second");
        c2.created_at = "2026-01-02T00:00:00+00:00".into();
        c2.updated_at = c2.created_at.clone();
        let other = Comment::new("req-b", ActivityActor::Human, "elsewhere");
        store.create(&c1).await.unwrap();
        store.create(&c2).await.unwrap();
        store.create(&other).await.unwrap();

        let only_a = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(only_a.len(), 2);
        // Oldest-first.
        assert_eq!(only_a[0].id, c1.id);
        assert_eq!(only_a[1].id, c2.id);
    }

    #[tokio::test]
    async fn comment_create_rejects_duplicate_id() {
        let store = MemoryCommentStore::new();
        let c = Comment::new("req-a", ActivityActor::Human, "v1");
        store.create(&c).await.unwrap();
        let err = store.create(&c).await.unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn comment_create_validates_parent_exists_and_depth() {
        let store = MemoryCommentStore::new();
        let top = Comment::new("req-a", ActivityActor::Human, "top");
        store.create(&top).await.unwrap();

        // Reply to a top-level comment — fine.
        let reply1 = Comment::reply("req-a", ActivityActor::Human, "r1", &top.id);
        store.create(&reply1).await.unwrap();

        // Reply to a reply — depth-1 violation, must fail.
        let reply2 = Comment::reply("req-a", ActivityActor::Human, "r2", &reply1.id);
        let err = store.create(&reply2).await.unwrap_err();
        assert!(err.to_string().contains("depth 1"));

        // Reply to an unknown id — must fail.
        let stray = Comment::reply("req-a", ActivityActor::Human, "stray", "no-such-id");
        let err = store.create(&stray).await.unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn comment_update_only_touches_body_and_updated_at() {
        let store = MemoryCommentStore::new();
        let mut c = Comment::new("req-a", ActivityActor::Human, "original");
        store.create(&c).await.unwrap();
        let original_created = c.created_at.clone();

        c.edit("revised");
        let ok = store.update(&c).await.unwrap();
        assert!(ok);

        let rows = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].body, "revised");
        assert_eq!(rows[0].created_at, original_created, "created_at immutable");
    }

    #[tokio::test]
    async fn comment_update_returns_false_for_unknown() {
        let store = MemoryCommentStore::new();
        let c = Comment::new("req-a", ActivityActor::Human, "ghost");
        let ok = store.update(&c).await.unwrap();
        assert!(!ok);
    }

    #[tokio::test]
    async fn comment_delete_top_level_cascades_to_replies() {
        let store = MemoryCommentStore::new();
        let top = Comment::new("req-a", ActivityActor::Human, "top");
        store.create(&top).await.unwrap();
        let r1 = Comment::reply("req-a", ActivityActor::Human, "r1", &top.id);
        store.create(&r1).await.unwrap();
        let r2 = Comment::reply("req-a", ActivityActor::Human, "r2", &top.id);
        store.create(&r2).await.unwrap();
        let unrelated = Comment::new("req-a", ActivityActor::Human, "elsewhere");
        store.create(&unrelated).await.unwrap();

        let removed = store.delete("req-a", &top.id).await.unwrap();
        assert!(removed);

        let rows = store.list_for_requirement("req-a").await.unwrap();
        assert_eq!(rows.len(), 1, "only the unrelated row remains");
        assert_eq!(rows[0].id, unrelated.id);
    }

    #[tokio::test]
    async fn comment_subscribe_emits_posted_edited_deleted() {
        let store = MemoryCommentStore::new();
        let mut rx = store.subscribe();
        let mut c = Comment::new("req-a", ActivityActor::Human, "v1");
        store.create(&c).await.unwrap();
        match rx.recv().await.unwrap() {
            CommentEvent::Posted(got) => assert_eq!(got.id, c.id),
            other => panic!("expected Posted, got {other:?}"),
        }
        c.edit("v2");
        store.update(&c).await.unwrap();
        match rx.recv().await.unwrap() {
            CommentEvent::Edited(got) => assert_eq!(got.body, "v2"),
            other => panic!("expected Edited, got {other:?}"),
        }
        store.delete("req-a", &c.id).await.unwrap();
        match rx.recv().await.unwrap() {
            CommentEvent::Deleted {
                requirement_id,
                comment_id,
            } => {
                assert_eq!(requirement_id, "req-a");
                assert_eq!(comment_id, c.id);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }
    }

    // ---- LabelStore -----------------------------------------------------

    #[tokio::test]
    async fn label_create_and_list_sorts_by_name_case_insensitive() {
        let store = MemoryLabelStore::new();
        store
            .create(&Label::new("proj-1", "zebra", "#000000"))
            .await
            .unwrap();
        store
            .create(&Label::new("proj-1", "Apple", "#ff0000"))
            .await
            .unwrap();
        store
            .create(&Label::new("proj-1", "banana", "#ffff00"))
            .await
            .unwrap();
        // Different project, should not bleed into proj-1's list.
        store
            .create(&Label::new("proj-2", "elsewhere", "#00ff00"))
            .await
            .unwrap();

        let rows = store.list_for_project("proj-1").await.unwrap();
        let names: Vec<_> = rows.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["Apple", "banana", "zebra"]);
    }

    #[tokio::test]
    async fn label_create_rejects_duplicate_name_case_insensitive() {
        let store = MemoryLabelStore::new();
        store
            .create(&Label::new("proj-1", "Bug", "#ff0000"))
            .await
            .unwrap();
        let err = store
            .create(&Label::new("proj-1", "BUG", "#00ff00"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn label_get_finds_across_projects() {
        let store = MemoryLabelStore::new();
        let l1 = Label::new("proj-1", "bug", "#ff0000");
        let l2 = Label::new("proj-2", "feature", "#00ff00");
        store.create(&l1).await.unwrap();
        store.create(&l2).await.unwrap();
        assert_eq!(store.get(&l1.id).await.unwrap().unwrap(), l1);
        assert_eq!(store.get(&l2.id).await.unwrap().unwrap(), l2);
        assert!(store.get("missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn label_update_skips_self_in_uniqueness_check() {
        let store = MemoryLabelStore::new();
        let mut l = Label::new("proj-1", "bug", "#ff0000");
        store.create(&l).await.unwrap();
        // Recolour without renaming → must not trip on its own name.
        l.colour = "#0000ff".into();
        l.touch();
        assert!(store.update(&l).await.unwrap());
        let got = store.get(&l.id).await.unwrap().unwrap();
        assert_eq!(got.colour, "#0000ff");
    }

    #[tokio::test]
    async fn label_update_blocks_collision_with_other_label() {
        let store = MemoryLabelStore::new();
        let l1 = Label::new("proj-1", "bug", "#ff0000");
        let mut l2 = Label::new("proj-1", "feature", "#00ff00");
        store.create(&l1).await.unwrap();
        store.create(&l2).await.unwrap();
        // Try to rename l2 → "bug": must fail.
        l2.name = "Bug".into();
        let err = store.update(&l2).await.unwrap_err();
        assert!(err.to_string().contains("already exists"));
    }

    #[tokio::test]
    async fn label_delete_returns_false_for_unknown() {
        let store = MemoryLabelStore::new();
        let removed = store.delete("proj-1", "nope").await.unwrap();
        assert!(!removed);
    }

    #[tokio::test]
    async fn label_subscribe_emits_create_update_delete() {
        let store = MemoryLabelStore::new();
        let mut rx = store.subscribe();
        let mut l = Label::new("proj-1", "bug", "#ff0000");
        store.create(&l).await.unwrap();
        match rx.recv().await.unwrap() {
            LabelEvent::Created(got) => assert_eq!(got.id, l.id),
            other => panic!("expected Created, got {other:?}"),
        }
        l.colour = "#00ff00".into();
        l.touch();
        store.update(&l).await.unwrap();
        match rx.recv().await.unwrap() {
            LabelEvent::Updated(got) => assert_eq!(got.colour, "#00ff00"),
            other => panic!("expected Updated, got {other:?}"),
        }
        store.delete("proj-1", &l.id).await.unwrap();
        match rx.recv().await.unwrap() {
            LabelEvent::Deleted {
                project_id,
                label_id,
            } => {
                assert_eq!(project_id, "proj-1");
                assert_eq!(label_id, l.id);
            }
            other => panic!("expected Deleted, got {other:?}"),
        }
    }

    // ---- TenantStore ----------------------------------------------------

    #[tokio::test]
    async fn first_start_creates_default_tenant() {
        let store = MemoryTenantStore::new();
        crate::ensure_default_tenant(Arc::new(store.clone()))
            .await
            .unwrap();
        let t = store.find_by_slug("default").await.unwrap().unwrap();
        assert_eq!(t.slug, "default");
        assert_eq!(t.name, "Default");

        // Idempotent — second call must not create a duplicate.
        crate::ensure_default_tenant(Arc::new(store.clone()))
            .await
            .unwrap();
        let list = store.list().await.unwrap();
        assert_eq!(list.len(), 1);
    }

    #[tokio::test]
    async fn tenant_save_rejects_duplicate_slug() {
        let store = MemoryTenantStore::new();
        let a = Tenant::new("A").with_slug("dup");
        let b = Tenant::new("B").with_slug("dup");
        store.save(&a).await.unwrap();
        let err = store.save(&b).await.unwrap_err();
        assert!(err.to_string().contains("dup"));
    }

    // ---- DocStore -------------------------------------------------------

    use harness_project::DocKind;

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

    #[tokio::test]
    async fn channel_binding_roundtrip() {
        let store = MemoryChannelBindingStore::new();
        let b = ChannelBinding::new("wecom", "wm-group-1", "conv-1", Some("u1".into()), None);
        store.upsert(&b).await.unwrap();

        let got = store.lookup("wecom", "wm-group-1").await.unwrap().unwrap();
        assert_eq!(got.conversation_id, "conv-1");
        assert_eq!(got.channel_user_id.as_deref(), Some("u1"));

        // Different chat id under same channel does not collide.
        assert!(store.lookup("wecom", "wm-group-2").await.unwrap().is_none());
        // Different channel + same chat id does not collide either.
        assert!(store
            .lookup("feishu", "wm-group-1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn channel_binding_list_orders_newest_first_per_channel() {
        let store = MemoryChannelBindingStore::new();
        let mut b1 = ChannelBinding::new("wecom", "chat-a", "conv-a", None, Some("Alice".into()));
        // Older — set updated_at to an explicit older RFC-3339 string.
        b1.updated_at = "2026-01-01T00:00:00Z".into();
        store.upsert(&b1).await.unwrap();
        let mut b2 = ChannelBinding::new("wecom", "chat-b", "conv-b", None, None);
        b2.updated_at = "2026-05-09T00:00:00Z".into();
        store.upsert(&b2).await.unwrap();
        // Different channel — must not appear in `list_for_channel("wecom")`.
        let other = ChannelBinding::new("feishu", "chat-x", "conv-x", None, None);
        store.upsert(&other).await.unwrap();

        let rows = store.list_for_channel("wecom").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].channel_chat_id, "chat-b");
        assert_eq!(rows[1].channel_chat_id, "chat-a");
    }

    #[tokio::test]
    async fn channel_binding_delete_for_conversation_removes_all_pointers() {
        let store = MemoryChannelBindingStore::new();
        store
            .upsert(&ChannelBinding::new("wecom", "g1", "shared", None, None))
            .await
            .unwrap();
        store
            .upsert(&ChannelBinding::new("feishu", "f1", "shared", None, None))
            .await
            .unwrap();
        store
            .upsert(&ChannelBinding::new("wecom", "g2", "kept", None, None))
            .await
            .unwrap();

        let removed = store.delete_for_conversation("shared").await.unwrap();
        assert_eq!(removed, 2);
        assert!(store.lookup("wecom", "g1").await.unwrap().is_none());
        assert!(store.lookup("feishu", "f1").await.unwrap().is_none());
        // The unrelated binding survives.
        assert!(store.lookup("wecom", "g2").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn memory_patch_applies_and_refreshes_updated_at() {
        use harness_learning::{MemoryKind, MemoryScope};
        let store = MemoryMemoryStore::new();
        let saved = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Fact,
                "old",
                "body",
            ))
            .await
            .unwrap();
        let patched = store
            .patch(
                &saved.id,
                MemoryPatch {
                    title: Some("new".into()),
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .expect("row exists");
        assert_eq!(patched.title, "new");
        assert!(patched.pinned);
        assert_eq!(patched.body, "body", "unspecified fields untouched");
        assert!(patched.updated_at >= saved.updated_at);
    }

    #[tokio::test]
    async fn memory_patch_loses_to_delete_no_resurrection() {
        use harness_learning::{MemoryFilter, MemoryKind, MemoryScope};
        let store = MemoryMemoryStore::new();
        let saved = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Fact,
                "t",
                "b",
            ))
            .await
            .unwrap();
        // Delete wins: a patch against the now-missing id must not
        // re-insert a zombie row.
        assert!(store.delete(&saved.id).await.unwrap());
        let out = store
            .patch(
                &saved.id,
                MemoryPatch {
                    title: Some("zombie".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(out.is_none(), "patch on deleted row returns None");
        let all = store.list(MemoryFilter::default()).await.unwrap();
        assert!(all.is_empty(), "no row resurrected");
    }

    #[tokio::test]
    async fn memory_patch_rejects_empty_body() {
        use harness_learning::{MemoryKind, MemoryScope};
        let store = MemoryMemoryStore::new();
        let saved = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Fact,
                "t",
                "b",
            ))
            .await
            .unwrap();
        let err = store
            .patch(
                &saved.id,
                MemoryPatch {
                    body: Some("   ".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("empty"));
        // Original body untouched — rejected patch leaves no trace.
        let row = store.get(&saved.id).await.unwrap().unwrap();
        assert_eq!(row.body, "b");
    }
}
