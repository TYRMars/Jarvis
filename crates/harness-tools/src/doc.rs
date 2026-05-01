//! Persistent Doc CRUD — `doc.{list,get,create,update,delete}` and
//! `doc.draft.{get,save}` tools.
//!
//! Surfaces the [`harness_core::DocStore`] API to the LLM. Mirrors the
//! REST endpoints in `harness-server::docs_routes` but with typed
//! schemas and per-call workspace resolution. Drafts are append-only
//! by design — `doc.draft.save` always inserts a new revision; the UI
//! reads the most-recent one via [`DocStore::latest_draft`].
//!
//! All write operations are [`ToolCategory::Write`] and
//! `requires_approval = true` per the policy decided in the plan
//! (every data change goes through the approver).
//!
//! Workspace resolution mirrors `todo.*`: each tool that targets a
//! workspace resolves it via [`harness_core::active_workspace_or`] +
//! [`harness_core::canonicalize_workspace`], so a single agent
//! process serving multiple WS sockets pinned to different roots
//! never cross-contaminates.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    active_workspace_or, canonicalize_workspace, BoxError, DocDraft, DocKind, DocProject,
    DocStore, Tool, ToolCategory,
};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_DRAFT_BYTES: usize = 50 * 1024;

fn resolve_workspace(default_root: &Path, override_path: Option<&str>) -> String {
    let path = match override_path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => active_workspace_or(default_root),
    };
    canonicalize_workspace(&path)
}

fn parse_kind(s: &str) -> Result<DocKind, BoxError> {
    DocKind::from_wire(s).ok_or_else(|| -> BoxError {
        format!(
            "unknown kind `{s}` — expected one of \
             note / research / report / design / guide"
        )
        .into()
    })
}

fn project_to_json(p: &DocProject) -> Value {
    serde_json::to_value(p).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

fn draft_to_json(d: &DocDraft) -> Value {
    serde_json::to_value(d).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

// ---------- doc.list -------------------------------------------------------

pub struct DocListTool {
    store: Arc<dyn DocStore>,
    default_root: PathBuf,
}

impl DocListTool {
    pub fn new(store: Arc<dyn DocStore>, default_root: PathBuf) -> Self {
        Self {
            store,
            default_root,
        }
    }
}

#[async_trait]
impl Tool for DocListTool {
    fn name(&self) -> &str {
        "doc.list"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "List doc projects in the current workspace, newest-first. \
         Capped at 500 items. By default hides archived docs and \
         includes both pinned and unpinned. Pass `archived: true` to \
         see archived docs, or `pinned_only: true` to filter to pinned."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workspace": {
                    "type": "string",
                    "description": "Absolute path. Optional; defaults to the agent's pinned workspace."
                },
                "archived": {
                    "type": "boolean",
                    "description": "Include archived docs. Defaults to false."
                },
                "pinned_only": {
                    "type": "boolean",
                    "description": "Restrict to pinned docs. Defaults to false."
                }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize, Default)]
        struct Args {
            #[serde(default)]
            workspace: Option<String>,
            #[serde(default)]
            archived: bool,
            #[serde(default)]
            pinned_only: bool,
        }
        let parsed: Args = if args.is_null() {
            Args::default()
        } else {
            serde_json::from_value(args)
                .map_err(|e| -> BoxError { format!("doc.list: bad args: {e}").into() })?
        };
        let workspace = resolve_workspace(&self.default_root, parsed.workspace.as_deref());
        let mut items = self.store.list_projects(&workspace).await?;
        if !parsed.archived {
            items.retain(|p| !p.archived);
        }
        if parsed.pinned_only {
            items.retain(|p| p.pinned);
        }
        Ok(serde_json::to_string(&json!({
            "workspace": workspace,
            "items": items,
            "count": items.len(),
        }))?)
    }
}

// ---------- doc.get --------------------------------------------------------

pub struct DocGetTool {
    store: Arc<dyn DocStore>,
}

impl DocGetTool {
    pub fn new(store: Arc<dyn DocStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for DocGetTool {
    fn name(&self) -> &str {
        "doc.get"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Get a doc project by id. With `with_draft: true`, also \
         returns the most-recent draft (`null` if none). Use \
         `doc.draft.get` directly if you only need the body."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "with_draft": {
                    "type": "boolean",
                    "description": "Include the latest draft. Defaults to false."
                }
            },
            "required": ["id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            #[serde(default)]
            with_draft: bool,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.get: bad args: {e}").into() })?;
        let project = self
            .store
            .get_project(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError { format!("doc not found: `{}`", parsed.id).into() })?;
        let mut out = json!({ "project": project_to_json(&project) });
        if parsed.with_draft {
            let draft = self.store.latest_draft(&parsed.id).await?;
            out["draft"] = draft.as_ref().map(draft_to_json).unwrap_or(Value::Null);
        }
        Ok(out.to_string())
    }
}

// ---------- doc.create -----------------------------------------------------

pub struct DocCreateTool {
    store: Arc<dyn DocStore>,
    default_root: PathBuf,
}

impl DocCreateTool {
    pub fn new(store: Arc<dyn DocStore>, default_root: PathBuf) -> Self {
        Self {
            store,
            default_root,
        }
    }
}

#[async_trait]
impl Tool for DocCreateTool {
    fn name(&self) -> &str {
        "doc.create"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Create a new doc project (the metadata container). Use \
         `doc.draft.save` afterwards to write the actual body. \
         Returns the created project."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Display title." },
                "kind": {
                    "type": "string",
                    "enum": ["note", "research", "report", "design", "guide"],
                    "description": "Document type. Defaults to `note`."
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "pinned": { "type": "boolean", "description": "Defaults to false." },
                "workspace": {
                    "type": "string",
                    "description": "Absolute path. Optional; defaults to the agent's pinned workspace."
                }
            },
            "required": ["title"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("title")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            title: String,
            #[serde(default)]
            kind: Option<String>,
            #[serde(default)]
            tags: Option<Vec<String>>,
            #[serde(default)]
            pinned: bool,
            #[serde(default)]
            workspace: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.create: bad args: {e}").into() })?;
        let title = parsed.title.trim().to_string();
        if title.is_empty() {
            return Err("doc.create: `title` must not be blank".into());
        }
        let workspace = resolve_workspace(&self.default_root, parsed.workspace.as_deref());
        let mut project = DocProject::new(workspace, title);
        if let Some(k) = parsed.kind.as_deref() {
            project.kind = parse_kind(k)?;
        }
        if let Some(tags) = parsed.tags {
            project.tags = tags;
        }
        project.pinned = parsed.pinned;
        self.store.upsert_project(&project).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- doc.update -----------------------------------------------------

pub struct DocUpdateTool {
    store: Arc<dyn DocStore>,
}

impl DocUpdateTool {
    pub fn new(store: Arc<dyn DocStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for DocUpdateTool {
    fn name(&self) -> &str {
        "doc.update"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Update a doc project's metadata. Pass any subset of {title, \
         kind, tags, pinned, archived} — omitted fields keep their \
         current value. Returns the updated project."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "kind": {
                    "type": "string",
                    "enum": ["note", "research", "report", "design", "guide"]
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "pinned": { "type": "boolean" },
                "archived": { "type": "boolean" }
            },
            "required": ["id"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id").and_then(|v| v.as_str()).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            kind: Option<String>,
            #[serde(default)]
            tags: Option<Vec<String>>,
            #[serde(default)]
            pinned: Option<bool>,
            #[serde(default)]
            archived: Option<bool>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.update: bad args: {e}").into() })?;
        let mut project = self
            .store
            .get_project(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError { format!("doc not found: `{}`", parsed.id).into() })?;
        let mut changed = false;
        if let Some(t) = parsed.title {
            let trimmed = t.trim().to_string();
            if trimmed.is_empty() {
                return Err("doc.update: `title` must not be blank".into());
            }
            project.title = trimmed;
            changed = true;
        }
        if let Some(k) = parsed.kind.as_deref() {
            project.kind = parse_kind(k)?;
            changed = true;
        }
        if let Some(tags) = parsed.tags {
            project.tags = tags;
            changed = true;
        }
        if let Some(p) = parsed.pinned {
            project.pinned = p;
            changed = true;
        }
        if let Some(a) = parsed.archived {
            project.archived = a;
            changed = true;
        }
        if changed {
            project.touch();
        }
        self.store.upsert_project(&project).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- doc.delete -----------------------------------------------------

pub struct DocDeleteTool {
    store: Arc<dyn DocStore>,
}

impl DocDeleteTool {
    pub fn new(store: Arc<dyn DocStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for DocDeleteTool {
    fn name(&self) -> &str {
        "doc.delete"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Hard-delete a doc project AND every draft attached to it. \
         Irreversible. Prefer `doc.update { archived: true }` unless \
         the user explicitly asked to remove it permanently. Returns \
         `{deleted: bool}`."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" }
            },
            "required": ["id"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id").and_then(|v| v.as_str()).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.delete: bad args: {e}").into() })?;
        let deleted = self.store.delete_project(&parsed.id).await?;
        Ok(json!({ "id": parsed.id, "deleted": deleted }).to_string())
    }
}

// ---------- doc.draft.get --------------------------------------------------

pub struct DocDraftGetTool {
    store: Arc<dyn DocStore>,
}

impl DocDraftGetTool {
    pub fn new(store: Arc<dyn DocStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for DocDraftGetTool {
    fn name(&self) -> &str {
        "doc.draft.get"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Fetch the most-recent draft (markdown body) of a doc \
         project. Returns `null` if the project has no drafts yet."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" }
            },
            "required": ["project_id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            project_id: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.draft.get: bad args: {e}").into() })?;
        let draft = self.store.latest_draft(&parsed.project_id).await?;
        Ok(match draft {
            Some(d) => draft_to_json(&d).to_string(),
            None => "null".to_string(),
        })
    }
}

// ---------- doc.draft.save -------------------------------------------------

pub struct DocDraftSaveTool {
    store: Arc<dyn DocStore>,
}

impl DocDraftSaveTool {
    pub fn new(store: Arc<dyn DocStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for DocDraftSaveTool {
    fn name(&self) -> &str {
        "doc.draft.save"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Append a new draft (revision) to a doc project. Drafts are \
         versioned — this never overwrites an existing draft. The UI \
         shows the most-recent one. Body is capped at 50KB; split \
         longer content into multiple doc projects."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string" },
                "content": {
                    "type": "string",
                    "description": "Markdown body. Up to ~50KB."
                },
                "format": {
                    "type": "string",
                    "description": "Wire format. Defaults to `markdown` (the only supported value in v0)."
                }
            },
            "required": ["project_id", "content"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("project_id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            project_id: String,
            content: String,
            #[serde(default)]
            format: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("doc.draft.save: bad args: {e}").into() })?;
        if parsed.content.len() > MAX_DRAFT_BYTES {
            return Err(format!(
                "doc.draft.save: content too large ({} bytes) — cap is {} bytes",
                parsed.content.len(),
                MAX_DRAFT_BYTES
            )
            .into());
        }
        // Confirm the parent project exists; otherwise the orphan draft
        // would clutter the store and never be visible in the UI.
        if self.store.get_project(&parsed.project_id).await?.is_none() {
            return Err(format!(
                "doc.draft.save: project `{}` not found",
                parsed.project_id
            )
            .into());
        }
        let mut draft = DocDraft::new(parsed.project_id, parsed.content);
        if let Some(f) = parsed.format {
            let trimmed = f.trim().to_string();
            if !trimmed.is_empty() {
                draft.format = trimmed;
            }
        }
        self.store.upsert_draft(&draft).await?;
        Ok(draft_to_json(&draft).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::DocEvent;
    use std::collections::HashMap;
    use tokio::sync::{broadcast, RwLock};

    /// Tiny in-memory `DocStore` for the tool unit tests.
    struct TestStore {
        projects: RwLock<HashMap<String, DocProject>>,
        drafts: RwLock<HashMap<String, DocDraft>>,
        tx: broadcast::Sender<DocEvent>,
    }
    impl TestStore {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(8);
            Self {
                projects: RwLock::new(HashMap::new()),
                drafts: RwLock::new(HashMap::new()),
                tx,
            }
        }
    }
    #[async_trait]
    impl DocStore for TestStore {
        async fn list_projects(&self, workspace: &str) -> Result<Vec<DocProject>, BoxError> {
            let mut rows: Vec<DocProject> = self
                .projects
                .read()
                .await
                .values()
                .filter(|p| p.workspace == workspace)
                .cloned()
                .collect();
            rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(rows)
        }
        async fn get_project(&self, id: &str) -> Result<Option<DocProject>, BoxError> {
            Ok(self.projects.read().await.get(id).cloned())
        }
        async fn upsert_project(&self, project: &DocProject) -> Result<(), BoxError> {
            self.projects
                .write()
                .await
                .insert(project.id.clone(), project.clone());
            let _ = self.tx.send(DocEvent::ProjectUpserted(project.clone()));
            Ok(())
        }
        async fn delete_project(&self, id: &str) -> Result<bool, BoxError> {
            let project = self.projects.write().await.remove(id);
            if let Some(p) = project {
                self.drafts
                    .write()
                    .await
                    .retain(|_, d| d.project_id != id);
                let _ = self.tx.send(DocEvent::ProjectDeleted {
                    workspace: p.workspace,
                    id: id.to_string(),
                });
                Ok(true)
            } else {
                Ok(false)
            }
        }
        async fn list_drafts(&self, project_id: &str) -> Result<Vec<DocDraft>, BoxError> {
            let mut rows: Vec<DocDraft> = self
                .drafts
                .read()
                .await
                .values()
                .filter(|d| d.project_id == project_id)
                .cloned()
                .collect();
            rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(rows)
        }
        async fn upsert_draft(&self, draft: &DocDraft) -> Result<(), BoxError> {
            self.drafts
                .write()
                .await
                .insert(draft.id.clone(), draft.clone());
            let _ = self.tx.send(DocEvent::DraftUpserted(draft.clone()));
            Ok(())
        }
        fn subscribe(&self) -> broadcast::Receiver<DocEvent> {
            self.tx.subscribe()
        }
    }

    fn store() -> Arc<dyn DocStore> {
        Arc::new(TestStore::new())
    }

    fn root() -> PathBuf {
        std::env::temp_dir()
    }

    #[tokio::test]
    async fn create_assigns_default_kind_note() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let out = create
            .invoke(json!({ "title": "weekly review", "workspace": "/r" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["kind"], "note");
        assert_eq!(v["title"], "weekly review");
    }

    #[tokio::test]
    async fn create_rejects_blank_title() {
        let s = store();
        let create = DocCreateTool::new(s, root());
        let err = create
            .invoke(json!({ "title": "  ", "workspace": "/r" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[tokio::test]
    async fn create_rejects_unknown_kind() {
        let s = store();
        let create = DocCreateTool::new(s, root());
        let err = create
            .invoke(json!({ "title": "x", "kind": "blog", "workspace": "/r" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown kind"));
    }

    #[tokio::test]
    async fn list_isolates_by_workspace() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let list = DocListTool::new(s.clone(), root());
        create
            .invoke(json!({ "title": "alpha", "workspace": "/a" }))
            .await
            .unwrap();
        create
            .invoke(json!({ "title": "beta", "workspace": "/b" }))
            .await
            .unwrap();

        let a = list.invoke(json!({ "workspace": "/a" })).await.unwrap();
        let v: Value = serde_json::from_str(&a).unwrap();
        assert_eq!(v["count"], 1);
        assert_eq!(v["items"][0]["title"], "alpha");

        let b = list.invoke(json!({ "workspace": "/b" })).await.unwrap();
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["count"], 1);
    }

    #[tokio::test]
    async fn list_hides_archived_by_default() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let update = DocUpdateTool::new(s.clone());
        let list = DocListTool::new(s.clone(), root());
        let out = create
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        update
            .invoke(json!({ "id": id, "archived": true }))
            .await
            .unwrap();

        let listed = list.invoke(json!({ "workspace": "/r" })).await.unwrap();
        let v: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(v["count"], 0);

        let with_archived = list
            .invoke(json!({ "workspace": "/r", "archived": true }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&with_archived).unwrap();
        assert_eq!(v["count"], 1);
    }

    #[tokio::test]
    async fn draft_save_appends_new_revision() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let save = DocDraftSaveTool::new(s.clone());
        let get = DocDraftGetTool::new(s.clone());
        let out = create
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        save.invoke(json!({ "project_id": &id, "content": "v1" }))
            .await
            .unwrap();
        save.invoke(json!({ "project_id": &id, "content": "v2" }))
            .await
            .unwrap();

        let latest = get
            .invoke(json!({ "project_id": &id }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&latest).unwrap();
        assert_eq!(v["content"], "v2");

        let all = s.list_drafts(&id).await.unwrap();
        assert_eq!(all.len(), 2, "save must append, not overwrite");
    }

    #[tokio::test]
    async fn draft_save_rejects_orphan_project_id() {
        let s = store();
        let save = DocDraftSaveTool::new(s);
        let err = save
            .invoke(json!({ "project_id": "ghost", "content": "x" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn draft_save_rejects_oversize_body() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let save = DocDraftSaveTool::new(s.clone());
        let out = create
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let big = "a".repeat(MAX_DRAFT_BYTES + 1);
        let err = save
            .invoke(json!({ "project_id": &id, "content": big }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("too large"));
    }

    #[tokio::test]
    async fn delete_cascades_drafts() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let save = DocDraftSaveTool::new(s.clone());
        let delete = DocDeleteTool::new(s.clone());
        let out = create
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        save.invoke(json!({ "project_id": &id, "content": "v1" }))
            .await
            .unwrap();
        delete.invoke(json!({ "id": &id })).await.unwrap();

        assert!(s.get_project(&id).await.unwrap().is_none());
        assert!(s.list_drafts(&id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn get_with_draft_includes_latest() {
        let s = store();
        let create = DocCreateTool::new(s.clone(), root());
        let save = DocDraftSaveTool::new(s.clone());
        let get = DocGetTool::new(s.clone());
        let out = create
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        save.invoke(json!({ "project_id": &id, "content": "hello" }))
            .await
            .unwrap();

        let with_draft = get
            .invoke(json!({ "id": &id, "with_draft": true }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&with_draft).unwrap();
        assert_eq!(v["draft"]["content"], "hello");
        assert_eq!(v["project"]["title"], "x");

        let bare = get.invoke(json!({ "id": &id })).await.unwrap();
        let v: Value = serde_json::from_str(&bare).unwrap();
        assert!(v.get("draft").is_none());
    }

    #[test]
    fn write_tools_require_approval() {
        let s = store();
        let r = std::env::temp_dir();
        assert!(DocCreateTool::new(s.clone(), r.clone()).requires_approval());
        assert!(DocUpdateTool::new(s.clone()).requires_approval());
        assert!(DocDeleteTool::new(s.clone()).requires_approval());
        assert!(DocDraftSaveTool::new(s.clone()).requires_approval());
        assert!(!DocListTool::new(s.clone(), r).requires_approval());
        assert!(!DocGetTool::new(s.clone()).requires_approval());
        assert!(!DocDraftGetTool::new(s).requires_approval());
    }
}
