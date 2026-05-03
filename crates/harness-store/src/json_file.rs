//! On-disk JSON-file [`ConversationStore`](harness_core::ConversationStore)
//! and [`ProjectStore`](harness_core::ProjectStore).
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

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::Utc;
use harness_core::{
    Activity, ActivityEvent, ActivityStore, AgentProfile, AgentProfileEvent, AgentProfileStore,
    BoxError, Conversation, ConversationMetadata, ConversationRecord, ConversationStore, DocDraft,
    DocEvent, DocProject, DocStore, Message, Project, ProjectStore, Requirement, RequirementEvent,
    RequirementRun, RequirementRunEvent, RequirementRunStore, RequirementStore, TodoEvent,
    TodoItem, TodoStore,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

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
        };
        let meta = ConversationMetadata {
            project_id: stored.project_id,
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
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
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
        self.workspace_dir(workspace).join(format!("{}.json", encode_id(id)))
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
            tracing::warn!(workspace, count = rows.len(), "todo list exceeded 500-item soft cap");
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
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                let _ = self.tx.send(RequirementEvent::Deleted {
                    project_id: item.project_id,
                    id: item.id,
                });
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
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
                let _ = self.tx.send(AgentProfileEvent::Deleted { id: id.to_string() });
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
    async fn list_for_requirement(
        &self,
        requirement_id: &str,
    ) -> Result<Vec<Activity>, BoxError> {
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
            tracing::warn!(workspace, count = rows.len(), "doc project list exceeded 500-item soft cap");
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

// ---------- shared helpers -------------------------------------------------

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

    use harness_core::RequirementStatus;

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

    // ---- RequirementRunStore --------------------------------------------

    use harness_core::RequirementRunStatus;

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

    use harness_core::{ActivityActor, ActivityKind};
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
        p.kind = harness_core::DocKind::Report;
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
}
