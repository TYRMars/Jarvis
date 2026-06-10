//! On-disk JSON-file [`ConversationStore`](harness_core::ConversationStore)
//! and [`ProjectStore`](harness_project::ProjectStore).
//!
//! One JSON file per record, all in a directory. The simplest possible
//! "real" backend — no external dependency, no migrations, no daemon.
//! Suited to single-user / dev / "I just want it to work" deployments.
//! For multi-process or large-scale use, prefer the
//! sqlite / postgres / mysql backends.
//!
//! ## Layout
//!
//! ```text
//! <dir>/
//!   <id>.json                 # one per conversation
//!   <id>.json.tmp             # transient, only during writes
//!   projects/
//!     <project_id>.json       # one per project
//!     <project_id>.json.tmp
//! ```
//!
//! Conversations and projects live in sibling stores
//! ([`JsonFileConversationStore`] / [`JsonFileProjectStore`]) which
//! share a base directory but otherwise hold no shared state.
//!
//! ## ID → filename
//!
//! The harness uses arbitrary strings as conversation ids (UUIDs by
//! default, but `__memory__.summary:<hash>` for the summary cache).
//! `:` is illegal on Windows filenames, so we **percent-encode** any
//! byte that isn't `[A-Za-z0-9._-]` for the filename, and decode
//! again on `list()`. UUIDs round-trip without any escaping.
//!
//! ## Atomicity
//!
//! Writes go to `<id>.json.tmp` first and rename onto `<id>.json` —
//! a crash mid-write leaves the previous good file untouched.
//! Concurrent writers to the same id race; last-write-wins is the
//! contract (the trait offers no read-modify-write semantics).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::Utc;
use harness_automation::{AutomationStore, AutomationTask};
use harness_channel::{ChannelBinding, ChannelBindingStore};
use harness_workflow::{WorkflowDefinition, WorkflowRun, WorkflowStore};
use harness_core::{
    AgentProfile, AgentProfileEvent, AgentProfileStore, BoxError, Conversation,
    ConversationLifecycle, ConversationMetadata, ConversationRecord, ConversationStore, Message,
    Tenant, TenantStore, TodoEvent, TodoItem, TodoStore,
};
use harness_learning::{
    fold_events_into_rows, validate_memory_safe, MemoryFilter, MemoryItem, MemoryPatch,
    MemoryStore, SkillLifecycle,
    SkillLifecycleStore, SkillUsageEvent, SkillUsageFilter, SkillUsageRow, SkillUsageStore,
};
use harness_observability::{
    DashboardSnapshot, EvalBaseline, EvalCaseResult, EvalFilter, EvalStore, EvalSuiteRun,
    MetricPoint, ObservabilityFilter, ObservabilityStore, ObservedOutcome, ObservedRun,
    ObservedSpanSummary, TimeWindow,
};
use harness_project::{
    Activity, ActivityEvent, ActivityStore, Comment, CommentEvent, CommentStore, DocDraft,
    DocEvent, DocProject, DocStore, Label, LabelEvent, LabelStore, Project, ProjectStore,
    Requirement, RequirementEvent, RequirementRun, RequirementRunEvent, RequirementRunStore,
    RequirementStore,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex};

use crate::error::StoreError;

pub struct JsonFileConversationStore {
    dir: PathBuf,
}

impl JsonFileConversationStore {
    /// Open or create a store at `dir`. The directory is created
    /// (recursively) if missing; existing files are not touched.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        Ok(Self { dir })
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", encode_id(id)))
    }
}

/// On-disk shape: id + timestamps + the existing `Conversation`
/// payload + per-conversation metadata. We keep timestamps inside the
/// file (not from filesystem `mtime`) because the filesystem's clock
/// isn't ours.
///
/// `project_id` uses `#[serde(default)]` so old files (written before
/// the Project feature) deserialise cleanly with `None`.
#[derive(Debug, Serialize, Deserialize)]
struct OnDiskConversation {
    id: String,
    created_at: String,
    updated_at: String,
    messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    /// User-driven lifecycle. Default `Active` so legacy rows decode
    /// cleanly. Skipped on serialise when default to keep the on-disk
    /// JSON compact for the common case.
    #[serde(default, skip_serializing_if = "ConversationLifecycle::is_default")]
    lifecycle: ConversationLifecycle,
}

#[async_trait]
impl ConversationStore for JsonFileConversationStore {
    async fn save_envelope(
        &self,
        id: &str,
        conversation: &Conversation,
        metadata: &ConversationMetadata,
    ) -> Result<(), BoxError> {
        let path = self.path_for(id);
        let now = Utc::now().to_rfc3339();
        // Preserve created_at across overwrites.
        let created_at = match tokio::fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<OnDiskConversation>(&bytes) {
                Ok(s) => s.created_at,
                Err(_) => now.clone(),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => now.clone(),
            Err(e) => return Err(Box::new(e)),
        };

        let stored = OnDiskConversation {
            id: id.to_string(),
            created_at,
            updated_at: now,
            messages: conversation.messages.clone(),
            project_id: metadata.project_id.clone(),
            lifecycle: metadata.lifecycle,
        };
        let bytes = serde_json::to_vec_pretty(&stored).map_err(StoreError::from)?;
        atomic_write(&path, &bytes).await
    }

    async fn load_envelope(
        &self,
        id: &str,
    ) -> Result<Option<(Conversation, ConversationMetadata)>, BoxError> {
        let path = self.path_for(id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let stored: OnDiskConversation =
            serde_json::from_slice(&bytes).map_err(StoreError::from)?;
        let conv = Conversation {
            messages: stored.messages,
            ..Default::default()
        };
        let meta = ConversationMetadata {
            project_id: stored.project_id,
            lifecycle: stored.lifecycle,
        };
        Ok(Some((conv, meta)))
    }

    async fn list(&self, limit: u32) -> Result<Vec<ConversationRecord>, BoxError> {
        let mut entries: Vec<ConversationRecord> = Vec::new();
        let mut dir = match tokio::fs::read_dir(&self.dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        while let Some(entry) = dir.next_entry().await? {
            let path = entry.path();
            // skip directories (e.g. projects/), .tmp files, anything not ending in .json
            if path.is_dir() {
                continue;
            }
            if !path.extension().is_some_and(|e| e == "json") {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            let stored: OnDiskConversation = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };
            entries.push(ConversationRecord {
                id: stored.id,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.len(),
                project_id: stored.project_id,
                lifecycle: stored.lifecycle,
            });
        }
        // Newest first by updated_at — RFC 3339 strings are
        // lexicographically comparable.
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        entries.truncate(limit as usize);
        Ok(entries)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

pub struct JsonFileAutomationStore {
    base: PathBuf,
}

impl JsonFileAutomationStore {
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        Ok(Self { base })
    }

    fn dir(&self) -> PathBuf {
        self.base.join("automations")
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir().join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl AutomationStore for JsonFileAutomationStore {
    async fn list(&self) -> Result<Vec<AutomationTask>, BoxError> {
        let dir = self.dir();
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if let Ok(task) = serde_json::from_slice::<AutomationTask>(&bytes) {
                rows.push(task);
            }
        }
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<AutomationTask>, BoxError> {
        let path = self.path_for(id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let task = serde_json::from_slice::<AutomationTask>(&bytes).map_err(StoreError::from)?;
        Ok(Some(task))
    }

    async fn upsert(&self, task: &AutomationTask) -> Result<(), BoxError> {
        let dir = self.dir();
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&task.id);
        let bytes = serde_json::to_vec_pretty(task).map_err(StoreError::from)?;
        atomic_write(&path, &bytes).await
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

// ---------- WorkflowStore ----------------------------------------------------

/// On-disk [`WorkflowStore`]. Definitions live under `<base>/workflows/`
/// and runs under `<base>/workflow_runs/`, one `<id>.json` each, atomic
/// `.tmp`+rename like every other JSON-file store.
pub struct JsonFileWorkflowStore {
    base: PathBuf,
}

impl JsonFileWorkflowStore {
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        Ok(Self { base })
    }

    fn defs_dir(&self) -> PathBuf {
        self.base.join("workflows")
    }

    fn runs_dir(&self) -> PathBuf {
        self.base.join("workflow_runs")
    }

    fn def_path(&self, id: &str) -> PathBuf {
        self.defs_dir().join(format!("{}.json", encode_id(id)))
    }

    fn run_path(&self, id: &str) -> PathBuf {
        self.runs_dir().join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl WorkflowStore for JsonFileWorkflowStore {
    async fn list(&self) -> Result<Vec<WorkflowDefinition>, BoxError> {
        let mut rows = read_json_dir::<WorkflowDefinition>(&self.defs_dir()).await?;
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<WorkflowDefinition>, BoxError> {
        read_json_file::<WorkflowDefinition>(&self.def_path(id)).await
    }

    async fn upsert(&self, def: &WorkflowDefinition) -> Result<(), BoxError> {
        ensure_dir(&self.defs_dir()).map_err(|e| -> BoxError { Box::new(e) })?;
        let bytes = serde_json::to_vec_pretty(def).map_err(StoreError::from)?;
        atomic_write(&self.def_path(&def.id), &bytes).await
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        match tokio::fs::remove_file(self.def_path(id)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }

    async fn list_runs(
        &self,
        workflow_id: Option<&str>,
        requirement_id: Option<&str>,
    ) -> Result<Vec<WorkflowRun>, BoxError> {
        let mut rows = read_json_dir::<WorkflowRun>(&self.runs_dir()).await?;
        rows.retain(|r| {
            // `Option::is_none_or` is stable since 1.82 but the workspace
            // MSRV is 1.80 (see conversations.rs); use `map_or` instead.
            workflow_id.map_or(true, |w| r.workflow_id == w)
                && requirement_id.map_or(true, |req| r.requirement_id.as_deref() == Some(req))
        });
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(rows)
    }

    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRun>, BoxError> {
        read_json_file::<WorkflowRun>(&self.run_path(run_id)).await
    }

    async fn upsert_run(&self, run: &WorkflowRun) -> Result<(), BoxError> {
        ensure_dir(&self.runs_dir()).map_err(|e| -> BoxError { Box::new(e) })?;
        let bytes = serde_json::to_vec_pretty(run).map_err(StoreError::from)?;
        atomic_write(&self.run_path(&run.id), &bytes).await
    }
}

/// Read every `*.json` (excluding `*.json.tmp`) in `dir` into `T`,
/// skipping unreadable / undecodable files. Returns an empty vec when
/// the directory doesn't exist yet.
async fn read_json_dir<T: DeserializeOwned>(dir: &Path) -> Result<Vec<T>, BoxError> {
    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Box::new(e)),
    };
    let mut rows = Vec::new();
    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
            continue;
        }
        let bytes = match tokio::fs::read(entry.path()).await {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if let Ok(row) = serde_json::from_slice::<T>(&bytes) {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Read a single `*.json` file into `T`. `Ok(None)` when the file is
/// absent; decode errors surface as a [`StoreError`].
async fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, BoxError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Box::new(e)),
    };
    let row = serde_json::from_slice::<T>(&bytes).map_err(StoreError::from)?;
    Ok(Some(row))
}

// ---------- ProjectStore ----------------------------------------------------

pub struct JsonFileProjectStore {
    dir: PathBuf,
}

impl JsonFileProjectStore {
    /// Open or create a project store. `base_dir` is the root the
    /// sibling [`JsonFileConversationStore`] uses; projects live in
    /// `<base_dir>/projects/`.
    pub fn open(base_dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = base_dir.into().join("projects");
        ensure_dir(&dir)?;
        Ok(Self { dir })
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl ProjectStore for JsonFileProjectStore {
    async fn save(&self, project: &Project) -> Result<(), BoxError> {
        // Slug uniqueness check — scan everything in the directory
        // and reject if a *different* id already owns this slug.
        let existing = scan_projects(&self.dir).await?;
        for p in &existing {
            if p.id != project.id && p.slug == project.slug {
                return Err(format!(
                    "project slug '{}' already in use by id={}",
                    project.slug, p.id
                )
                .into());
            }
        }
        let path = self.path_for(&project.id);
        let bytes = serde_json::to_vec_pretty(project).map_err(StoreError::from)?;
        atomic_write(&path, &bytes).await
    }

    async fn load(&self, id: &str) -> Result<Option<Project>, BoxError> {
        let path = self.path_for(id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let p: Project = serde_json::from_slice(&bytes).map_err(StoreError::from)?;
        Ok(Some(p))
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError> {
        let projects = scan_projects(&self.dir).await?;
        Ok(projects.into_iter().find(|p| p.slug == slug))
    }

    async fn list(&self, include_archived: bool, limit: u32) -> Result<Vec<Project>, BoxError> {
        let mut projects = scan_projects(&self.dir).await?;
        if !include_archived {
            projects.retain(|p| !p.archived);
        }
        projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        projects.truncate(limit as usize);
        Ok(projects)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        let removed = match tokio::fs::remove_file(&path).await {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(Box::new(e)),
        };
        // Cascade: nuke the project's requirement / run / activity /
        // comment subtrees that the sibling stores keyed under
        // `<base>/<store>/<id>/`. Without this they linger on disk
        // forever (kanban can't see them, but `list_all`-style
        // reports — e.g. WorkOverview's run rollup — happily count
        // them, and slug reuse trips uniqueness).
        if let Some(base) = self.dir.parent() {
            let encoded_pid = encode_id(id);
            let req_dir = base.join("requirements").join(&encoded_pid);
            let req_ids = collect_dir_ids(&req_dir).await;
            let _ = remove_dir_all_if_exists(&req_dir).await;
            for rid in &req_ids {
                let encoded_rid = encode_id(rid);
                let _ = remove_dir_all_if_exists(&base.join("requirement_runs").join(&encoded_rid))
                    .await;
                let _ = remove_dir_all_if_exists(&base.join("activities").join(&encoded_rid)).await;
                let _ = remove_dir_all_if_exists(&base.join("comments").join(&encoded_rid)).await;
            }
        }
        Ok(removed)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let mut p = match self.load(id).await? {
            Some(p) => p,
            None => return Ok(false),
        };
        p.archive();
        self.save(&p).await?;
        Ok(true)
    }
}

async fn scan_projects(dir: &Path) -> Result<Vec<Project>, BoxError> {
    let mut out = Vec::new();
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Box::new(e)),
    };
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".json") || name.ends_with(".json.tmp") {
            continue;
        }
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if let Ok(p) = serde_json::from_slice::<Project>(&bytes) {
            out.push(p);
        }
    }
    Ok(out)
}

// ---------- TodoStore -----------------------------------------------------

/// One JSON file per TODO, partitioned by workspace under a `todos/`
/// subdirectory: `<base>/todos/<encode_id(workspace_path)>/<encode_id(id)>.json`.
/// The workspace key in the path is the same percent-encoded form
/// used for conversation ids — round-trips through `encode_id` /
/// `decode_id`.
pub struct JsonFileTodoStore {
    base: PathBuf,
    tx: broadcast::Sender<TodoEvent>,
}

impl JsonFileTodoStore {
    /// Open or create a store at `<base>/todos/`. The `todos/`
    /// subdirectory is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn workspace_dir(&self, workspace: &str) -> PathBuf {
        self.base.join("todos").join(encode_id(workspace))
    }

    fn path_for(&self, workspace: &str, id: &str) -> PathBuf {
        self.workspace_dir(workspace)
            .join(format!("{}.json", encode_id(id)))
    }

    /// Walk every workspace dir to find a TODO by id. Used by
    /// `get` and `delete`, which take only the id (the row carries
    /// the workspace inside).
    async fn find_by_id(&self, id: &str) -> Result<Option<(PathBuf, TodoItem)>, BoxError> {
        let todos_root = self.base.join("todos");
        let mut read_dir = match tokio::fs::read_dir(&todos_root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let target_filename = format!("{}.json", encode_id(id));
        while let Some(entry) = read_dir.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let candidate = entry.path().join(&target_filename);
            match tokio::fs::read(&candidate).await {
                Ok(bytes) => match serde_json::from_slice::<TodoItem>(&bytes) {
                    Ok(item) => return Ok(Some((candidate, item))),
                    Err(_) => continue,
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(Box::new(e)),
            }
        }
        Ok(None)
    }
}

#[async_trait]
impl TodoStore for JsonFileTodoStore {
    async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
        let dir = self.workspace_dir(workspace);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<TodoItem> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(item) = serde_json::from_slice::<TodoItem>(&bytes) {
                rows.push(item);
            }
        }
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
        Ok(self.find_by_id(id).await?.map(|(_, item)| item))
    }

    async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError> {
        let dir = self.workspace_dir(&item.workspace);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&item.workspace, &item.id);
        let bytes = serde_json::to_vec_pretty(item)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(TodoEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let Some((path, item)) = self.find_by_id(id).await? else {
            return Ok(false);
        };
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                let _ = self.tx.send(TodoEvent::Deleted {
                    workspace: item.workspace,
                    id: item.id,
                });
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<TodoEvent> {
        self.tx.subscribe()
    }
}

// ---------- RequirementStore ----------------------------------------------

/// One JSON file per requirement, partitioned by project under a
/// `requirements/` subdirectory:
/// `<base>/requirements/<encode_id(project_id)>/<encode_id(id)>.json`.
/// Mirrors the [`JsonFileTodoStore`] layout.
pub struct JsonFileRequirementStore {
    base: PathBuf,
    tx: broadcast::Sender<RequirementEvent>,
}

impl JsonFileRequirementStore {
    /// Open or create a store at `<base>/requirements/`. The
    /// `requirements/` subdirectory is created lazily on first
    /// write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn project_dir(&self, project_id: &str) -> PathBuf {
        self.base.join("requirements").join(encode_id(project_id))
    }

    fn path_for(&self, project_id: &str, id: &str) -> PathBuf {
        self.project_dir(project_id)
            .join(format!("{}.json", encode_id(id)))
    }

    /// Walk every project dir to find a requirement by id. Used by
    /// `get` and `delete`, which take only the id (the row carries
    /// the project_id inside).
    async fn find_by_id(&self, id: &str) -> Result<Option<(PathBuf, Requirement)>, BoxError> {
        let root = self.base.join("requirements");
        let mut read_dir = match tokio::fs::read_dir(&root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let target_filename = format!("{}.json", encode_id(id));
        while let Some(entry) = read_dir.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let candidate = entry.path().join(&target_filename);
            match tokio::fs::read(&candidate).await {
                Ok(bytes) => match serde_json::from_slice::<Requirement>(&bytes) {
                    Ok(item) => return Ok(Some((candidate, item))),
                    Err(_) => continue,
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(Box::new(e)),
            }
        }
        Ok(None)
    }
}

#[async_trait]
impl RequirementStore for JsonFileRequirementStore {
    async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
        let dir = self.project_dir(project_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<Requirement> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(item) = serde_json::from_slice::<Requirement>(&bytes) {
                rows.push(item);
            }
        }
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
        Ok(self.find_by_id(id).await?.map(|(_, item)| item))
    }

    async fn upsert(&self, item: &Requirement) -> Result<(), BoxError> {
        let dir = self.project_dir(&item.project_id);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&item.project_id, &item.id);
        let bytes = serde_json::to_vec_pretty(item)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(RequirementEvent::Upserted(item.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let Some((path, item)) = self.find_by_id(id).await? else {
            return Ok(false);
        };
        let removed = match tokio::fs::remove_file(&path).await {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(Box::new(e)),
        };
        // Cascade: nuke runs / activities / comments keyed under this
        // requirement id. Without this the rows linger on disk and
        // `list_all` style reports keep counting them (the
        // requirement_title / project_name joins resolve to None and
        // the UI shows "(deleted)" rows).
        let encoded_rid = encode_id(&item.id);
        let _ =
            remove_dir_all_if_exists(&self.base.join("requirement_runs").join(&encoded_rid)).await;
        let _ = remove_dir_all_if_exists(&self.base.join("activities").join(&encoded_rid)).await;
        let _ = remove_dir_all_if_exists(&self.base.join("comments").join(&encoded_rid)).await;
        if removed {
            let _ = self.tx.send(RequirementEvent::Deleted {
                project_id: item.project_id,
                id: item.id,
            });
        }
        Ok(removed)
    }

    fn subscribe(&self) -> broadcast::Receiver<RequirementEvent> {
        self.tx.subscribe()
    }
}

// ---------- RequirementRunStore -------------------------------------------

/// One JSON file per run, partitioned by requirement under a
/// `requirement_runs/` subdirectory:
/// `<base>/requirement_runs/<encode_id(requirement_id)>/<encode_id(id)>.json`.
/// Mirrors [`JsonFileRequirementStore`] layout.
pub struct JsonFileRequirementRunStore {
    base: PathBuf,
    tx: broadcast::Sender<RequirementRunEvent>,
}

impl JsonFileRequirementRunStore {
    /// Open or create a store at `<base>/requirement_runs/`. The
    /// subdirectory is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn requirement_dir(&self, requirement_id: &str) -> PathBuf {
        self.base
            .join("requirement_runs")
            .join(encode_id(requirement_id))
    }

    fn path_for(&self, requirement_id: &str, id: &str) -> PathBuf {
        self.requirement_dir(requirement_id)
            .join(format!("{}.json", encode_id(id)))
    }

    /// Walk every requirement dir to find a run by id. Used by
    /// `get` (which only knows the id; the row carries the
    /// requirement_id inside).
    async fn find_by_id(&self, id: &str) -> Result<Option<(PathBuf, RequirementRun)>, BoxError> {
        let root = self.base.join("requirement_runs");
        let mut read_dir = match tokio::fs::read_dir(&root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let target_filename = format!("{}.json", encode_id(id));
        while let Some(entry) = read_dir.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let candidate = entry.path().join(&target_filename);
            match tokio::fs::read(&candidate).await {
                Ok(bytes) => match serde_json::from_slice::<RequirementRun>(&bytes) {
                    Ok(run) => return Ok(Some((candidate, run))),
                    Err(_) => continue,
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(Box::new(e)),
            }
        }
        Ok(None)
    }
}

#[async_trait]
impl RequirementRunStore for JsonFileRequirementRunStore {
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<RequirementRun>, BoxError> {
        let dir = self.requirement_dir(requirement_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<RequirementRun> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(run) = serde_json::from_slice::<RequirementRun>(&bytes) {
                rows.push(run);
            }
        }
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
        Ok(self.find_by_id(id).await?.map(|(_, run)| run))
    }

    async fn list_all(&self, limit: u32) -> Result<Vec<RequirementRun>, BoxError> {
        // Walk every requirement subdir and read its run rows.
        // O(N) over the on-disk count — acceptable at our scale
        // (json backend caps below SQL anyway).
        let root = self.base.join("requirement_runs");
        let mut req_dir = match tokio::fs::read_dir(&root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<RequirementRun> = Vec::new();
        while let Some(entry) = req_dir.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let mut run_dir = match tokio::fs::read_dir(entry.path()).await {
                Ok(d) => d,
                Err(_) => continue,
            };
            while let Some(run_entry) = run_dir.next_entry().await? {
                let path = run_entry.path();
                let name = run_entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                    continue;
                }
                let bytes = match tokio::fs::read(&path).await {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if let Ok(run) = serde_json::from_slice::<RequirementRun>(&bytes) {
                    rows.push(run);
                }
            }
        }
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn upsert(&self, run: &RequirementRun) -> Result<(), BoxError> {
        let prior = self.find_by_id(&run.id).await?.map(|(_, r)| r);
        let dir = self.requirement_dir(&run.requirement_id);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&run.requirement_id, &run.id);
        let bytes = serde_json::to_vec_pretty(run)?;
        atomic_write(&path, &bytes).await?;
        if let Some(ev) = crate::memory::classify_run_event(prior.as_ref(), run) {
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

// ---------- AgentProfileStore ---------------------------------------------

/// One JSON file per agent profile under `<base>/agent_profiles/`.
/// The set is small (dozens) so a flat directory is fine.
pub struct JsonFileAgentProfileStore {
    base: PathBuf,
    tx: broadcast::Sender<AgentProfileEvent>,
}

impl JsonFileAgentProfileStore {
    /// Open or create a store at `<base>/agent_profiles/`. The
    /// subdirectory is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn dir(&self) -> PathBuf {
        self.base.join("agent_profiles")
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir().join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl AgentProfileStore for JsonFileAgentProfileStore {
    async fn list(&self) -> Result<Vec<AgentProfile>, BoxError> {
        let dir = self.dir();
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<AgentProfile> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(p) = serde_json::from_slice::<AgentProfile>(&bytes) {
                rows.push(p);
            }
        }
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
        let path = self.path_for(id);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice::<AgentProfile>(&bytes).map_err(StoreError::from)?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Box::new(e)),
        }
    }

    async fn upsert(&self, profile: &AgentProfile) -> Result<(), BoxError> {
        ensure_dir(&self.dir()).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&profile.id);
        let bytes = serde_json::to_vec_pretty(profile)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(AgentProfileEvent::Upserted(profile.clone()));
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                let _ = self
                    .tx
                    .send(AgentProfileEvent::Deleted { id: id.to_string() });
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<AgentProfileEvent> {
        self.tx.subscribe()
    }
}

// ---------- ActivityStore -------------------------------------------------

/// One JSON file per activity, partitioned by requirement under
/// `activities/`:
/// `<base>/activities/<encode_id(requirement_id)>/<encode_id(id)>.json`.
/// Append-only — `delete` is intentionally not implemented (the
/// trait offers no such method).
pub struct JsonFileActivityStore {
    base: PathBuf,
    tx: broadcast::Sender<ActivityEvent>,
}

impl JsonFileActivityStore {
    /// Open or create a store at `<base>/activities/`. The
    /// subdirectory is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn requirement_dir(&self, requirement_id: &str) -> PathBuf {
        self.base.join("activities").join(encode_id(requirement_id))
    }

    fn path_for(&self, requirement_id: &str, id: &str) -> PathBuf {
        self.requirement_dir(requirement_id)
            .join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl ActivityStore for JsonFileActivityStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Activity>, BoxError> {
        let dir = self.requirement_dir(requirement_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<Activity> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(a) = serde_json::from_slice::<Activity>(&bytes) {
                rows.push(a);
            }
        }
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
        let dir = self.requirement_dir(&activity.requirement_id);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&activity.requirement_id, &activity.id);
        let bytes = serde_json::to_vec_pretty(activity)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(ActivityEvent::Appended(activity.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<ActivityEvent> {
        self.tx.subscribe()
    }
}

// ---------- CommentStore ----------------------------------------------

/// On-disk JSON layout, partitioned by requirement under `comments/`:
/// `<base>/comments/<encode_id(requirement_id)>/<encode_id(id)>.json`.
///
/// Mutations are atomic-per-row (`tmp` + rename), the same primitive
/// `JsonFileActivityStore` and friends use. The store enforces the
/// trait's depth-1 invariant on `create` by reading the parent before
/// writing the new row.
pub struct JsonFileCommentStore {
    base: PathBuf,
    tx: broadcast::Sender<CommentEvent>,
}

impl JsonFileCommentStore {
    /// Open or create a store at `<base>/comments/`. The
    /// subdirectory is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn requirement_dir(&self, requirement_id: &str) -> PathBuf {
        self.base.join("comments").join(encode_id(requirement_id))
    }

    fn path_for(&self, requirement_id: &str, id: &str) -> PathBuf {
        self.requirement_dir(requirement_id)
            .join(format!("{}.json", encode_id(id)))
    }

    /// Read every comment file in the requirement bucket. Used by
    /// `list_for_requirement` and as a helper when validating
    /// `parent_id` on `create`.
    async fn load_bucket(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError> {
        let dir = self.requirement_dir(requirement_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<Comment> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(c) = serde_json::from_slice::<Comment>(&bytes) {
                rows.push(c);
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl CommentStore for JsonFileCommentStore {
    async fn list_for_requirement(&self, requirement_id: &str) -> Result<Vec<Comment>, BoxError> {
        let mut rows = self.load_bucket(requirement_id).await?;
        // Oldest-first (chat order). Mirrors MemoryCommentStore.
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
        // Parent validation reads the bucket; depth-1 invariant matches
        // MemoryCommentStore.
        if let Some(parent_id) = comment.parent_id.as_deref() {
            let bucket = self.load_bucket(&comment.requirement_id).await?;
            match bucket.iter().find(|c| c.id == parent_id) {
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
        // Reject duplicate id deterministically (the file system would
        // happily overwrite, which is wrong for `create`).
        let path = self.path_for(&comment.requirement_id, &comment.id);
        if tokio::fs::metadata(&path).await.is_ok() {
            return Err(format!("comment id `{}` already exists", comment.id).into());
        }
        let dir = self.requirement_dir(&comment.requirement_id);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let bytes = serde_json::to_vec_pretty(comment)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(CommentEvent::Posted(comment.clone()));
        Ok(())
    }

    async fn update(&self, comment: &Comment) -> Result<bool, BoxError> {
        let path = self.path_for(&comment.requirement_id, &comment.id);
        // Load the existing row, copy the immutable fields onto the
        // patch, then atomic-write. Returning Ok(false) when the file
        // is absent matches the trait contract.
        let existing_bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(Box::new(e)),
        };
        let existing: Comment = serde_json::from_slice(&existing_bytes)?;
        let merged = Comment {
            id: existing.id.clone(),
            requirement_id: existing.requirement_id.clone(),
            author: existing.author.clone(),
            parent_id: existing.parent_id.clone(),
            created_at: existing.created_at.clone(),
            // `body` and `updated_at` are the only fields the trait
            // permits a caller to mutate. We pull from the patch.
            body: comment.body.clone(),
            updated_at: comment.updated_at.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&merged)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(CommentEvent::Edited(merged));
        Ok(true)
    }

    async fn delete(&self, requirement_id: &str, comment_id: &str) -> Result<bool, BoxError> {
        // Need to read the bucket to determine whether the target is
        // a top-level comment that requires a cascading delete of its
        // direct replies.
        let bucket = self.load_bucket(requirement_id).await?;
        let target = match bucket.iter().find(|c| c.id == comment_id) {
            Some(c) => c,
            None => return Ok(false),
        };
        let mut to_remove: Vec<String> = vec![target.id.clone()];
        if target.parent_id.is_none() {
            for c in &bucket {
                if c.parent_id.as_deref() == Some(comment_id) {
                    to_remove.push(c.id.clone());
                }
            }
        }
        for id in &to_remove {
            let path = self.path_for(requirement_id, id);
            // `remove_file` on a missing path is fine (race with another
            // writer would already have warned); `Other` errors bubble.
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Box::new(e)),
            }
            let _ = self.tx.send(CommentEvent::Deleted {
                requirement_id: requirement_id.to_string(),
                comment_id: id.clone(),
            });
        }
        Ok(true)
    }

    fn subscribe(&self) -> broadcast::Receiver<CommentEvent> {
        self.tx.subscribe()
    }
}

// ---------- LabelStore ------------------------------------------------

/// On-disk JSON layout, partitioned by project under `labels/`:
/// `<base>/labels/<encode_id(project_id)>/<encode_id(id)>.json`.
///
/// Name uniqueness is enforced case-insensitively on every mutation
/// by scanning the project bucket. The bucket lookup is O(N labels in
/// project) which is fine — projects rarely have >100 labels and we'd
/// rather pay the scan than maintain a separate index file.
pub struct JsonFileLabelStore {
    base: PathBuf,
    tx: broadcast::Sender<LabelEvent>,
}

impl JsonFileLabelStore {
    /// Open or create a store at `<base>/labels/`. The subdirectory
    /// is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn project_dir(&self, project_id: &str) -> PathBuf {
        self.base.join("labels").join(encode_id(project_id))
    }

    fn path_for(&self, project_id: &str, id: &str) -> PathBuf {
        self.project_dir(project_id)
            .join(format!("{}.json", encode_id(id)))
    }

    /// Read every label file in the project bucket. Used by
    /// `list_for_project`, the uniqueness check, and `get` (after
    /// scanning across project buckets).
    async fn load_bucket(&self, project_id: &str) -> Result<Vec<Label>, BoxError> {
        let dir = self.project_dir(project_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<Label> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(l) = serde_json::from_slice::<Label>(&bytes) {
                rows.push(l);
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl LabelStore for JsonFileLabelStore {
    async fn list_for_project(&self, project_id: &str) -> Result<Vec<Label>, BoxError> {
        let mut rows = self.load_bucket(project_id).await?;
        rows.sort_by_key(|l| l.name.to_lowercase());
        Ok(rows)
    }

    async fn get(&self, id: &str) -> Result<Option<Label>, BoxError> {
        // We don't know the project up front, so walk every project
        // bucket. Acceptable because labels are rarely fetched by id
        // alone — the REST layer almost always knows the project.
        let labels_root = self.base.join("labels");
        let mut read_dir = match tokio::fs::read_dir(&labels_root).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let target_filename = format!("{}.json", encode_id(id));
        while let Some(entry) = read_dir.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let candidate = entry.path().join(&target_filename);
            match tokio::fs::read(&candidate).await {
                Ok(bytes) => {
                    if let Ok(l) = serde_json::from_slice::<Label>(&bytes) {
                        return Ok(Some(l));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(Box::new(e)),
            }
        }
        Ok(None)
    }

    async fn create(&self, label: &Label) -> Result<(), BoxError> {
        let bucket = self.load_bucket(&label.project_id).await?;
        if bucket
            .iter()
            .any(|l| l.name.eq_ignore_ascii_case(&label.name))
        {
            return Err(format!("label name `{}` already exists in project", label.name).into());
        }
        let path = self.path_for(&label.project_id, &label.id);
        if tokio::fs::metadata(&path).await.is_ok() {
            return Err(format!("label id `{}` already exists", label.id).into());
        }
        let dir = self.project_dir(&label.project_id);
        ensure_dir(&dir).map_err(|e| -> BoxError { Box::new(e) })?;
        let bytes = serde_json::to_vec_pretty(label)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(LabelEvent::Created(label.clone()));
        Ok(())
    }

    async fn update(&self, label: &Label) -> Result<bool, BoxError> {
        let path = self.path_for(&label.project_id, &label.id);
        let existing_bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(Box::new(e)),
        };
        let existing: Label = serde_json::from_slice(&existing_bytes)?;
        // Uniqueness check skipping ourselves.
        let bucket = self.load_bucket(&label.project_id).await?;
        if bucket
            .iter()
            .any(|l| l.id != label.id && l.name.eq_ignore_ascii_case(&label.name))
        {
            return Err(format!("label name `{}` already exists in project", label.name).into());
        }
        // Build the merged row: id / project_id / created_at are
        // pinned to the on-disk values; everything else comes from
        // the patch.
        let merged = Label {
            id: existing.id.clone(),
            project_id: existing.project_id.clone(),
            created_at: existing.created_at,
            name: label.name.clone(),
            colour: label.colour.clone(),
            description: label.description.clone(),
            updated_at: label.updated_at.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&merged)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(LabelEvent::Updated(merged));
        Ok(true)
    }

    async fn delete(&self, project_id: &str, label_id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(project_id, label_id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                let _ = self.tx.send(LabelEvent::Deleted {
                    project_id: project_id.to_string(),
                    label_id: label_id.to_string(),
                });
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<LabelEvent> {
        self.tx.subscribe()
    }
}

// ---------- DocStore --------------------------------------------------

/// On-disk JSON layout:
///
/// ```text
/// <base>/docs/
///   projects/<encode_id(id)>.json
///   drafts/<encode_id(project_id)>/<encode_id(id)>.json
/// ```
pub struct JsonFileDocStore {
    base: PathBuf,
    tx: broadcast::Sender<DocEvent>,
}

impl JsonFileDocStore {
    /// Open or create a store at `<base>/docs/`. The subdirectories
    /// are created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        let (tx, _) = broadcast::channel(64);
        Ok(Self { base, tx })
    }

    fn projects_dir(&self) -> PathBuf {
        self.base.join("docs").join("projects")
    }

    fn drafts_dir(&self, project_id: &str) -> PathBuf {
        self.base
            .join("docs")
            .join("drafts")
            .join(encode_id(project_id))
    }

    fn project_path(&self, id: &str) -> PathBuf {
        self.projects_dir().join(format!("{}.json", encode_id(id)))
    }

    fn draft_path(&self, project_id: &str, id: &str) -> PathBuf {
        self.drafts_dir(project_id)
            .join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl DocStore for JsonFileDocStore {
    async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
        let dir = self.projects_dir();
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<DocProject> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(item) = serde_json::from_slice::<DocProject>(&bytes) {
                if item.workspace == workspace {
                    rows.push(item);
                }
            }
        }
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
        let path = self.project_path(id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Box::new(e)),
        };
        let p: DocProject = serde_json::from_slice(&bytes).map_err(StoreError::from)?;
        Ok(Some(p))
    }

    async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
        ensure_dir(&self.projects_dir()).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.project_path(&project.id);
        let bytes = serde_json::to_vec_pretty(project).map_err(StoreError::from)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(DocEvent::ProjectUpserted(project.clone()));
        Ok(())
    }

    async fn delete_project(&self, id: &str) -> Result<bool, BoxError> {
        let project = match self.get_project(id).await? {
            Some(p) => p,
            None => return Ok(false),
        };
        // Remove the project file.
        let _ = tokio::fs::remove_file(self.project_path(id)).await;
        // Cascade-remove the drafts subdir.
        let drafts_dir = self.drafts_dir(id);
        let _ = tokio::fs::remove_dir_all(&drafts_dir).await;
        let _ = self.tx.send(DocEvent::ProjectDeleted {
            workspace: project.workspace,
            id: project.id,
        });
        Ok(true)
    }

    async fn list_drafts(&self, project_id: &str) -> Result<Vec<DocDraft>, BoxError> {
        let dir = self.drafts_dir(project_id);
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<DocDraft> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(item) = serde_json::from_slice::<DocDraft>(&bytes) {
                rows.push(item);
            }
        }
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn upsert_draft(&self, draft: &DocDraft) -> Result<(), BoxError> {
        ensure_dir(&self.drafts_dir(&draft.project_id)).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.draft_path(&draft.project_id, &draft.id);
        let bytes = serde_json::to_vec_pretty(draft).map_err(StoreError::from)?;
        atomic_write(&path, &bytes).await?;
        let _ = self.tx.send(DocEvent::DraftUpserted(draft.clone()));
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<DocEvent> {
        self.tx.subscribe()
    }
}

// ---------- TenantStore -------------------------------------------------

/// One JSON file per tenant under `<base>/tenants/`.
/// The set is small (typically dozens) so a flat directory is fine.
pub struct JsonFileTenantStore {
    base: PathBuf,
}

impl JsonFileTenantStore {
    /// Open or create a store at `<base>/tenants/`. The subdirectory
    /// is created lazily on first write.
    pub fn open(base: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base.into();
        ensure_dir(&base)?;
        Ok(Self { base })
    }

    fn dir(&self) -> PathBuf {
        self.base.join("tenants")
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir().join(format!("{}.json", encode_id(id)))
    }

    /// Scan every tenant file in the directory.
    async fn scan_tenants(&self) -> Result<Vec<Tenant>, BoxError> {
        let dir = self.dir();
        let mut read_dir = match tokio::fs::read_dir(&dir).await {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Box::new(e)),
        };
        let mut rows: Vec<Tenant> = Vec::new();
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
                continue;
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(t) = serde_json::from_slice::<Tenant>(&bytes) {
                rows.push(t);
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl TenantStore for JsonFileTenantStore {
    async fn save(&self, tenant: &Tenant) -> Result<(), BoxError> {
        let existing = self.scan_tenants().await?;
        for t in &existing {
            if t.id != tenant.id && t.slug == tenant.slug {
                return Err(StoreError::DuplicateSlug(tenant.slug.clone()).into());
            }
        }
        ensure_dir(&self.dir()).map_err(|e| -> BoxError { Box::new(e) })?;
        let path = self.path_for(&tenant.id);
        let bytes = serde_json::to_vec_pretty(tenant)?;
        atomic_write(&path, &bytes).await
    }

    async fn load(&self, id: &str) -> Result<Option<Tenant>, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice::<Tenant>(&bytes).map_err(StoreError::from)?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Box::new(e)),
        }
    }

    async fn find_by_slug(&self, slug: &str) -> Result<Option<Tenant>, BoxError> {
        let rows = self.scan_tenants().await?;
        Ok(rows.into_iter().find(|t| t.slug == slug))
    }

    async fn list(&self) -> Result<Vec<Tenant>, BoxError> {
        let mut rows = self.scan_tenants().await?;
        rows.retain(|t| !t.archived);
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn archive(&self, id: &str) -> Result<bool, BoxError> {
        let mut t = match self.load(id).await? {
            Some(t) => t,
            None => return Ok(false),
        };
        t.archive();
        self.save(&t).await?;
        Ok(true)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let path = self.path_for(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

// ---------- observability / eval stores ------------------------------------

/// Default ceiling on `runs/*.json` files kept on disk. Each tool /
/// agent / subagent invocation appends one tiny file; without a cap
/// the directory grows without bound (and `list_runs` / `dashboard`,
/// which rescan the whole directory, slow down linearly). 2000 keeps
/// the rolling dashboard window useful while bounding disk + scan
/// cost. Override at the composition root via
/// `JsonFileObservabilityStore::with_max_runs` (the binary reads
/// `JARVIS_OBSERVABILITY_MAX_RUNS`).
pub const DEFAULT_MAX_OBSERVED_RUNS: usize = 2000;

pub struct JsonFileObservabilityStore {
    dir: PathBuf,
    /// `Some(n)` caps `runs/` at `n` files (oldest pruned on append);
    /// `None` disables pruning (unbounded growth).
    max_runs: Option<usize>,
}

impl JsonFileObservabilityStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        ensure_dir(&dir.join("runs"))?;
        ensure_dir(&dir.join("spans"))?;
        ensure_dir(&dir.join("metrics"))?;
        ensure_dir(&dir.join("dashboards"))?;
        Ok(Self {
            dir,
            max_runs: Some(DEFAULT_MAX_OBSERVED_RUNS),
        })
    }

    /// Override the `runs/` retention cap. `Some(n)` keeps the newest
    /// `n` files; `None` disables pruning entirely.
    pub fn with_max_runs(mut self, max_runs: Option<usize>) -> Self {
        self.max_runs = max_runs;
        self
    }

    fn run_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("runs")
            .join(format!("{}.json", encode_id(id)))
    }

    fn span_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("spans")
            .join(format!("{}.json", encode_id(id)))
    }

    fn metric_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("metrics")
            .join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl ObservabilityStore for JsonFileObservabilityStore {
    async fn append_run(&self, run: &ObservedRun) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(run).map_err(StoreError::from)?;
        atomic_write(&self.run_path(&run.id), &bytes).await?;
        if let Some(max) = self.max_runs {
            prune_oldest_files(&self.dir.join("runs"), max).await;
        }
        Ok(())
    }

    async fn append_span_summary(&self, span: &ObservedSpanSummary) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(span).map_err(StoreError::from)?;
        atomic_write(&self.span_path(&span.id), &bytes).await
    }

    async fn append_metric_point(&self, point: &MetricPoint) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(point).map_err(StoreError::from)?;
        atomic_write(&self.metric_path(&point.id), &bytes).await
    }

    async fn list_runs(&self, filter: ObservabilityFilter) -> Result<Vec<ObservedRun>, BoxError> {
        let mut rows: Vec<ObservedRun> = read_json_records(&self.dir.join("runs")).await?;
        rows.retain(|r| {
            filter.kind.as_ref().map_or(true, |k| &r.kind == k)
                && filter.name.as_ref().map_or(true, |n| &r.name == n)
                && filter.outcome.as_ref().map_or(true, |o| &r.outcome == o)
                && filter
                    .project_id
                    .as_ref()
                    .map_or(true, |p| r.project_id.as_deref() == Some(p.as_str()))
        });
        rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        if let Some(limit) = filter.limit {
            rows.truncate(limit as usize);
        }
        Ok(rows)
    }

    async fn dashboard(&self, window: TimeWindow) -> Result<DashboardSnapshot, BoxError> {
        let rows = self
            .list_runs(ObservabilityFilter {
                limit: Some(10_000),
                ..ObservabilityFilter::default()
            })
            .await?;
        let total_runs = rows.len();
        let successful_runs = rows
            .iter()
            .filter(|r| r.outcome == ObservedOutcome::Success)
            .count();
        let failed_runs = rows
            .iter()
            .filter(|r| r.outcome != ObservedOutcome::Success)
            .count();
        let run_success_rate = (total_runs > 0).then(|| successful_runs as f64 / total_runs as f64);
        let p95_latency_ms = percentile_latency(&rows, 0.95);
        Ok(DashboardSnapshot {
            window,
            generated_at: Utc::now().to_rfc3339(),
            total_runs,
            successful_runs,
            failed_runs,
            run_success_rate,
            p95_latency_ms,
            by_kind: serde_json::json!(count_by(&rows, |r| format!("{:?}", r.kind))),
            by_name: serde_json::json!(count_by(&rows, |r| r.name.clone())),
        })
    }
}

pub struct JsonFileEvalStore {
    dir: PathBuf,
}

impl JsonFileEvalStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        ensure_dir(&dir.join("suites"))?;
        ensure_dir(&dir.join("cases"))?;
        ensure_dir(&dir.join("baselines"))?;
        Ok(Self { dir })
    }

    fn suite_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("suites")
            .join(format!("{}.json", encode_id(id)))
    }

    fn case_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("cases")
            .join(format!("{}.json", encode_id(id)))
    }

    fn baseline_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("baselines")
            .join(format!("{}.json", encode_id(id)))
    }
}

#[async_trait]
impl EvalStore for JsonFileEvalStore {
    async fn save_suite_run(&self, run: &EvalSuiteRun) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(run).map_err(StoreError::from)?;
        atomic_write(&self.suite_path(&run.id), &bytes).await
    }

    async fn save_case_result(&self, result: &EvalCaseResult) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(result).map_err(StoreError::from)?;
        atomic_write(&self.case_path(&result.id), &bytes).await
    }

    async fn save_baseline(&self, baseline: &EvalBaseline) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(baseline).map_err(StoreError::from)?;
        atomic_write(&self.baseline_path(&baseline.id), &bytes).await
    }

    async fn load_baseline(&self, id: &str) -> Result<Option<EvalBaseline>, BoxError> {
        read_json_optional(&self.baseline_path(id)).await
    }

    async fn list_case_results(&self, filter: EvalFilter) -> Result<Vec<EvalCaseResult>, BoxError> {
        let mut rows: Vec<EvalCaseResult> = read_json_records(&self.dir.join("cases")).await?;
        rows.retain(|r| {
            filter.suite.as_ref().map_or(true, |s| &r.suite == s)
                && filter
                    .suite_kind
                    .as_ref()
                    .map_or(true, |kind| &r.suite_kind == kind)
                && filter.case_id.as_ref().map_or(true, |c| &r.case_id == c)
                && filter.outcome.as_ref().map_or(true, |o| &r.outcome == o)
        });
        rows.sort_by(|a, b| b.id.cmp(&a.id));
        if let Some(limit) = filter.limit {
            rows.truncate(limit as usize);
        }
        Ok(rows)
    }
}

// ---------- learning / skill-usage store -----------------------------------

/// Default retention cap for the skill-usage `events/` directory. Telemetry
/// fires on every skill `Listed`/`Viewed`/`Used`, so without a cap the
/// directory grows without bound and every `list_events`/`report` read pays
/// an O(N) full-directory scan. Mirrors [`DEFAULT_MAX_OBSERVED_RUNS`].
pub const DEFAULT_MAX_SKILL_USAGE_EVENTS: usize = 5000;

/// JSON-file backend for [`SkillUsageStore`]. Each event becomes one file
/// under `<dir>/events/<id>.json`; ids are synthesized from a UTC RFC-3339
/// timestamp + a monotonic per-process counter so concurrent writes inside
/// the same nanosecond don't collide. Same atomic-write + percent-encoded
/// filename discipline as the conversation store, so the directory is safe
/// to ship raw between machines.
pub struct JsonFileSkillUsageStore {
    dir: PathBuf,
    max_events: Option<usize>,
}

impl JsonFileSkillUsageStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        ensure_dir(&dir.join("events"))?;
        Ok(Self {
            dir,
            max_events: Some(DEFAULT_MAX_SKILL_USAGE_EVENTS),
        })
    }

    /// Override the `events/` retention cap. `Some(n)` keeps the newest
    /// `n` files; `None` disables pruning entirely.
    pub fn with_max_events(mut self, max_events: Option<usize>) -> Self {
        self.max_events = max_events;
        self
    }

    fn event_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("events")
            .join(format!("{}.json", encode_id(id)))
    }

    fn next_id(now: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("{now}-{n:08}")
    }
}

#[async_trait]
impl SkillUsageStore for JsonFileSkillUsageStore {
    async fn record_event(
        &self,
        mut event: SkillUsageEvent,
    ) -> Result<SkillUsageEvent, harness_learning::BoxError> {
        if event.created_at.is_empty() {
            event.created_at = Utc::now().to_rfc3339();
        }
        if event.id.is_empty() {
            event.id = Self::next_id(&event.created_at);
        }
        let bytes = serde_json::to_vec_pretty(&event).map_err(StoreError::from)?;
        atomic_write(&self.event_path(&event.id), &bytes).await?;
        if let Some(max) = self.max_events {
            prune_oldest_files(&self.dir.join("events"), max).await;
        }
        Ok(event)
    }

    async fn list_events(
        &self,
        filter: SkillUsageFilter,
    ) -> Result<Vec<SkillUsageEvent>, harness_learning::BoxError> {
        let mut rows: Vec<SkillUsageEvent> = read_json_records(&self.dir.join("events")).await?;
        rows.retain(|r| skill_usage_matches(r, &filter));
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
        // Aggregation always operates over the unbounded slice; `limit`
        // would only narrow the input and produce misleading totals.
        let mut wide = filter.clone();
        wide.limit = None;
        let events = self.list_events(wide).await?;
        Ok(fold_events_into_rows(events))
    }
}

// ---------- learning / long-term memory store ------------------------------

/// Default ceiling on `memories/*.json` files kept on disk. The store
/// writes one file per row and `list` rescans the whole directory, so
/// without a cap auto-captured rows (the auto-loop drops a `gotcha` per
/// failed run) grow the directory — and every `/v1/memories` read —
/// without bound. 5000 keeps a generous window for user-curated rows
/// while bounding disk + scan cost; pinned rows are never pruned.
/// Override at the composition root via
/// [`JsonFileMemoryStore::with_max_items`].
pub const DEFAULT_MAX_MEMORY_ITEMS: usize = 5000;

/// JSON-file backend for [`MemoryStore`]. One file per id under
/// `<dir>/memories/<id>.json`; ids are synthesised from a UTC RFC-3339
/// timestamp + a monotonic counter, same pattern as the skill-usage
/// store. Single source of truth for User Memory (Phase 1); the type
/// also handles Project / Workspace scope because Phase 4 will route
/// through this trait too.
pub struct JsonFileMemoryStore {
    dir: PathBuf,
    /// `Some(n)` caps `memories/` at roughly `n` files (oldest
    /// non-pinned pruned on `upsert`); `None` disables pruning.
    max_items: Option<usize>,
    /// Serialises the read-modify-write of [`MemoryStore::patch`] against
    /// itself and against [`MemoryStore::delete`] within a single
    /// process. Without it, two `patch` calls (or a `patch` racing a
    /// `delete`) would interleave their get/write and lose updates or
    /// resurrect a removed file. Cross-process atomicity would need an
    /// OS file lock and is out of scope here.
    write_lock: Mutex<()>,
}

impl JsonFileMemoryStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        ensure_dir(&dir.join("memories"))?;
        Ok(Self {
            dir,
            max_items: Some(DEFAULT_MAX_MEMORY_ITEMS),
            write_lock: Mutex::new(()),
        })
    }

    /// Override the `memories/` retention cap. `Some(n)` keeps roughly
    /// the newest `n` rows (pinned rows are always kept); `None`
    /// disables pruning entirely (unbounded growth).
    pub fn with_max_items(mut self, max_items: Option<usize>) -> Self {
        self.max_items = max_items;
        self
    }

    fn item_path(&self, id: &str) -> PathBuf {
        self.dir
            .join("memories")
            .join(format!("{}.json", encode_id(id)))
    }

    fn next_id(now: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("mem_{now}-{n:08}")
    }
}

#[async_trait]
impl MemoryStore for JsonFileMemoryStore {
    async fn list(
        &self,
        filter: MemoryFilter,
    ) -> Result<Vec<MemoryItem>, harness_learning::BoxError> {
        let mut rows: Vec<MemoryItem> = read_json_records(&self.dir.join("memories")).await?;
        rows.retain(|r| memory_matches(r, &filter));
        // Pinned first, then by updated_at descending. Stable when both
        // pinned + same timestamp so the UI list doesn't reshuffle.
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
        read_json_optional(&self.item_path(id)).await
    }

    async fn upsert(
        &self,
        mut item: MemoryItem,
    ) -> Result<MemoryItem, harness_learning::BoxError> {
        let now = Utc::now().to_rfc3339();
        if item.created_at.is_empty() {
            item.created_at = now.clone();
        }
        item.updated_at = now.clone();
        if item.id.is_empty() {
            item.id = Self::next_id(&now);
        }
        let bytes = serde_json::to_vec_pretty(&item).map_err(StoreError::from)?;
        atomic_write(&self.item_path(&item.id), &bytes).await?;
        if let Some(max) = self.max_items {
            prune_oldest_memory_items(&self.dir.join("memories"), max).await;
        }
        Ok(item)
    }

    /// Atomic (in-process) read-modify-write. The `write_lock` is held
    /// across get → apply → validate → persist, and `delete` takes the
    /// same lock, so a concurrent `delete` either lands before the
    /// `get` (we observe the missing file → `Ok(None)`, no resurrection)
    /// or after the persist (the file is removed). Two `patch` calls
    /// serialise, so neither loses the other's update.
    async fn patch(
        &self,
        id: &str,
        patch: MemoryPatch,
    ) -> Result<Option<MemoryItem>, harness_learning::BoxError> {
        let _guard = self.write_lock.lock().await;
        let Some(mut item) = read_json_optional::<MemoryItem>(&self.item_path(id)).await? else {
            return Ok(None);
        };
        patch.apply(&mut item);
        validate_memory_safe(&item)
            .map_err(|e| -> harness_learning::BoxError { Box::new(e) })?;
        item.updated_at = Utc::now().to_rfc3339();
        let bytes = serde_json::to_vec_pretty(&item).map_err(StoreError::from)?;
        atomic_write(&self.item_path(&item.id), &bytes).await?;
        Ok(Some(item))
    }

    async fn delete(&self, id: &str) -> Result<bool, harness_learning::BoxError> {
        let _guard = self.write_lock.lock().await;
        match tokio::fs::remove_file(&self.item_path(id)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

fn memory_matches(row: &MemoryItem, filter: &MemoryFilter) -> bool {
    if let Some(scope) = filter.scope.as_ref() {
        if &row.scope != scope {
            return false;
        }
    }
    if let Some(kind) = filter.kind.as_ref() {
        if &row.kind != kind {
            return false;
        }
    }
    if let Some(pin) = filter.pinned {
        if row.pinned != pin {
            return false;
        }
    }
    for required in &filter.tags {
        if !row.tags.iter().any(|t| t == required) {
            return false;
        }
    }
    true
}

// ---------- learning / skill-lifecycle store -------------------------------

/// JSON-file backend for [`SkillLifecycleStore`]. One file per skill
/// under `<dir>/skill-lifecycle/<name>.json`, percent-encoded so
/// arbitrary skill names land safely on every OS.
pub struct JsonFileSkillLifecycleStore {
    dir: PathBuf,
}

impl JsonFileSkillLifecycleStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        ensure_dir(&dir)?;
        ensure_dir(&dir.join("skill-lifecycle"))?;
        Ok(Self { dir })
    }

    fn row_path(&self, name: &str) -> PathBuf {
        self.dir
            .join("skill-lifecycle")
            .join(format!("{}.json", encode_id(name)))
    }
}

#[async_trait]
impl SkillLifecycleStore for JsonFileSkillLifecycleStore {
    async fn list(&self) -> Result<Vec<SkillLifecycle>, harness_learning::BoxError> {
        let mut rows: Vec<SkillLifecycle> =
            read_json_records(&self.dir.join("skill-lifecycle")).await?;
        rows.sort_by(|a, b| a.skill_name.cmp(&b.skill_name));
        Ok(rows)
    }

    async fn get(
        &self,
        skill_name: &str,
    ) -> Result<Option<SkillLifecycle>, harness_learning::BoxError> {
        read_json_optional(&self.row_path(skill_name)).await
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
        let bytes = serde_json::to_vec_pretty(&row).map_err(StoreError::from)?;
        atomic_write(&self.row_path(&row.skill_name), &bytes).await?;
        Ok(row)
    }

    async fn delete(&self, skill_name: &str) -> Result<bool, harness_learning::BoxError> {
        match tokio::fs::remove_file(&self.row_path(skill_name)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }
}

fn skill_usage_matches(row: &SkillUsageEvent, filter: &SkillUsageFilter) -> bool {
    if let Some(name) = filter.skill_name.as_ref() {
        if &row.skill_name != name {
            return false;
        }
    }
    if let Some(scope) = filter.scope.as_ref() {
        if &row.scope != scope {
            return false;
        }
    }
    if let Some(action) = filter.action.as_ref() {
        if &row.action != action {
            return false;
        }
    }
    if let Some(conv) = filter.conversation_id.as_ref() {
        if row.conversation_id.as_deref() != Some(conv.as_str()) {
            return false;
        }
    }
    true
}

// ---------- shared helpers -------------------------------------------------

async fn read_json_optional<T>(path: &Path) -> Result<Option<T>, BoxError>
where
    T: DeserializeOwned,
{
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Box::new(e)),
    };
    let value = serde_json::from_slice(&bytes).map_err(StoreError::from)?;
    Ok(Some(value))
}

async fn read_json_records<T>(dir: &Path) -> Result<Vec<T>, BoxError>
where
    T: DeserializeOwned,
{
    let mut out = Vec::new();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(Box::new(e)),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.is_dir() || !path.extension().is_some_and(|e| e == "json") {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if name.ends_with(".json.tmp") {
            continue;
        }
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if let Ok(value) = serde_json::from_slice(&bytes) {
            out.push(value);
        }
    }
    Ok(out)
}

fn percentile_latency(rows: &[ObservedRun], percentile: f64) -> Option<u64> {
    let mut values: Vec<u64> = rows.iter().filter_map(|r| r.duration_ms).collect();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let idx = ((values.len() as f64 - 1.0) * percentile).ceil() as usize;
    values.get(idx).copied()
}

fn count_by<F>(rows: &[ObservedRun], mut key: F) -> BTreeMap<String, usize>
where
    F: FnMut(&ObservedRun) -> String,
{
    let mut counts = BTreeMap::new();
    for row in rows {
        *counts.entry(key(row)).or_insert(0) += 1;
    }
    counts
}

/// On-disk [`ChannelBindingStore`].
///
/// Single JSON file `channel_bindings.json` under the base
/// directory holding every binding as one flat array. Bindings are
/// tiny (≈200 bytes each) and total volume scales with chats × channels,
/// not messages — even a heavy multi-channel deployment stays well
/// under a megabyte. The whole file is rewritten atomically on every
/// mutation, same pattern as [`crate::WorkspaceStore`].
pub struct JsonFileChannelBindingStore {
    path: PathBuf,
    state: tokio::sync::RwLock<Vec<ChannelBinding>>,
}

impl JsonFileChannelBindingStore {
    /// Open or create the store under `base_dir`. `base_dir` is
    /// shared with the conversation / project files; the bindings
    /// file sits at `<base_dir>/channel_bindings.json`. Missing /
    /// empty / corrupt files start as an empty registry — same
    /// degradation policy as `WorkspaceStore`.
    pub fn open(base_dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base_dir.into();
        ensure_dir(&base)?;
        let path = base.join("channel_bindings.json");
        let initial = match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() => {
                match serde_json::from_slice::<Vec<ChannelBinding>>(&bytes) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            path = %path.display(),
                            error = %e,
                            "channel_bindings.json parse failed; starting empty"
                        );
                        Vec::new()
                    }
                }
            }
            _ => Vec::new(),
        };
        Ok(Self {
            path,
            state: tokio::sync::RwLock::new(initial),
        })
    }

    async fn flush(&self, snapshot: &[ChannelBinding]) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(snapshot)?;
        atomic_write(&self.path, &bytes).await
    }
}

#[async_trait]
impl ChannelBindingStore for JsonFileChannelBindingStore {
    async fn upsert(&self, binding: &ChannelBinding) -> Result<(), BoxError> {
        let mut guard = self.state.write().await;
        if let Some(slot) = guard
            .iter_mut()
            .find(|b| b.channel == binding.channel && b.channel_chat_id == binding.channel_chat_id)
        {
            *slot = binding.clone();
        } else {
            guard.push(binding.clone());
        }
        let snapshot = guard.clone();
        drop(guard);
        self.flush(&snapshot).await
    }

    async fn lookup(
        &self,
        channel: &str,
        channel_chat_id: &str,
    ) -> Result<Option<ChannelBinding>, BoxError> {
        let guard = self.state.read().await;
        Ok(guard
            .iter()
            .find(|b| b.channel == channel && b.channel_chat_id == channel_chat_id)
            .cloned())
    }

    async fn list_for_channel(&self, channel: &str) -> Result<Vec<ChannelBinding>, BoxError> {
        let guard = self.state.read().await;
        let mut rows: Vec<ChannelBinding> = guard
            .iter()
            .filter(|b| b.channel == channel)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn delete(&self, channel: &str, channel_chat_id: &str) -> Result<bool, BoxError> {
        let mut guard = self.state.write().await;
        let before = guard.len();
        guard.retain(|b| !(b.channel == channel && b.channel_chat_id == channel_chat_id));
        let removed = before != guard.len();
        if !removed {
            return Ok(false);
        }
        let snapshot = guard.clone();
        drop(guard);
        self.flush(&snapshot).await?;
        Ok(true)
    }

    async fn delete_for_conversation(&self, conversation_id: &str) -> Result<usize, BoxError> {
        let mut guard = self.state.write().await;
        let before = guard.len();
        guard.retain(|b| b.conversation_id != conversation_id);
        let removed = before - guard.len();
        if removed == 0 {
            return Ok(0);
        }
        let snapshot = guard.clone();
        drop(guard);
        self.flush(&snapshot).await?;
        Ok(removed)
    }
}

/// JSON-file [`ChannelInstanceStore`] sibling. Same single-file
/// pattern as `JsonFileChannelBindingStore` — stored at
/// `<base_dir>/channel_instances.json`. Volume is bounded by what
/// the operator configures in Settings (typically <20 rows), so the
/// whole-file rewrite on every mutation is cheap.
pub struct JsonFileChannelInstanceStore {
    path: PathBuf,
    state: tokio::sync::RwLock<Vec<harness_channel::ChannelInstance>>,
}

impl JsonFileChannelInstanceStore {
    pub fn open(base_dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let base = base_dir.into();
        ensure_dir(&base)?;
        let path = base.join("channel_instances.json");
        let initial = match std::fs::read(&path) {
            Ok(bytes) if !bytes.is_empty() => {
                match serde_json::from_slice::<Vec<harness_channel::ChannelInstance>>(&bytes) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            path = %path.display(),
                            error = %e,
                            "channel_instances.json parse failed; starting empty"
                        );
                        Vec::new()
                    }
                }
            }
            _ => Vec::new(),
        };
        Ok(Self {
            path,
            state: tokio::sync::RwLock::new(initial),
        })
    }

    async fn flush(&self, snapshot: &[harness_channel::ChannelInstance]) -> Result<(), BoxError> {
        let bytes = serde_json::to_vec_pretty(snapshot)?;
        atomic_write(&self.path, &bytes).await
    }
}

#[async_trait]
impl harness_channel::ChannelInstanceStore for JsonFileChannelInstanceStore {
    async fn upsert(&self, instance: &harness_channel::ChannelInstance) -> Result<(), BoxError> {
        let mut guard = self.state.write().await;
        if let Some(slot) = guard.iter_mut().find(|i| i.id == instance.id) {
            *slot = instance.clone();
        } else {
            guard.push(instance.clone());
        }
        let snapshot = guard.clone();
        drop(guard);
        self.flush(&snapshot).await
    }

    async fn get(&self, id: &str) -> Result<Option<harness_channel::ChannelInstance>, BoxError> {
        let guard = self.state.read().await;
        Ok(guard.iter().find(|i| i.id == id).cloned())
    }

    async fn list(&self) -> Result<Vec<harness_channel::ChannelInstance>, BoxError> {
        let guard = self.state.read().await;
        let mut rows: Vec<harness_channel::ChannelInstance> = guard.clone();
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(rows)
    }

    async fn delete(&self, id: &str) -> Result<bool, BoxError> {
        let mut guard = self.state.write().await;
        let before = guard.len();
        guard.retain(|i| i.id != id);
        if before == guard.len() {
            return Ok(false);
        }
        let snapshot = guard.clone();
        drop(guard);
        self.flush(&snapshot).await?;
        Ok(true)
    }
}

fn ensure_dir(dir: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| StoreError::Other(format!("create {}: {e}", dir.display()).into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o700);
        let _ = std::fs::set_permissions(dir, perm);
    }
    Ok(())
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), BoxError> {
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(0o600);
        let _ = tokio::fs::set_permissions(&tmp, perm).await;
    }
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

// ---------- cascade-delete helpers ----------

/// Read every `<rid>.json` file under `dir` and return the row's `id`
/// field. Used by `ProjectStore::delete` to know which requirement
/// subtrees to nuke. Returns an empty vec if the directory doesn't
/// exist or any individual file is unreadable / malformed —
/// best-effort cleanup, never the source of truth.
async fn collect_dir_ids(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(_) => return out,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".json") || name_str.ends_with(".json.tmp") {
            continue;
        }
        let bytes = match tokio::fs::read(entry.path()).await {
            Ok(b) => b,
            Err(_) => continue,
        };
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// Bound a directory of `<id>.json` records to at most `max` files,
/// deleting the oldest (by mtime) once it grows past a slack margin.
///
/// Best-effort: any I/O error short-circuits silently — a flaky prune
/// must never break the append that triggered it.
///
/// Two-pass to stay cheap on the hot path: pass one just *counts*
/// `.json` files (no per-entry `stat`), and only when the count
/// exceeds `max + max/10` does pass two `stat` each file for its mtime,
/// sort, and delete down to `max`. The 10% slack batches the
/// expensive pass so steady-state appends pay only the directory walk.
async fn prune_oldest_files(dir: &Path, max: usize) {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(_) => return,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".json") || name.ends_with(".json.tmp") {
            continue;
        }
        paths.push(entry.path());
    }

    // Slack so we don't re-scan-and-stat on every single append once at
    // steady state — only when we've drifted `max/10` past the cap.
    let slack = max / 10;
    if paths.len() <= max.saturating_add(slack) {
        return;
    }

    let mut stamped: Vec<(std::time::SystemTime, PathBuf)> = Vec::with_capacity(paths.len());
    for path in paths {
        let mtime = match tokio::fs::metadata(&path).await {
            Ok(meta) => meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            Err(_) => std::time::UNIX_EPOCH,
        };
        stamped.push((mtime, path));
    }
    stamped.sort_by_key(|a| a.0);

    let to_remove = stamped.len().saturating_sub(max);
    for (_, path) in stamped.into_iter().take(to_remove) {
        let _ = tokio::fs::remove_file(&path).await;
    }
}

/// Prune the `memories/` directory down to roughly `max` rows, deleting
/// the oldest *non-pinned* items first. Pinned rows are user-curated and
/// are never pruned, so a flood of auto-captured `gotcha` rows can't
/// evict a hand-pinned preference.
///
/// Best-effort: any I/O error short-circuits silently — a flaky prune
/// must never break the `upsert` that triggered it.
///
/// Cheap on the hot path: pass one only *counts* `.json` files and bails
/// when under `max + max/10`; only past that 10% slack does pass two
/// read every row to partition pinned vs. not and sort the candidates.
async fn prune_oldest_memory_items(dir: &Path, max: usize) {
    let mut count = 0usize;
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(d) => d,
        Err(_) => return,
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".json") && !name.ends_with(".json.tmp") {
            count += 1;
        }
    }

    // Slack so we don't read-and-sort on every append once at steady
    // state — only when we've drifted `max/10` past the cap.
    if count <= max.saturating_add(max / 10) {
        return;
    }

    let rows: Vec<MemoryItem> = match read_json_records(dir).await {
        Ok(rows) => rows,
        Err(_) => return,
    };
    // Pinned rows are protected but still consume the budget, so the
    // total still trends toward `max`. If pinned alone exceeds the cap
    // we keep them all and prune every non-pinned row.
    let pinned = rows.iter().filter(|r| r.pinned).count();
    let keep_non_pinned = max.saturating_sub(pinned);
    let mut victims: Vec<MemoryItem> = rows.into_iter().filter(|r| !r.pinned).collect();
    // Oldest first by `updated_at`, so `skip(keep)` keeps the newest.
    victims.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
    let drop_count = victims.len().saturating_sub(keep_non_pinned);
    for victim in victims.into_iter().take(drop_count) {
        let _ = tokio::fs::remove_file(&dir.join(format!("{}.json", encode_id(&victim.id)))).await;
    }
}

async fn remove_dir_all_if_exists(dir: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(dir).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------- id <-> filename ----------

/// Percent-encode any byte that isn't `[A-Za-z0-9._-]`. UUIDs and
/// most random ids pass through unchanged; `:` (used by the
/// `__memory__.summary:` namespace) becomes `%3A`.
fn encode_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{:02X}", b);
        }
    }
    out
}

/// Inverse of `encode_id`. Returns `None` on malformed input
/// (truncated `%XX`, non-hex). Used only for sanity checks in tests
/// — `list()` reads ids out of the file body, not the filename.
#[cfg(test)]
fn decode_id(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi * 16 + lo) & 0xff) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::Message;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn convo(content: &str) -> Conversation {
        let mut c = Conversation::new();
        c.push(Message::user(content));
        c
    }

    #[tokio::test]
    async fn save_load_round_trip() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("hello")).await.unwrap();
        let loaded = store.load("c1").await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
    }

    #[tokio::test]
    async fn envelope_persists_project_id() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        let meta = ConversationMetadata::with_project("p-1");
        store
            .save_envelope("c1", &convo("hi"), &meta)
            .await
            .unwrap();
        let (_, loaded_meta) = store.load_envelope("c1").await.unwrap().unwrap();
        assert_eq!(loaded_meta.project_id.as_deref(), Some("p-1"));

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows[0].project_id.as_deref(), Some("p-1"));
    }

    #[tokio::test]
    async fn loading_legacy_file_without_project_id_works() {
        // Files written before the Project feature have no
        // `project_id` field — they must still deserialise.
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        // Hand-craft an old-shape file.
        let legacy = r#"{
            "id": "legacy",
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
            "messages": []
        }"#;
        tokio::fs::write(dir.path().join("legacy.json"), legacy)
            .await
            .unwrap();

        let (_, meta) = store.load_envelope("legacy").await.unwrap().unwrap();
        assert_eq!(meta.project_id, None);
    }

    #[tokio::test]
    async fn save_overwrites_and_preserves_created_at() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("first")).await.unwrap();
        let first_created = first_record(&store).await.created_at;
        // tiny sleep so updated_at differs
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        store.save("c1", &convo("second")).await.unwrap();
        let updated = first_record(&store).await;
        assert_eq!(updated.created_at, first_created);
        assert!(updated.updated_at > first_created);
    }

    #[tokio::test]
    async fn list_orders_newest_first() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("a", &convo("x")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        store.save("b", &convo("y")).await.unwrap();

        let rows = store.list(10).await.unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[tokio::test]
    async fn list_respects_limit() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();
        for i in 0..5 {
            store.save(&format!("c{i}"), &convo("x")).await.unwrap();
        }
        let rows = store.list(3).await.unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[tokio::test]
    async fn list_skips_projects_subdir() {
        // `JsonFileProjectStore` puts files under `<dir>/projects/` —
        // the conversation `list()` must skip subdirectories so it
        // doesn't trip over them.
        let dir = tempdir().unwrap();
        let conv_store = JsonFileConversationStore::open(dir.path()).unwrap();
        let proj_store = JsonFileProjectStore::open(dir.path()).unwrap();

        conv_store.save("c1", &convo("x")).await.unwrap();
        proj_store
            .save(&Project::new("P", "i").with_slug("p"))
            .await
            .unwrap();

        let rows = conv_store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "c1");
    }

    #[tokio::test]
    async fn delete_idempotent_and_reports_existence() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("c1", &convo("x")).await.unwrap();
        assert!(store.delete("c1").await.unwrap());
        assert!(store.load("c1").await.unwrap().is_none());
        assert!(!store.delete("c1").await.unwrap());
    }

    #[tokio::test]
    async fn handles_internal_namespace_ids_with_colons() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        let id = "__memory__.summary:abcdef0123456789";
        store.save(id, &convo("summary text")).await.unwrap();
        let loaded = store.load(id).await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);

        // The on-disk filename should NOT contain a literal colon.
        let mut found_filename = None;
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                continue;
            }
            let name = entry.file_name().into_string().unwrap();
            if name.ends_with(".json") {
                found_filename = Some(name);
                break;
            }
        }
        let name = found_filename.expect("no .json file written");
        assert!(!name.contains(':'), "filename leaked a colon: {name}");
        assert!(name.contains("%3A"), "expected %3A escape, got {name}");

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
    }

    #[tokio::test]
    async fn list_skips_tmp_and_unparseable_files() {
        let dir = tempdir().unwrap();
        let store = JsonFileConversationStore::open(dir.path()).unwrap();

        store.save("good", &convo("x")).await.unwrap();
        std::fs::write(dir.path().join("c1.json.tmp"), b"not real").unwrap();
        std::fs::write(dir.path().join("garbage.json"), b"{ not json").unwrap();

        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "good");
    }

    #[test]
    fn encode_decode_round_trip() {
        for raw in [
            "uuid-style-7b6f8e9c",
            "__memory__.summary:abc123",
            "weird/path",
            "with spaces and !@#",
            "中文",
        ] {
            let enc = encode_id(raw);
            let dec = decode_id(&enc).expect("decode");
            assert_eq!(dec, raw, "round trip failed for {raw:?}");
        }
    }

    async fn first_record(store: &JsonFileConversationStore) -> ConversationRecord {
        let rows = store.list(1).await.unwrap();
        rows.into_iter().next().expect("no records")
    }

    // ---- ProjectStore --------------------------------------------------

    #[tokio::test]
    async fn project_save_load_and_slug_lookup() {
        let dir = tempdir().unwrap();
        let store = JsonFileProjectStore::open(dir.path()).unwrap();
        let p = Project::new("Writing", "be poetic").with_slug("writing");
        store.save(&p).await.unwrap();

        assert_eq!(store.load(&p.id).await.unwrap().unwrap(), p);
        assert_eq!(store.find_by_slug("writing").await.unwrap().unwrap(), p);
    }

    #[tokio::test]
    async fn project_rejects_duplicate_slug() {
        let dir = tempdir().unwrap();
        let store = JsonFileProjectStore::open(dir.path()).unwrap();
        store
            .save(&Project::new("A", "x").with_slug("dup"))
            .await
            .unwrap();
        let err = store
            .save(&Project::new("B", "y").with_slug("dup"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("dup"));
    }

    #[tokio::test]
    async fn project_archive_then_list_default_excludes() {
        let dir = tempdir().unwrap();
        let store = JsonFileProjectStore::open(dir.path()).unwrap();
        let p = Project::new("Z", "x").with_slug("z");
        store.save(&p).await.unwrap();
        store.archive(&p.id).await.unwrap();

        assert!(store.list(false, 10).await.unwrap().is_empty());
        assert_eq!(store.list(true, 10).await.unwrap().len(), 1);
        assert!(store.load(&p.id).await.unwrap().unwrap().archived);
    }

    #[tokio::test]
    async fn project_delete_returns_existence() {
        let dir = tempdir().unwrap();
        let store = JsonFileProjectStore::open(dir.path()).unwrap();
        let p = Project::new("D", "x").with_slug("d");
        store.save(&p).await.unwrap();
        assert!(store.delete(&p.id).await.unwrap());
        assert!(!store.delete(&p.id).await.unwrap());
    }

    // ---- TodoStore -----------------------------------------------------

    use harness_core::TodoStatus;

    #[tokio::test]
    async fn todo_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileTodoStore::open(dir.path()).unwrap();
        let mut t = TodoItem::new("/repo-a", "fix parser");
        t.notes = Some("blocked by ticket #5".into());
        store.upsert(&t).await.unwrap();

        let listed = store.list("/repo-a").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], t);

        // Reopen — must round-trip.
        drop(store);
        let store = JsonFileTodoStore::open(dir.path()).unwrap();
        let loaded = store.get(&t.id).await.unwrap().unwrap();
        assert_eq!(loaded, t);
    }

    #[tokio::test]
    async fn todo_list_isolates_workspaces() {
        let dir = tempdir().unwrap();
        let store = JsonFileTodoStore::open(dir.path()).unwrap();
        let a = TodoItem::new("/r-a", "alpha");
        let b = TodoItem::new("/r-b", "beta");
        store.upsert(&a).await.unwrap();
        store.upsert(&b).await.unwrap();
        assert_eq!(store.list("/r-a").await.unwrap().len(), 1);
        assert_eq!(store.list("/r-b").await.unwrap().len(), 1);
        assert!(store.list("/never").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn todo_workspace_with_special_chars_round_trips() {
        // `/path/with spaces:and/colons` must percent-encode safely
        // for the directory name on disk.
        let dir = tempdir().unwrap();
        let store = JsonFileTodoStore::open(dir.path()).unwrap();
        let weird = "/path with spaces:and/colons";
        let mut t = TodoItem::new(weird, "x");
        t.status = TodoStatus::InProgress;
        store.upsert(&t).await.unwrap();
        let listed = store.list(weird).await.unwrap();
        assert_eq!(listed.len(), 1);
        // Disk filename should not leak ':'.
        let mut found_dir = false;
        for entry in std::fs::read_dir(dir.path().join("todos")).unwrap() {
            let entry = entry.unwrap();
            assert!(!entry.file_name().to_string_lossy().contains(':'));
            found_dir = true;
        }
        assert!(found_dir);
    }

    #[tokio::test]
    async fn todo_delete_idempotent_and_emits_once() {
        let dir = tempdir().unwrap();
        let store = JsonFileTodoStore::open(dir.path()).unwrap();
        let mut rx = store.subscribe();
        let t = TodoItem::new("/r", "x");
        store.upsert(&t).await.unwrap();
        let _ = rx.recv().await.unwrap();
        assert!(store.delete(&t.id).await.unwrap());
        let _ = rx.recv().await.unwrap();
        assert!(!store.delete(&t.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- RequirementStore -----------------------------------------------

    use harness_project::RequirementStatus;

    #[tokio::test]
    async fn requirement_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let mut r = Requirement::new("p-a", "ship the kanban");
        r.description = Some("Build it".into());
        r.status = RequirementStatus::Review;
        r.conversation_ids = vec!["c1".into()];
        store.upsert(&r).await.unwrap();

        let listed = store.list("p-a").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], r);

        // Reopen — must round-trip.
        drop(store);
        let store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let loaded = store.get(&r.id).await.unwrap().unwrap();
        assert_eq!(loaded, r);
    }

    #[tokio::test]
    async fn requirement_list_isolates_projects() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let a = Requirement::new("p-a", "alpha");
        let b = Requirement::new("p-b", "beta");
        store.upsert(&a).await.unwrap();
        store.upsert(&b).await.unwrap();
        assert_eq!(store.list("p-a").await.unwrap().len(), 1);
        assert_eq!(store.list("p-b").await.unwrap().len(), 1);
        assert!(store.list("never").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn requirement_delete_idempotent_and_emits_once() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let mut rx = store.subscribe();
        let r = Requirement::new("p", "x");
        store.upsert(&r).await.unwrap();
        let _ = rx.recv().await.unwrap();
        assert!(store.delete(&r.id).await.unwrap());
        let _ = rx.recv().await.unwrap();
        assert!(!store.delete(&r.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn requirement_delete_cascades_runs_activities_comments() {
        use harness_project::{Activity, ActivityActor, ActivityKind};
        use serde_json::json;
        let dir = tempdir().unwrap();
        let req_store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let run_store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let act_store = JsonFileActivityStore::open(dir.path()).unwrap();

        let r = Requirement::new("p-1", "X");
        req_store.upsert(&r).await.unwrap();
        let run = RequirementRun::new(&r.id, "conv-1");
        run_store.upsert(&run).await.unwrap();
        let act = Activity::new(
            &r.id,
            ActivityKind::StatusChange,
            ActivityActor::System,
            json!({}),
        );
        act_store.append(&act).await.unwrap();

        assert!(req_store.delete(&r.id).await.unwrap());
        // The cascaded subtrees are gone — list returns empty for both.
        assert!(run_store
            .list_for_requirement(&r.id)
            .await
            .unwrap()
            .is_empty());
        assert!(act_store
            .list_for_requirement(&r.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn project_delete_cascades_to_requirements_and_runs() {
        use harness_project::{Activity, ActivityActor, ActivityKind};
        use serde_json::json;
        let dir = tempdir().unwrap();
        let proj_store = JsonFileProjectStore::open(dir.path()).unwrap();
        let req_store = JsonFileRequirementStore::open(dir.path()).unwrap();
        let run_store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let act_store = JsonFileActivityStore::open(dir.path()).unwrap();

        let p = Project::new("zombie", "Zombie").with_slug("zombie");
        proj_store.save(&p).await.unwrap();
        let r1 = Requirement::new(&p.id, "r1");
        let r2 = Requirement::new(&p.id, "r2");
        req_store.upsert(&r1).await.unwrap();
        req_store.upsert(&r2).await.unwrap();
        run_store
            .upsert(&RequirementRun::new(&r1.id, "c-r1"))
            .await
            .unwrap();
        run_store
            .upsert(&RequirementRun::new(&r2.id, "c-r2"))
            .await
            .unwrap();
        act_store
            .append(&Activity::new(
                &r1.id,
                ActivityKind::StatusChange,
                ActivityActor::System,
                json!({}),
            ))
            .await
            .unwrap();

        assert!(proj_store.delete(&p.id).await.unwrap());

        assert!(req_store.list(&p.id).await.unwrap().is_empty());
        assert!(run_store
            .list_for_requirement(&r1.id)
            .await
            .unwrap()
            .is_empty());
        assert!(run_store
            .list_for_requirement(&r2.id)
            .await
            .unwrap()
            .is_empty());
        assert!(act_store
            .list_for_requirement(&r1.id)
            .await
            .unwrap()
            .is_empty());
    }

    // ---- RequirementRunStore --------------------------------------------

    use harness_project::RequirementRunStatus;

    #[tokio::test]
    async fn requirement_run_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let mut r = RequirementRun::new("req-1", "conv-1");
        r.summary = Some("changed serializer".into());
        r.status = RequirementRunStatus::Completed;
        r.finished_at = Some("2026-04-30T01:23:45+00:00".into());
        store.upsert(&r).await.unwrap();

        let listed = store.list_for_requirement("req-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], r);

        // Reopen — must round-trip.
        drop(store);
        let store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let loaded = store.get(&r.id).await.unwrap().unwrap();
        assert_eq!(loaded, r);
    }

    #[tokio::test]
    async fn requirement_run_list_isolates_requirements() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let a = RequirementRun::new("req-a", "conv-a");
        let b = RequirementRun::new("req-b", "conv-b");
        store.upsert(&a).await.unwrap();
        store.upsert(&b).await.unwrap();
        assert_eq!(store.list_for_requirement("req-a").await.unwrap().len(), 1);
        assert_eq!(store.list_for_requirement("req-b").await.unwrap().len(), 1);
        assert!(store
            .list_for_requirement("never")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn requirement_run_emits_started_then_finished() {
        let dir = tempdir().unwrap();
        let store = JsonFileRequirementRunStore::open(dir.path()).unwrap();
        let mut rx = store.subscribe();
        let mut r = RequirementRun::new("req", "conv");
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Started(run) => assert_eq!(run.id, r.id),
            other => panic!("expected Started, got {other:?}"),
        }
        r.finish(RequirementRunStatus::Completed);
        store.upsert(&r).await.unwrap();
        match rx.recv().await.unwrap() {
            RequirementRunEvent::Finished(run) => {
                assert_eq!(run.status, RequirementRunStatus::Completed)
            }
            other => panic!("expected Finished, got {other:?}"),
        }
        // Quiet on subsequent no-op upserts.
        store.upsert(&r).await.unwrap();
        assert!(rx.try_recv().is_err());
    }

    // ---- AgentProfileStore ----------------------------------------------

    #[tokio::test]
    async fn agent_profile_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileAgentProfileStore::open(dir.path()).unwrap();
        let mut p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        p.system_prompt = Some("You are Alice. Be concise.".into());
        store.upsert(&p).await.unwrap();

        let listed = store.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], p);

        // Reopen — must round-trip.
        drop(store);
        let store = JsonFileAgentProfileStore::open(dir.path()).unwrap();
        let loaded = store.get(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);
    }

    #[tokio::test]
    async fn agent_profile_delete_idempotent_and_emits_once() {
        let dir = tempdir().unwrap();
        let store = JsonFileAgentProfileStore::open(dir.path()).unwrap();
        let mut rx = store.subscribe();
        let p = AgentProfile::new("Alice", "openai", "gpt-4o-mini");
        store.upsert(&p).await.unwrap();
        let _ = rx.recv().await.unwrap();
        assert!(store.delete(&p.id).await.unwrap());
        let _ = rx.recv().await.unwrap();
        assert!(!store.delete(&p.id).await.unwrap());
        assert!(rx.try_recv().is_err());
    }

    // ---- ActivityStore --------------------------------------------------

    use harness_project::{ActivityActor, ActivityKind};
    use serde_json::json;

    #[tokio::test]
    async fn activity_append_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileActivityStore::open(dir.path()).unwrap();
        let a = Activity::new(
            "req-1",
            ActivityKind::StatusChange,
            ActivityActor::Human,
            json!({"from": "backlog", "to": "in_progress"}),
        );
        store.append(&a).await.unwrap();

        let listed = store.list_for_requirement("req-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], a);

        // Reopen — must round-trip from disk.
        drop(store);
        let store = JsonFileActivityStore::open(dir.path()).unwrap();
        let listed = store.list_for_requirement("req-1").await.unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[tokio::test]
    async fn activity_emits_appended_on_write() {
        let dir = tempdir().unwrap();
        let store = JsonFileActivityStore::open(dir.path()).unwrap();
        let mut rx = store.subscribe();
        let a = Activity::new(
            "req",
            ActivityKind::RunStarted,
            ActivityActor::System,
            json!({"run_id": "r1"}),
        );
        store.append(&a).await.unwrap();
        match rx.recv().await.unwrap() {
            ActivityEvent::Appended(got) => assert_eq!(got.id, a.id),
        }
    }

    // ---- DocStore -------------------------------------------------------

    #[tokio::test]
    async fn doc_project_round_trip_persists_to_disk() {
        let dir = tempdir().unwrap();
        let store = JsonFileDocStore::open(dir.path()).unwrap();
        let mut p = DocProject::new("/r-a", "weekly review");
        p.kind = harness_project::DocKind::Report;
        store.upsert_project(&p).await.unwrap();

        let listed = store.list_projects("/r-a").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], p);

        // Reopen — must round-trip.
        drop(store);
        let store = JsonFileDocStore::open(dir.path()).unwrap();
        let loaded = store.get_project(&p.id).await.unwrap().unwrap();
        assert_eq!(loaded, p);
    }

    #[tokio::test]
    async fn doc_draft_round_trip_and_cascade_delete() {
        let dir = tempdir().unwrap();
        let store = JsonFileDocStore::open(dir.path()).unwrap();
        let p = DocProject::new("/r", "x");
        store.upsert_project(&p).await.unwrap();
        let d = DocDraft::new(&p.id, "# hi\n");
        store.upsert_draft(&d).await.unwrap();
        assert_eq!(store.list_drafts(&p.id).await.unwrap().len(), 1);

        // Delete cascades.
        assert!(store.delete_project(&p.id).await.unwrap());
        assert!(store.list_drafts(&p.id).await.unwrap().is_empty());
        assert!(store.get_project(&p.id).await.unwrap().is_none());

        // Idempotent.
        assert!(!store.delete_project(&p.id).await.unwrap());
    }

    #[tokio::test]
    async fn doc_list_isolates_workspaces() {
        let dir = tempdir().unwrap();
        let store = JsonFileDocStore::open(dir.path()).unwrap();
        let a = DocProject::new("/r-a", "alpha");
        let b = DocProject::new("/r-b", "beta");
        store.upsert_project(&a).await.unwrap();
        store.upsert_project(&b).await.unwrap();
        assert_eq!(store.list_projects("/r-a").await.unwrap().len(), 1);
        assert_eq!(store.list_projects("/r-b").await.unwrap().len(), 1);
        assert!(store.list_projects("/never").await.unwrap().is_empty());
    }

    // ---- TenantStore ----------------------------------------------------

    #[tokio::test]
    async fn first_start_creates_default_tenant() {
        let dir = tempdir().unwrap();
        let store = JsonFileTenantStore::open(dir.path()).unwrap();
        crate::ensure_default_tenant(Arc::new(store)).await.unwrap();
        let store = JsonFileTenantStore::open(dir.path()).unwrap();
        let t = store.find_by_slug("default").await.unwrap().unwrap();
        assert_eq!(t.slug, "default");
        assert_eq!(t.name, "Default");

        // Idempotent.
        crate::ensure_default_tenant(Arc::new(store)).await.unwrap();
        let store = JsonFileTenantStore::open(dir.path()).unwrap();
        let list = store.list().await.unwrap();
        assert_eq!(list.len(), 1);
    }

    #[tokio::test]
    async fn tenant_save_rejects_duplicate_slug() {
        let dir = tempdir().unwrap();
        let store = JsonFileTenantStore::open(dir.path()).unwrap();
        let a = Tenant::new("A").with_slug("dup");
        let b = Tenant::new("B").with_slug("dup");
        store.save(&a).await.unwrap();
        let err = store.save(&b).await.unwrap_err();
        assert!(err.to_string().contains("dup"));
    }

    // ---- Observability / Eval stores -----------------------------------

    #[tokio::test]
    async fn observability_store_persists_runs_and_dashboard() {
        let dir = tempdir().unwrap();
        let store = JsonFileObservabilityStore::open(dir.path()).unwrap();
        let run = ObservedRun {
            id: "run-1".into(),
            trace_id: Some("trace-1".into()),
            span_id: Some("span-1".into()),
            parent_run_id: None,
            kind: harness_observability::ObservedRunKind::Agent,
            name: "jarvis.agent.run".into(),
            started_at: "2026-05-08T00:00:00Z".into(),
            ended_at: Some("2026-05-08T00:00:01Z".into()),
            duration_ms: Some(1000),
            outcome: ObservedOutcome::Success,
            conversation_id: Some("conv-1".into()),
            project_id: Some("proj-1".into()),
            workspace_hash: Some("workspace".into()),
            attributes: serde_json::json!({"transport": "eval"}),
            metrics: serde_json::json!({"iterations": 2}),
            artifact_ids: Vec::new(),
        };
        store.append_run(&run).await.unwrap();

        let rows = store
            .list_runs(ObservabilityFilter {
                project_id: Some("proj-1".into()),
                ..ObservabilityFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(rows, vec![run]);

        let snapshot = store.dashboard(TimeWindow::last_24h()).await.unwrap();
        assert_eq!(snapshot.total_runs, 1);
        assert_eq!(snapshot.successful_runs, 1);
        assert_eq!(snapshot.p95_latency_ms, Some(1000));
    }

    fn sample_run(id: &str) -> ObservedRun {
        ObservedRun {
            id: id.into(),
            trace_id: None,
            span_id: None,
            parent_run_id: None,
            kind: harness_observability::ObservedRunKind::Tool,
            name: "echo".into(),
            started_at: "2026-05-08T00:00:00Z".into(),
            ended_at: Some("2026-05-08T00:00:00Z".into()),
            duration_ms: Some(1),
            outcome: ObservedOutcome::Success,
            conversation_id: None,
            project_id: None,
            workspace_hash: None,
            attributes: serde_json::json!({}),
            metrics: serde_json::json!({}),
            artifact_ids: Vec::new(),
        }
    }

    fn runs_file_count(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("runs"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name.ends_with(".json") && !name.ends_with(".json.tmp")
            })
            .count()
    }

    #[tokio::test]
    async fn observability_runs_are_capped_when_max_set() {
        let dir = tempdir().unwrap();
        // slack = max/10 = 0, so steady state is exactly `max`.
        let store = JsonFileObservabilityStore::open(dir.path())
            .unwrap()
            .with_max_runs(Some(5));
        for i in 0..30 {
            store.append_run(&sample_run(&format!("run-{i:03}"))).await.unwrap();
        }
        assert_eq!(runs_file_count(dir.path()), 5, "runs/ must be bounded by the cap");
        let rows = store.list_runs(ObservabilityFilter::default()).await.unwrap();
        assert_eq!(rows.len(), 5);
    }

    #[tokio::test]
    async fn observability_runs_unbounded_when_max_none() {
        let dir = tempdir().unwrap();
        let store = JsonFileObservabilityStore::open(dir.path())
            .unwrap()
            .with_max_runs(None);
        for i in 0..12 {
            store.append_run(&sample_run(&format!("run-{i:03}"))).await.unwrap();
        }
        assert_eq!(runs_file_count(dir.path()), 12, "None disables pruning");
    }

    #[tokio::test]
    async fn eval_store_persists_baselines_and_case_results() {
        let dir = tempdir().unwrap();
        let store = JsonFileEvalStore::open(dir.path()).unwrap();
        let baseline = EvalBaseline {
            id: "base-1".into(),
            suite: "coding-smoke".into(),
            suite_kind: harness_observability::EvalSuiteKind::Regression,
            created_at: "2026-05-08T00:00:00Z".into(),
            git_ref: Some("main".into()),
            model: Some("test-model".into()),
            summary: serde_json::json!({"pass_rate": 1.0}),
            cases: serde_json::json!({}),
        };
        store.save_baseline(&baseline).await.unwrap();
        assert_eq!(store.load_baseline("base-1").await.unwrap(), Some(baseline));

        let result = EvalCaseResult {
            id: "case-result-1".into(),
            suite_run_id: "suite-run-1".into(),
            case_id: "case-1".into(),
            suite: "coding-smoke".into(),
            suite_kind: harness_observability::EvalSuiteKind::Regression,
            scenario: "tool-use".into(),
            trial_index: 0,
            trial_count: Some(3),
            outcome: ObservedOutcome::Error,
            trace_id: Some("trace-1".into()),
            transcript_artifact_id: Some("transcript-1".into()),
            failure_class: Some(harness_observability::EvalFailureClass::AgentError),
            grader_results: vec![harness_observability::EvalGraderResult {
                id: "grader-1".into(),
                kind: harness_observability::EvalGraderKind::ToolCall,
                verdict: harness_observability::EvalGraderVerdict::Fail,
                score: Some(0.0),
                explanation: Some("missing expected tool call".into()),
                attributes: serde_json::json!({}),
                artifact_ids: Vec::new(),
            }],
            scores: serde_json::json!({"tool_sequence": 0.0}),
            attributes: serde_json::json!({}),
            artifact_ids: vec!["artifact-1".into()],
        };
        store.save_case_result(&result).await.unwrap();
        let rows = store
            .list_case_results(EvalFilter {
                suite: Some("coding-smoke".into()),
                ..EvalFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(rows, vec![result]);

        let regression_rows = store
            .list_case_results(EvalFilter {
                suite_kind: Some(harness_observability::EvalSuiteKind::Regression),
                ..EvalFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(regression_rows.len(), 1);
    }

    #[tokio::test]
    async fn channel_binding_persists_across_reopen() {
        let dir = tempdir().unwrap();
        {
            let store = JsonFileChannelBindingStore::open(dir.path()).unwrap();
            store
                .upsert(&ChannelBinding::new(
                    "wecom",
                    "g1",
                    "conv-1",
                    Some("u1".into()),
                    Some("Alice".into()),
                ))
                .await
                .unwrap();
            store
                .upsert(&ChannelBinding::new("feishu", "f1", "conv-1", None, None))
                .await
                .unwrap();
        }
        // Re-open: state must come back from disk.
        let store = JsonFileChannelBindingStore::open(dir.path()).unwrap();
        let got = store.lookup("wecom", "g1").await.unwrap().unwrap();
        assert_eq!(got.conversation_id, "conv-1");
        assert_eq!(got.display_name.as_deref(), Some("Alice"));

        // delete_for_conversation cleans both bindings + flushes.
        let n = store.delete_for_conversation("conv-1").await.unwrap();
        assert_eq!(n, 2);
        // And the on-disk file reflects it after re-open.
        let store2 = JsonFileChannelBindingStore::open(dir.path()).unwrap();
        assert!(store2.lookup("wecom", "g1").await.unwrap().is_none());
        assert!(store2.lookup("feishu", "f1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn channel_binding_upsert_overwrites_same_key() {
        let dir = tempdir().unwrap();
        let store = JsonFileChannelBindingStore::open(dir.path()).unwrap();
        store
            .upsert(&ChannelBinding::new("wecom", "g1", "conv-old", None, None))
            .await
            .unwrap();
        store
            .upsert(&ChannelBinding::new("wecom", "g1", "conv-new", None, None))
            .await
            .unwrap();
        let got = store.lookup("wecom", "g1").await.unwrap().unwrap();
        assert_eq!(got.conversation_id, "conv-new");
        // Only one row exists for the channel.
        let rows = store.list_for_channel("wecom").await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    // ---- SkillUsageStore (JSON-file) ------------------------------------

    #[tokio::test]
    async fn skill_usage_roundtrip_and_filter() {
        use harness_learning::{
            SkillScope, SkillSource, SkillUsageAction, SkillUsageEvent, SkillUsageFilter,
        };
        let dir = tempdir().unwrap();
        let store = JsonFileSkillUsageStore::open(dir.path()).unwrap();

        let mk = |name: &str, action: SkillUsageAction| SkillUsageEvent {
            id: String::new(),
            skill_name: name.into(),
            source: SkillSource::Bundled,
            action,
            scope: SkillScope::workspace("/ws"),
            conversation_id: Some("c1".into()),
            requirement_id: None,
            run_id: None,
            created_at: String::new(),
            attributes: serde_json::Value::Null,
        };

        // Stamping: empty id + created_at get filled in.
        let recorded = store.record_event(mk("rust", SkillUsageAction::Viewed)).await.unwrap();
        assert!(!recorded.id.is_empty());
        assert!(!recorded.created_at.is_empty());

        store.record_event(mk("rust", SkillUsageAction::Used)).await.unwrap();
        store.record_event(mk("python", SkillUsageAction::Used)).await.unwrap();

        // Reopen — events must survive.
        drop(store);
        let store = JsonFileSkillUsageStore::open(dir.path()).unwrap();
        let all = store.list_events(SkillUsageFilter::default()).await.unwrap();
        assert_eq!(all.len(), 3);
        // Newest-first.
        assert!(all[0].created_at >= all[1].created_at);

        // Filter by skill name.
        let only_rust = store
            .list_events(SkillUsageFilter {
                skill_name: Some("rust".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(only_rust.len(), 2);

        // Aggregate report.
        let rows = store.report(SkillUsageFilter::default()).await.unwrap();
        let rust_row = rows.iter().find(|r| r.skill_name == "rust").unwrap();
        assert_eq!(rust_row.view_count, 1);
        assert_eq!(rust_row.use_count, 1);
    }

    fn skill_events_file_count(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("events"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name.ends_with(".json") && !name.ends_with(".json.tmp")
            })
            .count()
    }

    #[tokio::test]
    async fn skill_usage_events_are_capped_when_max_set() {
        use harness_learning::{SkillScope, SkillSource, SkillUsageAction, SkillUsageEvent};
        let dir = tempdir().unwrap();
        // slack = max/10 = 0, so steady state is exactly `max`.
        let store = JsonFileSkillUsageStore::open(dir.path())
            .unwrap()
            .with_max_events(Some(5));
        for _ in 0..30 {
            store
                .record_event(SkillUsageEvent {
                    id: String::new(),
                    skill_name: "rust".into(),
                    source: SkillSource::Bundled,
                    action: SkillUsageAction::Used,
                    scope: SkillScope::workspace("/ws"),
                    conversation_id: None,
                    requirement_id: None,
                    run_id: None,
                    created_at: String::new(),
                    attributes: serde_json::Value::Null,
                })
                .await
                .unwrap();
        }
        assert_eq!(
            skill_events_file_count(dir.path()),
            5,
            "events/ must be bounded by the cap"
        );
    }

    #[tokio::test]
    async fn skill_usage_events_unbounded_when_max_none() {
        use harness_learning::{SkillScope, SkillSource, SkillUsageAction, SkillUsageEvent};
        let dir = tempdir().unwrap();
        let store = JsonFileSkillUsageStore::open(dir.path())
            .unwrap()
            .with_max_events(None);
        for _ in 0..12 {
            store
                .record_event(SkillUsageEvent {
                    id: String::new(),
                    skill_name: "rust".into(),
                    source: SkillSource::Bundled,
                    action: SkillUsageAction::Used,
                    scope: SkillScope::workspace("/ws"),
                    conversation_id: None,
                    requirement_id: None,
                    run_id: None,
                    created_at: String::new(),
                    attributes: serde_json::Value::Null,
                })
                .await
                .unwrap();
        }
        assert_eq!(
            skill_events_file_count(dir.path()),
            12,
            "None disables pruning"
        );
    }

    // ---- SkillUsageStore (in-memory) ------------------------------------

    #[tokio::test]
    async fn memory_skill_usage_filters_by_action() {
        use crate::memory::MemorySkillUsageStore;
        use harness_learning::{
            SkillScope, SkillSource, SkillUsageAction, SkillUsageEvent, SkillUsageFilter,
        };
        let store = MemorySkillUsageStore::new();
        let mk = |action| SkillUsageEvent {
            id: String::new(),
            skill_name: "k".into(),
            source: SkillSource::User,
            action,
            scope: SkillScope::user(),
            conversation_id: None,
            requirement_id: None,
            run_id: None,
            created_at: String::new(),
            attributes: serde_json::Value::Null,
        };
        store.record_event(mk(SkillUsageAction::Viewed)).await.unwrap();
        store.record_event(mk(SkillUsageAction::Used)).await.unwrap();
        let used = store
            .list_events(SkillUsageFilter {
                action: Some(SkillUsageAction::Used),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(used.len(), 1);
        assert_eq!(used[0].action, SkillUsageAction::Used);
    }

    // ---- MemoryStore (JSON-file) ----------------------------------------

    #[tokio::test]
    async fn memory_roundtrip_and_filter() {
        use harness_learning::{
            MemoryFilter, MemoryItem, MemoryKind, MemoryScope, MemoryStore,
        };
        let dir = tempdir().unwrap();
        let store = JsonFileMemoryStore::open(dir.path()).unwrap();

        let a = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Preference,
                "Be terse",
                "answer in ≤3 sentences unless asked",
            ))
            .await
            .unwrap();
        assert!(!a.id.is_empty());
        assert!(!a.created_at.is_empty());
        assert_eq!(a.updated_at, a.created_at);

        let b = store
            .upsert(
                MemoryItem::new(MemoryScope::user(), MemoryKind::Fact, "zh-CN", "reply in zh-CN")
                    .with_tag("lang"),
            )
            .await
            .unwrap();

        // Reopen — rows must survive.
        drop(store);
        let store = JsonFileMemoryStore::open(dir.path()).unwrap();
        let all = store.list(MemoryFilter::default()).await.unwrap();
        assert_eq!(all.len(), 2);

        // Get by id.
        let loaded = store.get(&a.id).await.unwrap().unwrap();
        assert_eq!(loaded.title, "Be terse");

        // Filter by tag.
        let lang_only = store
            .list(MemoryFilter {
                tags: vec!["lang".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(lang_only.len(), 1);
        assert_eq!(lang_only[0].id, b.id);

        // Delete is idempotent.
        assert!(store.delete(&a.id).await.unwrap());
        assert!(!store.delete(&a.id).await.unwrap());
        assert!(store.get(&a.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn memory_upsert_keeps_created_at_refreshes_updated_at() {
        use harness_learning::{
            MemoryFilter, MemoryItem, MemoryKind, MemoryScope, MemoryStore,
        };
        let dir = tempdir().unwrap();
        let store = JsonFileMemoryStore::open(dir.path()).unwrap();
        let mut item = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Fact,
                "t",
                "b",
            ))
            .await
            .unwrap();
        let original_created = item.created_at.clone();
        // Update the title, re-upsert.
        item.title = "t2".into();
        // Force the timestamp to move forward so updated_at strictly
        // differs even in a fast CI environment with low timer
        // resolution.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let updated = store.upsert(item).await.unwrap();
        assert_eq!(
            updated.created_at, original_created,
            "created_at must be preserved across upserts"
        );
        assert!(
            updated.updated_at >= original_created,
            "updated_at must be refreshed"
        );

        let _ = store.list(MemoryFilter::default()).await.unwrap();
    }

    #[tokio::test]
    async fn memory_upsert_prunes_oldest_non_pinned_over_cap() {
        use harness_learning::{
            MemoryFilter, MemoryItem, MemoryKind, MemoryScope, MemoryStore,
        };
        let dir = tempdir().unwrap();
        // Cap of 4: slack is max/10 == 0, so the prune fires once we
        // exceed 4 files.
        let store = JsonFileMemoryStore::open(dir.path())
            .unwrap()
            .with_max_items(Some(4));

        // One pinned row that must always survive the sweep.
        store
            .upsert(
                MemoryItem::new(MemoryScope::user(), MemoryKind::Preference, "pinned", "keep me")
                    .pinned(),
            )
            .await
            .unwrap();

        // Insert well past the cap; updated_at is monotonic per upsert
        // (RFC-3339), so the earliest writes are the prune victims.
        for i in 0..20 {
            store
                .upsert(MemoryItem::new(
                    MemoryScope::user(),
                    MemoryKind::Fact,
                    format!("row-{i}"),
                    "body",
                ))
                .await
                .unwrap();
            // Nudge the clock so updated_at strictly orders the rows.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        let all = store.list(MemoryFilter::default()).await.unwrap();
        assert!(
            all.len() <= 4,
            "row count stays bounded by the cap, got {}",
            all.len()
        );
        // Pinned row is never pruned.
        assert!(
            all.iter().any(|r| r.title == "pinned"),
            "pinned row must survive pruning"
        );
        // The newest non-pinned row survives; the oldest is gone.
        assert!(
            all.iter().any(|r| r.title == "row-19"),
            "newest row must be kept"
        );
        assert!(
            !all.iter().any(|r| r.title == "row-0"),
            "oldest row must be pruned"
        );
    }

    #[tokio::test]
    async fn memory_upsert_unbounded_when_cap_disabled() {
        use harness_learning::{
            MemoryFilter, MemoryItem, MemoryKind, MemoryScope, MemoryStore,
        };
        let dir = tempdir().unwrap();
        let store = JsonFileMemoryStore::open(dir.path())
            .unwrap()
            .with_max_items(None);
        for i in 0..12 {
            store
                .upsert(MemoryItem::new(
                    MemoryScope::user(),
                    MemoryKind::Fact,
                    format!("row-{i}"),
                    "body",
                ))
                .await
                .unwrap();
        }
        let all = store.list(MemoryFilter::default()).await.unwrap();
        assert_eq!(all.len(), 12, "None disables pruning");
    }

    // ---- MemoryStore (in-memory) ----------------------------------------

    // ---- SkillLifecycleStore (JSON-file) --------------------------------

    #[tokio::test]
    async fn skill_lifecycle_roundtrip_and_archive() {
        use harness_learning::{
            SkillCreator, SkillLifecycle, SkillLifecycleStore, SkillSource, SkillState,
        };
        let dir = tempdir().unwrap();
        let store = JsonFileSkillLifecycleStore::open(dir.path()).unwrap();

        let saved = store
            .upsert(SkillLifecycle::new(
                "rust-debugger",
                SkillSource::Workspace,
                SkillCreator::Agent,
            ))
            .await
            .unwrap();
        assert!(!saved.created_at.is_empty());
        assert_eq!(saved.state, SkillState::Active);

        // Archive it.
        let mut archived = saved.clone();
        archived.state = SkillState::Archived;
        archived.archived_at = Some("2026-05-29T00:00:00Z".into());
        archived.absorbed_into = Some("debugging-umbrella".into());
        store.upsert(archived).await.unwrap();

        // Reopen — survives + reflects the archive.
        drop(store);
        let store = JsonFileSkillLifecycleStore::open(dir.path()).unwrap();
        let got = store.get("rust-debugger").await.unwrap().unwrap();
        assert_eq!(got.state, SkillState::Archived);
        assert_eq!(got.absorbed_into.as_deref(), Some("debugging-umbrella"));
        assert_eq!(got.created_at, saved.created_at, "created_at preserved");

        let all = store.list().await.unwrap();
        assert_eq!(all.len(), 1);

        assert!(store.delete("rust-debugger").await.unwrap());
        assert!(!store.delete("rust-debugger").await.unwrap());
    }

    #[tokio::test]
    async fn memory_in_memory_list_sorts_pinned_first() {
        use crate::memory::MemoryMemoryStore;
        use harness_learning::{
            MemoryFilter, MemoryItem, MemoryKind, MemoryScope, MemoryStore,
        };
        let store = MemoryMemoryStore::new();
        let a = store
            .upsert(MemoryItem::new(
                MemoryScope::user(),
                MemoryKind::Fact,
                "unpinned",
                "b",
            ))
            .await
            .unwrap();
        let _b = store
            .upsert(
                MemoryItem::new(MemoryScope::user(), MemoryKind::Fact, "pinned", "b").pinned(),
            )
            .await
            .unwrap();
        let rows = store.list(MemoryFilter::default()).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].pinned, "pinned row sorts first");
        assert_eq!(rows[1].id, a.id);
    }
}
