//! Persistent Requirement CRUD — `requirement.{list,get,create,update,link_conversation}` tools.
//!
//! Surfaces the [`harness_core::RequirementStore`] API to the LLM. Mirrors
//! the REST endpoints in `harness-server::requirements_routes` but with
//! typed schemas instead of HTTP-shaped bodies. Read tools are
//! always-on / no-approval; write tools are [`ToolCategory::Write`] and
//! `requires_approval = true` so the configured approver gates them.
//!
//! Tools are registered conditionally — `BuiltinsConfig::requirement_store
//! = Some(...)` enables them; without a store, registration is skipped
//! and the model cannot use `requirement.*`. Same opt-in pattern as
//! `todo_store` / `project_store`.
//!
//! These tools are the per-Project counterparts of `project.*`. They
//! also unblock the `roadmap.import` flow: once the agent has imported
//! a workspace's roadmap as Requirements, it uses `requirement.list` to
//! answer "what's still pending?" and `requirement.update` to walk the
//! kanban as it ships.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    BoxError, Requirement, RequirementStatus, RequirementStore, Tool, ToolCategory,
};
use serde::Deserialize;
use serde_json::{json, Value};

fn requirement_to_json(r: &Requirement) -> Value {
    serde_json::to_value(r).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

fn parse_status(s: &str) -> Result<RequirementStatus, BoxError> {
    RequirementStatus::from_wire(s).ok_or_else(|| -> BoxError {
        format!(
            "unknown status `{s}`; expected one of backlog / in_progress / review / done"
        )
        .into()
    })
}

// ---------- requirement.list -----------------------------------------------

pub struct RequirementListTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementListTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementListTool {
    fn name(&self) -> &str {
        "requirement.list"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "List Requirements (kanban rows) under a Project, newest-updated \
         first. Use this to answer 'what's still pending?' — group the \
         result by `status` (backlog / in_progress / review / done). \
         Pair with `project.get` to first resolve a project slug to its \
         id; pair with `roadmap.import` to bootstrap a roadmap project \
         from `docs/proposals/`."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Project id (UUID). Use project.get to resolve a slug first."
                }
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
            .map_err(|e| -> BoxError { format!("requirement.list: bad args: {e}").into() })?;
        let items = self.store.list(&parsed.project_id).await?;
        let counts = items.iter().fold(
            (0u32, 0u32, 0u32, 0u32),
            |acc, r| match r.status {
                RequirementStatus::Backlog => (acc.0 + 1, acc.1, acc.2, acc.3),
                RequirementStatus::InProgress => (acc.0, acc.1 + 1, acc.2, acc.3),
                RequirementStatus::Review => (acc.0, acc.1, acc.2 + 1, acc.3),
                RequirementStatus::Done => (acc.0, acc.1, acc.2, acc.3 + 1),
            },
        );
        Ok(serde_json::to_string(&json!({
            "items": items,
            "count": items.len(),
            "by_status": {
                "backlog": counts.0,
                "in_progress": counts.1,
                "review": counts.2,
                "done": counts.3,
            }
        }))?)
    }
}

// ---------- requirement.get ------------------------------------------------

pub struct RequirementGetTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementGetTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementGetTool {
    fn name(&self) -> &str {
        "requirement.get"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Get a single Requirement by id. Returns the full row (title, \
         description, status, conversation_ids, …)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement id (UUID)." }
            },
            "required": ["id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.get: bad args: {e}").into() })?;
        match self.store.get(&parsed.id).await? {
            Some(r) => Ok(requirement_to_json(&r).to_string()),
            None => Err(format!("requirement not found: `{}`", parsed.id).into()),
        }
    }
}

// ---------- requirement.create ---------------------------------------------

pub struct RequirementCreateTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementCreateTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementCreateTool {
    fn name(&self) -> &str {
        "requirement.create"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Create a new Requirement under a Project. `status` defaults to \
         `backlog`. Use this to add a new kanban row (e.g. when the \
         user describes a new feature in chat)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Project id (UUID) the new Requirement belongs to."
                },
                "title": {
                    "type": "string",
                    "description": "One-sentence headline."
                },
                "description": {
                    "type": "string",
                    "description": "Optional longer body (markdown)."
                },
                "status": {
                    "type": "string",
                    "enum": ["backlog", "in_progress", "review", "done"],
                    "description": "Kanban column. Defaults to `backlog`."
                }
            },
            "required": ["project_id", "title"]
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
            project_id: String,
            title: String,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            status: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.create: bad args: {e}").into() })?;
        let title = parsed.title.trim().to_string();
        if title.is_empty() {
            return Err("requirement.create: `title` must not be blank".into());
        }
        let mut req = Requirement::new(&parsed.project_id, title);
        if let Some(d) = parsed.description {
            let t = d.trim().to_string();
            if !t.is_empty() {
                req.description = Some(t);
            }
        }
        if let Some(s) = parsed.status {
            req.status = parse_status(&s)?;
        }
        self.store.upsert(&req).await?;
        Ok(requirement_to_json(&req).to_string())
    }
}

// ---------- requirement.update ---------------------------------------------

pub struct RequirementUpdateTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementUpdateTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementUpdateTool {
    fn name(&self) -> &str {
        "requirement.update"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Update a Requirement's title / description / status. Only the \
         supplied fields change; omit a field to leave it untouched. \
         Use this to walk a Requirement across the kanban as you ship \
         (`backlog` → `in_progress` → `review` → `done`)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement id (UUID)." },
                "title": { "type": "string", "description": "New headline." },
                "description": {
                    "type": ["string", "null"],
                    "description": "New body. Pass `null` to clear."
                },
                "status": {
                    "type": "string",
                    "enum": ["backlog", "in_progress", "review", "done"]
                }
            },
            "required": ["id"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        let id = args.get("id").and_then(|v| v.as_str())?;
        let status = args
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| format!(" → status={s}"))
            .unwrap_or_default();
        Some(format!("{id}{status}"))
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default, deserialize_with = "deserialize_some")]
            description: Option<Option<String>>,
            #[serde(default)]
            status: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.update: bad args: {e}").into() })?;
        let mut req = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement not found: `{}`", parsed.id).into()
            })?;
        let mut changed = false;
        if let Some(t) = parsed.title {
            let trimmed = t.trim().to_string();
            if trimmed.is_empty() {
                return Err("requirement.update: `title` must not be blank".into());
            }
            if req.title != trimmed {
                req.title = trimmed;
                changed = true;
            }
        }
        if let Some(maybe_desc) = parsed.description {
            let normalised = maybe_desc.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            if req.description != normalised {
                req.description = normalised;
                changed = true;
            }
        }
        if let Some(s) = parsed.status {
            let st = parse_status(&s)?;
            if req.status != st {
                req.status = st;
                changed = true;
            }
        }
        if changed {
            req.touch();
            self.store.upsert(&req).await?;
        }
        Ok(requirement_to_json(&req).to_string())
    }
}

// ---------- requirement.link_conversation ----------------------------------

pub struct RequirementLinkConversationTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementLinkConversationTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementLinkConversationTool {
    fn name(&self) -> &str {
        "requirement.link_conversation"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Append a conversation id to a Requirement's `conversation_ids` \
         (the list of 'runs' linked to this requirement). Idempotent: a \
         second call with the same conversation_id is a no-op."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement id (UUID)." },
                "conversation_id": {
                    "type": "string",
                    "description": "Conversation id to link. Must already exist in the conversation store."
                }
            },
            "required": ["id", "conversation_id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            conversation_id: String,
        }
        let parsed: Args = serde_json::from_value(args).map_err(|e| -> BoxError {
            format!("requirement.link_conversation: bad args: {e}").into()
        })?;
        let mut req = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement not found: `{}`", parsed.id).into()
            })?;
        let added = req.link_conversation(&parsed.conversation_id);
        if added {
            self.store.upsert(&req).await?;
        }
        Ok(serde_json::to_string(&json!({
            "requirement": requirement_to_json(&req),
            "added": added,
        }))?)
    }
}

/// `serde` helper: distinguish "field absent" from "field present and null".
/// Used by `requirement.update.description` so callers can clear the
/// description by passing `null` (vs leaving it untouched by omitting).
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_store::MemoryRequirementStore;

    fn make_store() -> Arc<dyn RequirementStore> {
        Arc::new(MemoryRequirementStore::new())
    }

    async fn seed(store: &Arc<dyn RequirementStore>, project_id: &str, title: &str) -> Requirement {
        let req = Requirement::new(project_id, title);
        store.upsert(&req).await.unwrap();
        req
    }

    #[tokio::test]
    async fn list_groups_by_status() {
        let store = make_store();
        let p = "proj-1";
        seed(&store, p, "a").await;
        let mut b = seed(&store, p, "b").await;
        b.status = RequirementStatus::Done;
        store.upsert(&b).await.unwrap();

        let tool = RequirementListTool::new(store);
        let out: Value = serde_json::from_str(
            &tool
                .invoke(json!({ "project_id": p }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out["count"], 2);
        assert_eq!(out["by_status"]["done"], 1);
        assert_eq!(out["by_status"]["backlog"], 1);
    }

    #[tokio::test]
    async fn get_returns_row_or_errors() {
        let store = make_store();
        let req = seed(&store, "p", "title").await;
        let tool = RequirementGetTool::new(store);
        let out: Value =
            serde_json::from_str(&tool.invoke(json!({ "id": req.id })).await.unwrap()).unwrap();
        assert_eq!(out["title"], "title");
        let err = tool
            .invoke(json!({ "id": "00000000-0000-0000-0000-000000000000" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn create_inserts_with_status_default() {
        let store = make_store();
        let tool = RequirementCreateTool::new(store.clone());
        let out: Value = serde_json::from_str(
            &tool
                .invoke(json!({
                    "project_id": "p1",
                    "title": "ship the kanban"
                }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out["status"], "backlog");
        assert_eq!(out["title"], "ship the kanban");
        assert_eq!(store.list("p1").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_rejects_blank_title() {
        let tool = RequirementCreateTool::new(make_store());
        let err = tool
            .invoke(json!({ "project_id": "p", "title": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("must not be blank"));
    }

    #[tokio::test]
    async fn create_rejects_unknown_status() {
        let tool = RequirementCreateTool::new(make_store());
        let err = tool
            .invoke(json!({
                "project_id": "p",
                "title": "x",
                "status": "frozen"
            }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown status"));
    }

    #[tokio::test]
    async fn update_changes_only_supplied_fields() {
        let store = make_store();
        let req = seed(&store, "p", "old title").await;
        let tool = RequirementUpdateTool::new(store.clone());
        let out: Value = serde_json::from_str(
            &tool
                .invoke(json!({
                    "id": req.id,
                    "status": "in_progress"
                }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out["status"], "in_progress");
        assert_eq!(out["title"], "old title");
        let stored = store.get(&req.id).await.unwrap().unwrap();
        assert_eq!(stored.status, RequirementStatus::InProgress);
    }

    #[tokio::test]
    async fn update_can_clear_description_with_null() {
        let store = make_store();
        let mut req = seed(&store, "p", "x").await;
        req.description = Some("body".into());
        store.upsert(&req).await.unwrap();
        let tool = RequirementUpdateTool::new(store.clone());
        tool.invoke(json!({ "id": req.id, "description": null }))
            .await
            .unwrap();
        let stored = store.get(&req.id).await.unwrap().unwrap();
        assert!(stored.description.is_none());
    }

    #[tokio::test]
    async fn link_conversation_idempotent() {
        let store = make_store();
        let req = seed(&store, "p", "x").await;
        let tool = RequirementLinkConversationTool::new(store.clone());
        let out1: Value = serde_json::from_str(
            &tool
                .invoke(json!({ "id": req.id, "conversation_id": "c1" }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out1["added"], true);
        let out2: Value = serde_json::from_str(
            &tool
                .invoke(json!({ "id": req.id, "conversation_id": "c1" }))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(out2["added"], false);
        let stored = store.get(&req.id).await.unwrap().unwrap();
        assert_eq!(stored.conversation_ids, vec!["c1".to_string()]);
    }
}
