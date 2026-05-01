//! Persistent project TODO board — `todo.{list,add,update,delete}` tools.
//!
//! These tools mutate a [`harness_core::TodoStore`] directly. Each
//! tool resolves the active workspace per-call via
//! [`harness_core::active_workspace_or`] and uses
//! [`harness_core::canonicalize_workspace`] to normalise it, so a
//! single agent process serving multiple WS sockets pinned to
//! different roots doesn't cross-contaminate.
//!
//! All four are [`ToolCategory::Read`] (no approval gate). TODOs
//! are metadata, not destructive disk/network ops; users wanting
//! stricter control can add a `RuleApprover` rule for `todo.*`.
//!
//! Mass-delete protection lives in the input schema:
//! `todo.delete` requires an explicit `ids` array (no `{all: true}`
//! / wildcard payload), capped at 50 ids per call.
//!
//! Tools are registered conditionally — `BuiltinsConfig::todo_store
//! = Some(...)` enables them; without a store, registration is
//! skipped and the model cannot use `todo.*` (the registry returns
//! "tool not found"). Falling back silently to in-memory storage
//! would defeat the persistence promise.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    active_workspace_or, canonicalize_workspace, BoxError, Tool, ToolCategory, TodoItem,
    TodoPriority, TodoStatus, TodoStore,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// Maximum ids accepted by a single `todo.delete` call. Models that
/// want to "clear everything" must enumerate ids — preventing a
/// stray `{all: true}` payload from nuking the backlog.
const MAX_DELETE_IDS_PER_CALL: usize = 50;

// ---------- helpers --------------------------------------------------------

fn resolve_workspace(default_root: &Path, override_path: Option<&str>) -> String {
    let path = match override_path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => active_workspace_or(default_root),
    };
    canonicalize_workspace(&path)
}

fn parse_status(s: &str) -> Result<TodoStatus, BoxError> {
    TodoStatus::from_wire(s).ok_or_else(|| -> BoxError {
        format!(
            "unknown status `{s}` — expected one of \
                 pending / in_progress / completed / cancelled / blocked"
        )
        .into()
    })
}

fn parse_priority(s: &str) -> Result<TodoPriority, BoxError> {
    TodoPriority::from_wire(s).ok_or_else(|| -> BoxError {
        format!("unknown priority `{s}` — expected low / medium / high").into()
    })
}

fn item_to_json(item: &TodoItem) -> Value {
    serde_json::to_value(item).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

// ---------- todo.list ------------------------------------------------------

pub struct TodoListTool {
    store: Arc<dyn TodoStore>,
    default_root: PathBuf,
}

impl TodoListTool {
    pub fn new(store: Arc<dyn TodoStore>, default_root: PathBuf) -> Self {
        Self {
            store,
            default_root,
        }
    }
}

#[async_trait]
impl Tool for TodoListTool {
    fn name(&self) -> &str {
        "todo.list"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "List persistent TODOs for the current workspace, newest \
         first. Capped at 500 items. Pass an explicit `workspace` \
         (absolute path) only if you need to query a different \
         workspace than the agent is pinned to. \
         Usually unnecessary on the first turn — pending / in_progress / blocked items \
         for the pinned workspace are already injected into the system prompt as a \
         `=== project todos ===` block. Call this when you need the full list \
         (including completed/cancelled), an item the binder may have just missed, \
         or a different workspace."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workspace": {
                    "type": "string",
                    "description": "Absolute path. Optional; defaults to the \
                                    agent's pinned workspace."
                }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize, Default)]
        struct Args {
            #[serde(default)]
            workspace: Option<String>,
        }
        let parsed: Args = if args.is_null() {
            Args::default()
        } else {
            serde_json::from_value(args)
                .map_err(|e| -> BoxError { format!("todo.list: bad args: {e}").into() })?
        };
        let workspace = resolve_workspace(&self.default_root, parsed.workspace.as_deref());
        let items = self.store.list(&workspace).await?;
        Ok(serde_json::to_string(&json!({
            "workspace": workspace,
            "items": items,
        }))?)
    }
}

// ---------- todo.add -------------------------------------------------------

pub struct TodoAddTool {
    store: Arc<dyn TodoStore>,
    default_root: PathBuf,
}

impl TodoAddTool {
    pub fn new(store: Arc<dyn TodoStore>, default_root: PathBuf) -> Self {
        Self {
            store,
            default_root,
        }
    }
}

#[async_trait]
impl Tool for TodoAddTool {
    fn name(&self) -> &str {
        "todo.add"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Append a new TODO to the current workspace's persistent \
         board. Returns the created item with a server-allocated \
         id. Use this to record persistent follow-ups that should \
         survive the current turn (cleanups, deferred refactors, \
         things the user asked you to remember). For ephemeral \
         in-turn planning — a checklist you want to render in the \
         UI for this single turn — use `plan.update` instead."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "One-sentence headline." },
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "completed", "cancelled", "blocked"],
                    "description": "Defaults to `pending`."
                },
                "priority": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "Optional priority hint; omit for unprioritised."
                },
                "notes": { "type": "string", "description": "Optional one-line note." },
                "workspace": {
                    "type": "string",
                    "description": "Optional absolute path; defaults to the agent's pinned workspace."
                }
            },
            "required": ["title"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            title: String,
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            priority: Option<String>,
            #[serde(default)]
            notes: Option<String>,
            #[serde(default)]
            workspace: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("todo.add: bad args: {e}").into() })?;
        let title = parsed.title.trim().to_string();
        if title.is_empty() {
            return Err("todo.add: `title` must not be blank".into());
        }
        let workspace = resolve_workspace(&self.default_root, parsed.workspace.as_deref());
        let mut item = TodoItem::new(workspace, title);
        if let Some(s) = parsed.status.as_deref() {
            item.status = parse_status(s)?;
        }
        if let Some(p) = parsed.priority.as_deref() {
            item.priority = Some(parse_priority(p)?);
        }
        item.notes = parsed.notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        harness_core::todo::count_mutation()?;
        self.store.upsert(&item).await?;
        Ok(item_to_json(&item).to_string())
    }
}

// ---------- todo.update ----------------------------------------------------

pub struct TodoUpdateTool {
    store: Arc<dyn TodoStore>,
}

impl TodoUpdateTool {
    pub fn new(store: Arc<dyn TodoStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for TodoUpdateTool {
    fn name(&self) -> &str {
        "todo.update"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Update a persistent TODO by id. Pass the `id` from the \
         `=== project todos ===` block in the system prompt or from \
         `todo.list`. Status transitions are: pending → in_progress → \
         completed (or blocked / cancelled at any point). Pass any \
         subset of {title, status, priority, notes} — omitted fields \
         keep their existing value. To clear `notes` or `priority`, \
         pass an empty string."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "status": {
                    "type": "string",
                    "enum": ["pending", "in_progress", "completed", "cancelled", "blocked"]
                },
                "priority": {
                    "type": "string",
                    "description": "low / medium / high, or empty string to clear.",
                    "enum": ["", "low", "medium", "high"]
                },
                "notes": { "type": "string" }
            },
            "required": ["id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            priority: Option<String>,
            #[serde(default)]
            notes: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("todo.update: bad args: {e}").into() })?;
        let mut item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("todo.update: id `{}` not found", parsed.id).into()
            })?;
        if let Some(t) = parsed.title {
            let trimmed = t.trim().to_string();
            if trimmed.is_empty() {
                return Err("todo.update: `title` must not be blank".into());
            }
            item.title = trimmed;
        }
        if let Some(s) = parsed.status.as_deref() {
            item.status = parse_status(s)?;
        }
        if let Some(p) = parsed.priority.as_deref() {
            // Empty string clears the priority.
            item.priority = if p.trim().is_empty() {
                None
            } else {
                Some(parse_priority(p.trim())?)
            };
        }
        if let Some(n) = parsed.notes {
            item.notes = if n.trim().is_empty() {
                None
            } else {
                Some(n.trim().to_string())
            };
        }
        item.touch();
        harness_core::todo::count_mutation()?;
        self.store.upsert(&item).await?;
        Ok(item_to_json(&item).to_string())
    }
}

// ---------- todo.delete ----------------------------------------------------

pub struct TodoDeleteTool {
    store: Arc<dyn TodoStore>,
}

impl TodoDeleteTool {
    pub fn new(store: Arc<dyn TodoStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for TodoDeleteTool {
    fn name(&self) -> &str {
        "todo.delete"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Delete one or more persistent TODOs by id. Up to 50 ids \
         per call (mass-delete protection). Returns the number of \
         rows actually removed (idempotent — already-absent ids \
         count as 0)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "maxItems": 50
                }
            },
            "required": ["ids"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            ids: Vec<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("todo.delete: bad args: {e}").into() })?;
        if parsed.ids.is_empty() {
            return Err("todo.delete: `ids` must not be empty".into());
        }
        if parsed.ids.len() > MAX_DELETE_IDS_PER_CALL {
            return Err(format!(
                "todo.delete: too many ids ({}) — cap is {} per call",
                parsed.ids.len(),
                MAX_DELETE_IDS_PER_CALL
            )
            .into());
        }
        let mut deleted = 0usize;
        for id in &parsed.ids {
            // Each row deletion counts toward the per-turn budget so a
            // single big-`ids`-array call can't sneak past the cap that
            // sequential `todo.add` / `todo.update` calls would hit.
            harness_core::todo::count_mutation()?;
            if self.store.delete(id).await? {
                deleted += 1;
            }
        }
        Ok(json!({ "deleted_count": deleted }).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Tiny in-memory `TodoStore` for the tool unit tests. We can't
    /// depend on `harness-store` from `harness-tools` (would create
    /// a cycle), so the impl lives inline.
    struct TestStore {
        inner: tokio::sync::RwLock<std::collections::HashMap<String, TodoItem>>,
        tx: tokio::sync::broadcast::Sender<harness_core::TodoEvent>,
    }
    impl TestStore {
        fn new() -> Self {
            let (tx, _) = tokio::sync::broadcast::channel(8);
            Self {
                inner: tokio::sync::RwLock::new(std::collections::HashMap::new()),
                tx,
            }
        }
    }
    #[async_trait]
    impl TodoStore for TestStore {
        async fn list(&self, workspace: &str) -> Result<Vec<TodoItem>, BoxError> {
            Ok(self
                .inner
                .read()
                .await
                .values()
                .filter(|t| t.workspace == workspace)
                .cloned()
                .collect())
        }
        async fn get(&self, id: &str) -> Result<Option<TodoItem>, BoxError> {
            Ok(self.inner.read().await.get(id).cloned())
        }
        async fn upsert(&self, item: &TodoItem) -> Result<(), BoxError> {
            self.inner.write().await.insert(item.id.clone(), item.clone());
            let _ = self.tx.send(harness_core::TodoEvent::Upserted(item.clone()));
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<bool, BoxError> {
            Ok(self.inner.write().await.remove(id).is_some())
        }
        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<harness_core::TodoEvent> {
            self.tx.subscribe()
        }
    }

    fn root() -> PathBuf {
        std::env::temp_dir()
    }

    #[tokio::test]
    async fn add_creates_item_with_default_status() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let tool = TodoAddTool::new(store.clone(), root());
        let out = tool
            .invoke(json!({ "title": "fix parser", "workspace": "/r" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "pending");
        assert_eq!(v["title"], "fix parser");
        assert!(v["id"].is_string());

        let listed = TodoListTool::new(store.clone(), root())
            .invoke(json!({ "workspace": "/r" }))
            .await
            .unwrap();
        let l: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(l["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn add_rejects_blank_title() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let tool = TodoAddTool::new(store, root());
        let err = tool
            .invoke(json!({ "title": "   ", "workspace": "/r" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[tokio::test]
    async fn update_changes_only_provided_fields() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let add = TodoAddTool::new(store.clone(), root());
        let out = add
            .invoke(json!({ "title": "x", "workspace": "/r", "notes": "first" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let upd = TodoUpdateTool::new(store);
        let after = upd
            .invoke(json!({ "id": id, "status": "completed" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["title"], "x");
        assert_eq!(v["notes"], "first");
    }

    #[tokio::test]
    async fn update_clears_notes_with_empty_string() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let add = TodoAddTool::new(store.clone(), root());
        let out = add
            .invoke(json!({ "title": "x", "workspace": "/r", "notes": "stale" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let upd = TodoUpdateTool::new(store);
        let after = upd
            .invoke(json!({ "id": id, "notes": "" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert!(v.get("notes").is_none() || v["notes"].is_null());
    }

    #[tokio::test]
    async fn update_unknown_id_errors() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let tool = TodoUpdateTool::new(store);
        let err = tool
            .invoke(json!({ "id": "no-such", "title": "y" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn delete_rejects_empty_ids() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let tool = TodoDeleteTool::new(store);
        let err = tool.invoke(json!({ "ids": [] })).await.unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[tokio::test]
    async fn delete_rejects_more_than_cap() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let tool = TodoDeleteTool::new(store);
        let many: Vec<String> = (0..MAX_DELETE_IDS_PER_CALL + 1)
            .map(|i| format!("id-{i}"))
            .collect();
        let err = tool.invoke(json!({ "ids": many })).await.unwrap_err();
        assert!(err.to_string().contains("too many"));
    }

    #[tokio::test]
    async fn delete_returns_count() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let add = TodoAddTool::new(store.clone(), root());
        let out = add
            .invoke(json!({ "title": "x", "workspace": "/r" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let del = TodoDeleteTool::new(store);
        let res = del
            .invoke(json!({ "ids": [id, "ghost"] }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["deleted_count"], 1);
    }

    /// The per-turn mutation budget kicks in once the agent loop has
    /// scoped `with_turn_budget`. Each `todo.add` consumes one slot;
    /// after the cap, further calls error out (and the model gets a
    /// readable error string).
    #[tokio::test]
    async fn add_respects_per_turn_budget() {
        use harness_core::todo::{with_turn_budget, MAX_MUTATIONS_PER_TURN};
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let add = TodoAddTool::new(store, root());
        with_turn_budget(async {
            // First MAX adds succeed.
            for i in 0..MAX_MUTATIONS_PER_TURN {
                add.invoke(json!({
                    "title": format!("step {i}"),
                    "workspace": "/r"
                }))
                .await
                .unwrap();
            }
            // The next one trips the cap.
            let err = add
                .invoke(json!({ "title": "one too many", "workspace": "/r" }))
                .await
                .unwrap_err();
            assert!(
                err.to_string().contains("per-turn mutation cap"),
                "expected cap message, got: {err}"
            );
        })
        .await;
    }

    /// Outside `with_turn_budget` scope (e.g. tool drives by REST or
    /// tests) the budget is a no-op so existing flows aren't broken.
    #[tokio::test]
    async fn add_outside_budget_scope_is_unbounded() {
        let store: Arc<dyn TodoStore> = Arc::new(TestStore::new());
        let add = TodoAddTool::new(store, root());
        // Far past the cap.
        for i in 0..(harness_core::todo::MAX_MUTATIONS_PER_TURN + 5) {
            add.invoke(json!({
                "title": format!("step {i}"),
                "workspace": "/r"
            }))
            .await
            .unwrap();
        }
    }
}
