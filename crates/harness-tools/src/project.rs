//! Persistent Project CRUD — `project.{list,get,create,update,archive,restore,delete}` tools.
//!
//! Surfaces the [`harness_core::ProjectStore`] API to the LLM. Mirrors
//! the REST endpoints in `harness-server::projects` but with typed
//! schemas instead of HTTP-shaped bodies. All write operations are
//! [`ToolCategory::Write`] and `requires_approval = true` so the
//! configured approver gates them — matches the user's "all data
//! changes via approval" policy.
//!
//! Tools are registered conditionally — `BuiltinsConfig::project_store
//! = Some(...)` enables them; without a store, registration is
//! skipped and the model cannot use `project.*` (the registry returns
//! "tool not found"). Same opt-in pattern as `todo_store`.
//!
//! Slug uniqueness is the store's responsibility; on collision we
//! surface the underlying error string verbatim. New projects without
//! an explicit `slug` get one derived from `name` via
//! [`harness_core::derive_slug`] — uniqueness is *not* guaranteed by
//! the deriver, so the model should `project.list` first or be ready
//! to retry with a disambiguating suffix.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    derive_slug, validate_slug, BoxError, Project, ProjectStore, Tool, ToolCategory,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_LIST_LIMIT: u32 = 50;
const MAX_LIST_LIMIT: u32 = 500;

fn project_to_json(p: &Project) -> Value {
    serde_json::to_value(p).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

async fn resolve_project(
    store: &Arc<dyn ProjectStore>,
    id_or_slug: &str,
) -> Result<Project, BoxError> {
    if let Some(p) = store.load(id_or_slug).await? {
        return Ok(p);
    }
    if let Some(p) = store.find_by_slug(id_or_slug).await? {
        return Ok(p);
    }
    Err(format!("project not found: `{id_or_slug}`").into())
}

// ---------- project.list ---------------------------------------------------

pub struct ProjectListTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectListTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectListTool {
    fn name(&self) -> &str {
        "project.list"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "List projects, newest-updated first. By default hides \
         archived projects; pass `include_archived: true` to see \
         them. Capped at 500 items per call."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "include_archived": {
                    "type": "boolean",
                    "description": "Include soft-deleted projects. Defaults to false."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIST_LIMIT,
                    "description": "Max rows to return. Defaults to 50."
                }
            }
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize, Default)]
        struct Args {
            #[serde(default)]
            include_archived: bool,
            #[serde(default)]
            limit: Option<u32>,
        }
        let parsed: Args = if args.is_null() {
            Args::default()
        } else {
            serde_json::from_value(args)
                .map_err(|e| -> BoxError { format!("project.list: bad args: {e}").into() })?
        };
        let limit = parsed
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .min(MAX_LIST_LIMIT);
        let items = self.store.list(parsed.include_archived, limit).await?;
        Ok(serde_json::to_string(&json!({
            "items": items,
            "count": items.len(),
        }))?)
    }
}

// ---------- project.get ----------------------------------------------------

pub struct ProjectGetTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectGetTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectGetTool {
    fn name(&self) -> &str {
        "project.get"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Get a single project by id (UUID) or slug."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id_or_slug": {
                    "type": "string",
                    "description": "Either the UUID id or the kebab-case slug."
                }
            },
            "required": ["id_or_slug"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id_or_slug: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("project.get: bad args: {e}").into() })?;
        let project = resolve_project(&self.store, &parsed.id_or_slug).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- project.create -------------------------------------------------

pub struct ProjectCreateTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectCreateTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectCreateTool {
    fn name(&self) -> &str {
        "project.create"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Create a new project. `slug` defaults to a kebab-case \
         derivation of `name` if omitted. Slugs are globally unique; \
         a collision returns an error and the project is not created. \
         Returns the created project."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Display name." },
                "description": { "type": "string", "description": "Optional one-liner." },
                "instructions": {
                    "type": "string",
                    "description": "Markdown body injected into system-prompt for conversations bound to this project. Defaults to empty."
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "slug": {
                    "type": "string",
                    "description": "Kebab-case `[a-z0-9-]{1,64}`. Auto-derived from `name` if omitted."
                }
            },
            "required": ["name"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            name: String,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            instructions: Option<String>,
            #[serde(default)]
            tags: Option<Vec<String>>,
            #[serde(default)]
            slug: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("project.create: bad args: {e}").into() })?;
        let name = parsed.name.trim().to_string();
        if name.is_empty() {
            return Err("project.create: `name` must not be blank".into());
        }
        let slug = parsed
            .slug
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| derive_slug(&name));
        validate_slug(&slug)
            .map_err(|e| -> BoxError { format!("project.create: invalid slug: {e}").into() })?;
        let mut project = Project::new(&name, parsed.instructions.unwrap_or_default());
        project.set_slug(slug);
        if let Some(d) = parsed.description {
            let trimmed = d.trim().to_string();
            if !trimmed.is_empty() {
                project.set_description(Some(trimmed));
            }
        }
        if let Some(tags) = parsed.tags {
            project.set_tags(tags);
        }
        self.store.save(&project).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- project.update -------------------------------------------------

pub struct ProjectUpdateTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectUpdateTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectUpdateTool {
    fn name(&self) -> &str {
        "project.update"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Update an existing project. Pass any subset of {name, \
         description, instructions, tags, slug} — omitted fields keep \
         their current value. To clear `description`, pass an empty \
         string. Returns the updated project."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id_or_slug": { "type": "string" },
                "name": { "type": "string" },
                "description": {
                    "type": "string",
                    "description": "Empty string clears the field."
                },
                "instructions": { "type": "string" },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "slug": {
                    "type": "string",
                    "description": "Renaming the slug breaks existing references. Use with care."
                }
            },
            "required": ["id_or_slug"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id_or_slug")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id_or_slug: String,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            instructions: Option<String>,
            #[serde(default)]
            tags: Option<Vec<String>>,
            #[serde(default)]
            slug: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("project.update: bad args: {e}").into() })?;
        let mut project = resolve_project(&self.store, &parsed.id_or_slug).await?;
        if let Some(n) = parsed.name {
            let trimmed = n.trim().to_string();
            if trimmed.is_empty() {
                return Err("project.update: `name` must not be blank".into());
            }
            project.set_name(trimmed);
        }
        if let Some(d) = parsed.description {
            let trimmed = d.trim().to_string();
            project.set_description(if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            });
        }
        if let Some(i) = parsed.instructions {
            project.set_instructions(i);
        }
        if let Some(tags) = parsed.tags {
            project.set_tags(tags);
        }
        if let Some(s) = parsed.slug {
            let trimmed = s.trim().to_string();
            validate_slug(&trimmed)
                .map_err(|e| -> BoxError { format!("project.update: invalid slug: {e}").into() })?;
            project.set_slug(trimmed);
        }
        self.store.save(&project).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- project.archive ------------------------------------------------

pub struct ProjectArchiveTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectArchiveTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectArchiveTool {
    fn name(&self) -> &str {
        "project.archive"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Soft-delete a project (sets `archived = true`). Bound \
         conversations keep working. Idempotent — archiving an \
         already-archived project succeeds. Use `project.restore` \
         to undo."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "UUID id of the project." }
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
            .map_err(|e| -> BoxError { format!("project.archive: bad args: {e}").into() })?;
        let archived = self.store.archive(&parsed.id).await?;
        Ok(json!({ "id": parsed.id, "archived": archived }).to_string())
    }
}

// ---------- project.restore ------------------------------------------------

pub struct ProjectRestoreTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectRestoreTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectRestoreTool {
    fn name(&self) -> &str {
        "project.restore"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Restore a soft-deleted project (clears `archived`). \
         Idempotent. Returns the restored project."
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
            .map_err(|e| -> BoxError { format!("project.restore: bad args: {e}").into() })?;
        let mut project = self
            .store
            .load(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("project.restore: id `{}` not found", parsed.id).into()
            })?;
        project.unarchive();
        self.store.save(&project).await?;
        Ok(project_to_json(&project).to_string())
    }
}

// ---------- project.delete -------------------------------------------------

pub struct ProjectDeleteTool {
    store: Arc<dyn ProjectStore>,
}

impl ProjectDeleteTool {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for ProjectDeleteTool {
    fn name(&self) -> &str {
        "project.delete"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Hard-delete a project. Irreversible — bound conversations \
         lose their project link. Prefer `project.archive` unless the \
         user explicitly asked to remove it permanently. Returns \
         `{deleted: bool}` indicating whether a row was removed."
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
            .map_err(|e| -> BoxError { format!("project.delete: bad args: {e}").into() })?;
        let deleted = self.store.delete(&parsed.id).await?;
        Ok(json!({ "id": parsed.id, "deleted": deleted }).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::sync::RwLock;

    /// Tiny in-memory `ProjectStore` for the tool unit tests. Mirrors
    /// the JSON-file backend's slug-uniqueness behaviour.
    struct TestStore {
        inner: RwLock<HashMap<String, Project>>,
    }
    impl TestStore {
        fn new() -> Self {
            Self {
                inner: RwLock::new(HashMap::new()),
            }
        }
    }
    #[async_trait]
    impl ProjectStore for TestStore {
        async fn save(&self, project: &Project) -> Result<(), BoxError> {
            let mut g = self.inner.write().await;
            // Reject duplicate slugs (matching by slug across rows whose id differs).
            if g.values().any(|p| p.slug == project.slug && p.id != project.id) {
                return Err(format!("slug `{}` already in use", project.slug).into());
            }
            g.insert(project.id.clone(), project.clone());
            Ok(())
        }
        async fn load(&self, id: &str) -> Result<Option<Project>, BoxError> {
            Ok(self.inner.read().await.get(id).cloned())
        }
        async fn find_by_slug(&self, slug: &str) -> Result<Option<Project>, BoxError> {
            Ok(self
                .inner
                .read()
                .await
                .values()
                .find(|p| p.slug == slug)
                .cloned())
        }
        async fn list(
            &self,
            include_archived: bool,
            limit: u32,
        ) -> Result<Vec<Project>, BoxError> {
            let mut rows: Vec<Project> = self
                .inner
                .read()
                .await
                .values()
                .filter(|p| include_archived || !p.archived)
                .cloned()
                .collect();
            rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            rows.truncate(limit as usize);
            Ok(rows)
        }
        async fn delete(&self, id: &str) -> Result<bool, BoxError> {
            Ok(self.inner.write().await.remove(id).is_some())
        }
        async fn archive(&self, id: &str) -> Result<bool, BoxError> {
            let mut g = self.inner.write().await;
            if let Some(p) = g.get_mut(id) {
                p.archive();
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }

    fn store() -> Arc<dyn ProjectStore> {
        Arc::new(TestStore::new())
    }

    #[tokio::test]
    async fn create_assigns_derived_slug_when_omitted() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let out = create
            .invoke(json!({ "name": "Customer Support" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["slug"], "customer-support");
        assert_eq!(v["name"], "Customer Support");
    }

    #[tokio::test]
    async fn create_rejects_duplicate_slug() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        create
            .invoke(json!({ "name": "x", "slug": "shared" }))
            .await
            .unwrap();
        let err = create
            .invoke(json!({ "name": "y", "slug": "shared" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already in use"));
    }

    #[tokio::test]
    async fn create_rejects_blank_name() {
        let s = store();
        let create = ProjectCreateTool::new(s);
        let err = create.invoke(json!({ "name": "   " })).await.unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[tokio::test]
    async fn list_hides_archived_by_default() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let archive = ProjectArchiveTool::new(s.clone());
        let list = ProjectListTool::new(s.clone());

        for name in &["alpha", "beta"] {
            create.invoke(json!({ "name": name })).await.unwrap();
        }
        let listed = list.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&listed).unwrap();
        let id = v["items"][0]["id"].as_str().unwrap().to_string();
        archive.invoke(json!({ "id": id })).await.unwrap();

        let after = list.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["count"], 1);

        let with_archived = list
            .invoke(json!({ "include_archived": true }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&with_archived).unwrap();
        assert_eq!(v["count"], 2);
    }

    #[tokio::test]
    async fn get_resolves_by_id_or_slug() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let get = ProjectGetTool::new(s.clone());
        let out = create
            .invoke(json!({ "name": "Demo X", "slug": "demo-x" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["id"].as_str().unwrap().to_string();

        let by_id = get
            .invoke(json!({ "id_or_slug": id }))
            .await
            .unwrap();
        assert!(by_id.contains("Demo X"));

        let by_slug = get
            .invoke(json!({ "id_or_slug": "demo-x" }))
            .await
            .unwrap();
        assert!(by_slug.contains("Demo X"));

        let missing = get
            .invoke(json!({ "id_or_slug": "ghost" }))
            .await
            .unwrap_err();
        assert!(missing.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn update_changes_only_provided_fields() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let update = ProjectUpdateTool::new(s.clone());
        let out = create
            .invoke(json!({
                "name": "old",
                "description": "keep me",
                "tags": ["a", "b"]
            }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let after = update
            .invoke(json!({ "id_or_slug": id, "name": "new" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["name"], "new");
        assert_eq!(v["description"], "keep me");
        assert_eq!(v["tags"][0], "a");
    }

    #[tokio::test]
    async fn update_clears_description_with_empty_string() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let update = ProjectUpdateTool::new(s.clone());
        let out = create
            .invoke(json!({ "name": "x", "description": "stale" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let after = update
            .invoke(json!({ "id_or_slug": id, "description": "" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert!(v.get("description").is_none() || v["description"].is_null());
    }

    #[tokio::test]
    async fn restore_unarchives() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let archive = ProjectArchiveTool::new(s.clone());
        let restore = ProjectRestoreTool::new(s.clone());
        let out = create.invoke(json!({ "name": "x" })).await.unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        archive.invoke(json!({ "id": &id })).await.unwrap();
        let after = restore.invoke(json!({ "id": &id })).await.unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["archived"], false);
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let s = store();
        let create = ProjectCreateTool::new(s.clone());
        let delete = ProjectDeleteTool::new(s.clone());
        let list = ProjectListTool::new(s.clone());
        let out = create.invoke(json!({ "name": "x" })).await.unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let res = delete.invoke(json!({ "id": &id })).await.unwrap();
        let v: Value = serde_json::from_str(&res).unwrap();
        assert_eq!(v["deleted"], true);

        let listed = list.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&listed).unwrap();
        assert_eq!(v["count"], 0);
    }

    #[test]
    fn write_tools_require_approval() {
        let s = store();
        assert!(ProjectCreateTool::new(s.clone()).requires_approval());
        assert!(ProjectUpdateTool::new(s.clone()).requires_approval());
        assert!(ProjectArchiveTool::new(s.clone()).requires_approval());
        assert!(ProjectRestoreTool::new(s.clone()).requires_approval());
        assert!(ProjectDeleteTool::new(s.clone()).requires_approval());
        assert!(!ProjectListTool::new(s.clone()).requires_approval());
        assert!(!ProjectGetTool::new(s).requires_approval());
    }
}
