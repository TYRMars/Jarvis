//! `learning.memory.*` tools — row-based long-term Memory CRUD.
//!
//! Phase 1 of `docs/proposals/self-improving-agent.zh-CN.md`. Distinct from
//! the M3.1 `memory.*` tools in [`crate::memory`], which operate on
//! workspace / user `MEMORY.md` files. This family operates on the
//! row-based [`MemoryItem`] in [`harness_learning::MemoryStore`].
//!
//! Both surfaces can coexist:
//!
//! - `memory.list/read/write/delete` — markdown notes the agent maintains
//!   as part of its current-workspace context.
//! - `learning.memory.list/add/update/delete` — pinnable, scoped facts
//!   ("the user prefers terse answers") that survive across workspaces and
//!   feed into the next turn's prompt-context block.
//!
//! Phase 1 ships **only the user scope** through the tool surface. The
//! type allows Project / Workspace so we can move the existing
//! [`harness_project::ProjectMemory`] surface onto the same trait in a
//! later phase without a wire migration.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use harness_learning::{
    MemoryFilter, MemoryItem, MemoryKind, MemoryPatch, MemoryScope, MemorySource, MemoryStore,
};
use serde_json::{json, Value};

/// `learning.memory.list` — read user memories.
pub struct LearningMemoryListTool {
    store: Arc<dyn MemoryStore>,
}

impl LearningMemoryListTool {
    pub fn new(store: Arc<dyn MemoryStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for LearningMemoryListTool {
    fn name(&self) -> &str {
        "learning.memory.list"
    }

    fn description(&self) -> &str {
        "List the user's long-term memory rows (preferences, facts, conventions). \
         Phase 1 surface — only user-scope rows are returned. Filter by `kind` \
         (preference/fact/lesson/gotcha/convention), `tags` (all-match), or `pinned`. \
         Default limit 50; cap 200."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["preference", "fact", "lesson", "gotcha", "convention"],
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "All listed tags must be present on the row.",
                },
                "pinned": { "type": "boolean" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            },
        })
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let mut filter = MemoryFilter {
            scope: Some(MemoryScope::User),
            ..Default::default()
        };
        if let Some(kind) = args.get("kind") {
            filter.kind = serde_json::from_value(kind.clone())
                .map_err(|e| -> BoxError { format!("invalid kind: {e}").into() })?;
        }
        if let Some(tags) = args.get("tags").and_then(Value::as_array) {
            filter.tags = tags
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
        }
        if let Some(pinned) = args.get("pinned").and_then(Value::as_bool) {
            filter.pinned = Some(pinned);
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(50)
            .min(200) as u32;
        filter.limit = Some(limit);
        let rows = self.store.list(filter).await?;
        Ok(serde_json::to_string_pretty(&json!({"items": rows}))?)
    }
}

/// `learning.memory.add` — append a new user memory row.
pub struct LearningMemoryAddTool {
    store: Arc<dyn MemoryStore>,
}

impl LearningMemoryAddTool {
    pub fn new(store: Arc<dyn MemoryStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for LearningMemoryAddTool {
    fn name(&self) -> &str {
        "learning.memory.add"
    }

    fn description(&self) -> &str {
        "Persist a new long-term user memory row (e.g. \"user prefers zh-CN replies\"). \
         Title is required and ≤200 chars; body is required and ≤2 KiB. Use \
         `kind` to categorise (preference / fact / lesson / gotcha / convention). \
         Set `pinned: true` to prevent the future Curator from auto-archiving it."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "body": { "type": "string" },
                "kind": {
                    "type": "string",
                    "enum": ["preference", "fact", "lesson", "gotcha", "convention"],
                    "default": "preference",
                },
                "tags": {
                    "type": "array",
                    "items": { "type": "string" },
                },
                "pinned": { "type": "boolean", "default": false },
                "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
            },
            "required": ["title", "body"],
        })
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `title`".into() })?;
        if title.trim().is_empty() {
            return Err("`title` must be non-empty".into());
        }
        let body = args
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `body`".into() })?;
        if body.trim().is_empty() {
            return Err("`body` must be non-empty".into());
        }
        let kind: MemoryKind = match args.get("kind") {
            Some(v) => serde_json::from_value(v.clone())
                .map_err(|e| -> BoxError { format!("invalid kind: {e}").into() })?,
            None => MemoryKind::Preference,
        };
        let mut item = MemoryItem::new(MemoryScope::User, kind, title, body)
            // Tool calls are always agent-originated. Reviewer fork will
            // set `MemorySource::Run { run_id }` later.
            .with_source(MemorySource::Agent);
        if let Some(tags) = args.get("tags").and_then(Value::as_array) {
            item.tags = tags
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
        }
        if args.get("pinned").and_then(Value::as_bool).unwrap_or(false) {
            item.pinned = true;
        }
        if let Some(c) = args.get("confidence").and_then(Value::as_f64) {
            item.confidence = (c as f32).clamp(0.0, 1.0);
        }
        let saved = self.store.upsert(item).await?;
        Ok(serde_json::to_string_pretty(&json!({"item": saved}))?)
    }
}

/// `learning.memory.update` — patch an existing user memory row.
pub struct LearningMemoryUpdateTool {
    store: Arc<dyn MemoryStore>,
}

impl LearningMemoryUpdateTool {
    pub fn new(store: Arc<dyn MemoryStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for LearningMemoryUpdateTool {
    fn name(&self) -> &str {
        "learning.memory.update"
    }

    fn description(&self) -> &str {
        "Patch fields on an existing user memory row by id. Unspecified fields \
         are left as-is. Use this to refine a long-term memory rather than \
         appending a near-duplicate."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "body": { "type": "string" },
                "kind": {
                    "type": "string",
                    "enum": ["preference", "fact", "lesson", "gotcha", "convention"],
                },
                "tags": { "type": "array", "items": { "type": "string" } },
                "pinned": { "type": "boolean" },
                "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
            },
            "required": ["id"],
        })
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `id`".into() })?;
        // Reject an explicit empty `title` / `body` up front so the
        // caller gets a precise message; the store's atomic `patch` also
        // re-validates (covering the patched-result case) but its error
        // is generic. Mirrors the non-empty guards on `add`.
        if let Some("") = args.get("title").and_then(Value::as_str).map(str::trim) {
            return Err("`title` must be non-empty".into());
        }
        if let Some("") = args.get("body").and_then(Value::as_str).map(str::trim) {
            return Err("`body` must be non-empty".into());
        }
        let patch = MemoryPatch {
            title: args.get("title").and_then(Value::as_str).map(String::from),
            body: args.get("body").and_then(Value::as_str).map(String::from),
            kind: match args.get("kind") {
                Some(v) if !v.is_null() => Some(
                    serde_json::from_value(v.clone())
                        .map_err(|e| -> BoxError { format!("invalid kind: {e}").into() })?,
                ),
                _ => None,
            },
            tags: args.get("tags").and_then(Value::as_array).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            }),
            pinned: args.get("pinned").and_then(Value::as_bool),
            confidence: args
                .get("confidence")
                .and_then(Value::as_f64)
                .map(|c| c as f32),
            last_used_at: None,
        };
        // Atomic read-modify-write in the store: this serialises against
        // concurrent updates (no lost patch) and against `delete` — a row
        // removed mid-flight yields `None` rather than being resurrected.
        let saved = self
            .store
            .patch(id, patch)
            .await?
            .ok_or_else(|| -> BoxError { format!("no memory with id `{id}`").into() })?;
        Ok(serde_json::to_string_pretty(&json!({"item": saved}))?)
    }
}

/// `learning.memory.delete` — remove a user memory row. Approval-gated
/// because the spec calls this out explicitly: "memory.delete | write |
/// 需权限策略".
pub struct LearningMemoryDeleteTool {
    store: Arc<dyn MemoryStore>,
}

impl LearningMemoryDeleteTool {
    pub fn new(store: Arc<dyn MemoryStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for LearningMemoryDeleteTool {
    fn name(&self) -> &str {
        "learning.memory.delete"
    }

    fn description(&self) -> &str {
        "Delete a long-term user memory row by id. Returns `{deleted: bool}` — \
         deletion is idempotent (`false` when no such id). Approval-gated."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"],
        })
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `id`".into() })?;
        let deleted = self.store.delete(id).await?;
        Ok(serde_json::to_string_pretty(&json!({"deleted": deleted}))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_store::MemoryMemoryStore;

    fn store() -> Arc<dyn MemoryStore> {
        Arc::new(MemoryMemoryStore::new())
    }

    #[tokio::test]
    async fn add_then_list_then_delete_roundtrip() {
        let store = store();
        let add = LearningMemoryAddTool::new(store.clone());
        let list = LearningMemoryListTool::new(store.clone());
        let del = LearningMemoryDeleteTool::new(store.clone());

        let out = add
            .invoke(json!({
                "title": "Be terse",
                "body": "answer in ≤3 sentences",
                "kind": "preference",
                "tags": ["style"],
                "pinned": true,
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["item"]["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());
        assert_eq!(v["item"]["source"]["kind"], "agent", "tools write agent-source rows");
        assert_eq!(v["item"]["pinned"], true);

        let out = list.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), 1);

        // Filter by pinned=false → empty
        let out = list.invoke(json!({"pinned": false})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), 0);

        // Delete idempotency
        let out = del.invoke(json!({"id": id})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["deleted"], true);
        let out = del.invoke(json!({"id": id})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["deleted"], false);
    }

    #[tokio::test]
    async fn update_patches_title_and_pin() {
        let store = store();
        let add = LearningMemoryAddTool::new(store.clone());
        let upd = LearningMemoryUpdateTool::new(store.clone());

        let out = add
            .invoke(json!({"title": "old", "body": "b", "kind": "fact"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["item"]["id"].as_str().unwrap().to_string();

        let out = upd
            .invoke(json!({"id": id, "title": "new", "pinned": true}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["item"]["title"], "new");
        assert_eq!(v["item"]["pinned"], true);
        // unchanged
        assert_eq!(v["item"]["body"], "b");
        assert_eq!(v["item"]["kind"], "fact");
    }

    #[tokio::test]
    async fn add_rejects_empty_title() {
        let store = store();
        let add = LearningMemoryAddTool::new(store);
        let err = add
            .invoke(json!({"title": "   ", "body": "b"}))
            .await
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("title"));
    }

    #[tokio::test]
    async fn update_rejects_empty_body() {
        let store = store();
        let add = LearningMemoryAddTool::new(store.clone());
        let upd = LearningMemoryUpdateTool::new(store.clone());

        let out = add
            .invoke(json!({"title": "t", "body": "b"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["item"]["id"].as_str().unwrap().to_string();

        let err = upd
            .invoke(json!({"id": id, "body": "   "}))
            .await
            .unwrap_err();
        assert!(err.to_string().to_lowercase().contains("body"));
    }

    #[tokio::test]
    async fn update_loses_to_concurrent_delete() {
        // A row deleted between the agent reading it and patching it must
        // NOT be resurrected — `update` reports the id is gone and the
        // store stays empty.
        let store = store();
        let add = LearningMemoryAddTool::new(store.clone());
        let upd = LearningMemoryUpdateTool::new(store.clone());
        let del = LearningMemoryDeleteTool::new(store.clone());
        let list = LearningMemoryListTool::new(store.clone());

        let out = add
            .invoke(json!({"title": "t", "body": "b"}))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["item"]["id"].as_str().unwrap().to_string();

        assert_eq!(
            serde_json::from_str::<Value>(&del.invoke(json!({"id": id})).await.unwrap()).unwrap()
                ["deleted"],
            true
        );

        let err = upd
            .invoke(json!({"id": id, "title": "zombie"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(&id));

        let out = list.invoke(json!({})).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["items"].as_array().unwrap().len(),
            0,
            "deleted row not resurrected by the racing update"
        );
    }

    #[tokio::test]
    async fn update_errors_on_unknown_id() {
        let store = store();
        let upd = LearningMemoryUpdateTool::new(store);
        let err = upd
            .invoke(json!({"id": "ghost", "title": "x"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("ghost"));
    }

    #[test]
    fn delete_requires_approval() {
        let store = store();
        assert!(LearningMemoryDeleteTool::new(store).requires_approval());
    }

    #[test]
    fn list_does_not_require_approval() {
        let store = store();
        assert!(!LearningMemoryListTool::new(store).requires_approval());
    }
}
