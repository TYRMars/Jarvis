//! Persistent Requirement kanban tools — `requirement.{list,start,block,complete}`.
//!
//! Surfaces the [`harness_core::RequirementStore`] +
//! [`harness_core::ActivityStore`] APIs to the LLM. Mirrors the
//! status-mutation paths in `harness-server::requirements_routes`
//! but with typed schemas instead of HTTP-shaped bodies.
//!
//! Phase 4 closing piece (per
//! `docs/proposals/work-orchestration.zh-CN.md`): until now every
//! kanban state advance had to come from a human clicking the UI or
//! a script hitting REST. These tools let the agent itself drive
//! board state — "I read the code, blocker is at X, mark blocked"
//! or "verification passed, push to review".
//!
//! Scope decisions:
//!
//! - `requirement.start` only flips status (Backlog/Review →
//!   InProgress). It does **not** mint a fresh
//!   [`Conversation`](harness_core::Conversation) or trigger an
//!   actual run — that lives in `harness-server`'s `start_run`
//!   handler and the auto-mode scheduler. Tools mutate metadata,
//!   not execution. Mirrors the `todo.*` / `project.*` precedent.
//!
//! - `requirement.block` does **not** change status — the wire
//!   `RequirementStatus` enum has no Blocked variant (it's a 4-
//!   column kanban: Backlog / InProgress / Review / Done). Instead
//!   the tool appends an [`ActivityKind::Blocked`] row with the
//!   reason, surfaced in the card's audit timeline. Pair with
//!   `requirement.start` later to clear the block.
//!
//! - `requirement.complete` flips into Review and stops there. The
//!   final `Done` transition is reserved for the human — the model
//!   can declare "I think this is done" but acceptance is observed,
//!   not self-claimed. There is no `auto_complete` escape hatch by
//!   design.
//!
//! Activity actor: tool-driven mutations record actor as
//! [`ActivityActor::Agent`] with a placeholder `profile_id`
//! (`"tool"`). The harness loop doesn't know which named
//! [`AgentProfile`] (if any) this conversation is assigned to, so
//! v0 surfaces "an agent did it" without claiming a specific
//! identity. A future PR can either (a) thread the profile id
//! through the tool-call context or (b) introduce a dedicated
//! `ActivityActor::AgentTool` variant.
//!
//! Approval policy: `requirement.*` mutations are **not**
//! approval-gated. The user wants the agent to drive board state
//! freely; the audit timeline ([`Activity`]) is the recovery
//! mechanism, not an upfront block. Operators who want stricter
//! control can register a `RuleApprover` rule against
//! `requirement.*` — same opt-in pattern as `todo.*`. The one
//! human-only gate is the `Review → Done` transition, enforced
//! structurally: this tool simply cannot write `Done`.
//!
//! Tools are registered conditionally — both
//! `BuiltinsConfig::requirement_store` AND `activity_store` must
//! be `Some(_)`. A half-enabled set (mutations land but the audit
//! row goes nowhere) is strictly worse than off.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    Activity, ActivityActor, ActivityKind, ActivityStore, BoxError, Requirement,
    RequirementStatus, RequirementStore, Tool, ToolCategory,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_LIST_LIMIT: u32 = 50;
const MAX_LIST_LIMIT: u32 = 500;

/// Placeholder profile id used in [`ActivityActor::Agent`] when a
/// tool-driven mutation can't resolve the calling agent's identity.
/// See module-level docs for rationale.
const TOOL_ACTOR_PLACEHOLDER: &str = "tool";

fn requirement_to_json(r: &Requirement) -> Value {
    serde_json::to_value(r).unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

fn parse_status(s: &str) -> Result<RequirementStatus, BoxError> {
    RequirementStatus::from_wire(s).ok_or_else(|| -> BoxError {
        format!(
            "unknown status `{s}` — expected one of \
             backlog / in_progress / review / done"
        )
        .into()
    })
}

/// Fire-and-forget audit append. Failures are logged at WARN — the
/// caller's response still goes through, since losing a telemetry
/// row should never break the user-visible mutation. Mirrors the
/// `record_activity` helper in `requirements_routes.rs`.
async fn record_activity(
    store: &Arc<dyn ActivityStore>,
    requirement_id: &str,
    kind: ActivityKind,
    body: Value,
) {
    let actor = ActivityActor::Agent {
        profile_id: TOOL_ACTOR_PLACEHOLDER.into(),
    };
    let activity = Activity::new(requirement_id, kind, actor, body);
    if let Err(e) = store.append(&activity).await {
        tracing::warn!(
            error = %e,
            requirement_id,
            "failed to append Activity from requirement.* tool"
        );
    }
}

// ---------- requirement.list ----------------------------------------------

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
        "List the kanban requirements under a project, newest-updated \
         first. Requires `project_id` (UUID); call `project.list` \
         first if you don't have it. Optional `status` narrows to one \
         column (backlog / in_progress / review / done). Optional \
         `limit` caps results (default 50, max 500)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {
                    "type": "string",
                    "description": "Project UUID. Use `project.list` to find it."
                },
                "status": {
                    "type": "string",
                    "enum": ["backlog", "in_progress", "review", "done"],
                    "description": "Optional column filter."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIST_LIMIT,
                    "description": "Max rows to return. Defaults to 50."
                }
            },
            "required": ["project_id"]
        })
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            project_id: String,
            #[serde(default)]
            status: Option<String>,
            #[serde(default)]
            limit: Option<u32>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.list: bad args: {e}").into() })?;
        let project_id = parsed.project_id.trim().to_string();
        if project_id.is_empty() {
            return Err("requirement.list: `project_id` must not be blank".into());
        }
        let status_filter = parsed
            .status
            .as_deref()
            .map(parse_status)
            .transpose()?;
        let limit = parsed
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .min(MAX_LIST_LIMIT) as usize;
        let mut items = self.store.list(&project_id).await?;
        if let Some(s) = status_filter {
            items.retain(|r| r.status == s);
        }
        items.truncate(limit);
        Ok(serde_json::to_string(&json!({
            "project_id": project_id,
            "items": items,
            "count": items.len(),
        }))?)
    }
}

// ---------- requirement.start ---------------------------------------------

pub struct RequirementStartTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementStartTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
    }
}

#[async_trait]
impl Tool for RequirementStartTool {
    fn name(&self) -> &str {
        "requirement.start"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn description(&self) -> &str {
        "Mark a requirement as actively being worked on (flips status \
         to `in_progress`). Use when picking up a `backlog` card or \
         re-opening a `review` card after rework. Errors if the card \
         is already `done` — explicitly re-open via PATCH if that's \
         intended. Does NOT mint a fresh conversation or kick off an \
         agent run; the actual run is started by the auto-mode \
         scheduler or by a human pressing Run in the UI. This tool \
         only advances board state."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement UUID." },
                "note": {
                    "type": "string",
                    "description": "Optional one-liner for the audit timeline."
                }
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
            note: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.start: bad args: {e}").into() })?;
        let mut item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement.start: id `{}` not found", parsed.id).into()
            })?;
        if item.status == RequirementStatus::Done {
            return Err(format!(
                "requirement.start: id `{}` is already `done` — \
                 PATCH the status explicitly if you want to re-open it",
                parsed.id
            )
            .into());
        }
        let prior = item.status;
        if prior == RequirementStatus::InProgress {
            // Idempotent: status already InProgress, leave the row
            // alone but let the activity timeline carry the note so
            // the agent's intent is recorded.
            if let Some(n) = parsed.note.as_deref().filter(|n| !n.trim().is_empty()) {
                record_activity(
                    &self.activity,
                    &item.id,
                    ActivityKind::Comment,
                    json!({ "text": n.trim() }),
                )
                .await;
            }
            return Ok(requirement_to_json(&item).to_string());
        }
        item.status = RequirementStatus::InProgress;
        item.touch();
        self.store.upsert(&item).await?;
        record_activity(
            &self.activity,
            &item.id,
            ActivityKind::StatusChange,
            json!({
                "from": prior.as_wire(),
                "to": item.status.as_wire(),
            }),
        )
        .await;
        if let Some(n) = parsed.note.as_deref().filter(|n| !n.trim().is_empty()) {
            record_activity(
                &self.activity,
                &item.id,
                ActivityKind::Comment,
                json!({ "text": n.trim() }),
            )
            .await;
        }
        Ok(requirement_to_json(&item).to_string())
    }
}

// ---------- requirement.block ---------------------------------------------

pub struct RequirementBlockTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementBlockTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
    }
}

#[async_trait]
impl Tool for RequirementBlockTool {
    fn name(&self) -> &str {
        "requirement.block"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn description(&self) -> &str {
        "Record that a requirement is blocked, with a reason. Use \
         when you've identified a blocker the user needs to resolve \
         (missing design, missing credentials, upstream bug). The \
         kanban does NOT have a Blocked column — the requirement \
         stays in its current column but gains a `blocked` row in \
         the audit timeline that the UI surfaces as a banner. Pair \
         with `requirement.start` once the blocker clears."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement UUID." },
                "reason": {
                    "type": "string",
                    "description": "Why it's blocked. One sentence; user-readable."
                }
            },
            "required": ["id", "reason"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id").and_then(|v| v.as_str()).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            reason: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.block: bad args: {e}").into() })?;
        let reason = parsed.reason.trim().to_string();
        if reason.is_empty() {
            return Err("requirement.block: `reason` must not be blank".into());
        }
        let item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement.block: id `{}` not found", parsed.id).into()
            })?;
        record_activity(
            &self.activity,
            &item.id,
            ActivityKind::Blocked,
            json!({ "reason": reason }),
        )
        .await;
        Ok(json!({
            "id": item.id,
            "blocked": true,
            "reason": reason,
        })
        .to_string())
    }
}

// ---------- requirement.complete ------------------------------------------

pub struct RequirementCompleteTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementCompleteTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
    }
}

#[async_trait]
impl Tool for RequirementCompleteTool {
    fn name(&self) -> &str {
        "requirement.complete"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn description(&self) -> &str {
        "Mark a requirement as ready for review (flips status to \
         `review`) and record a completion summary. The model NEVER \
         writes `done` — final acceptance is the human's call, \
         observed by reading the review and flipping the column. \
         Errors if the card is already `done`. If the card is \
         already in `review`, this tool only appends the completion \
         summary to the audit timeline."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "Requirement UUID." },
                "summary": {
                    "type": "string",
                    "description": "What was done. 1-3 sentences; user-readable."
                }
            },
            "required": ["id", "summary"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id").and_then(|v| v.as_str()).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            summary: String,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.complete: bad args: {e}").into() })?;
        let summary = parsed.summary.trim().to_string();
        if summary.is_empty() {
            return Err("requirement.complete: `summary` must not be blank".into());
        }
        let mut item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement.complete: id `{}` not found", parsed.id).into()
            })?;
        if item.status == RequirementStatus::Done {
            return Err(format!(
                "requirement.complete: id `{}` is already `done` — \
                 the human has accepted; no further mutation is allowed",
                parsed.id
            )
            .into());
        }
        let prior = item.status;
        if prior != RequirementStatus::Review {
            item.status = RequirementStatus::Review;
            item.touch();
            self.store.upsert(&item).await?;
            record_activity(
                &self.activity,
                &item.id,
                ActivityKind::StatusChange,
                json!({
                    "from": prior.as_wire(),
                    "to": item.status.as_wire(),
                }),
            )
            .await;
        }
        record_activity(
            &self.activity,
            &item.id,
            ActivityKind::Comment,
            json!({ "text": summary, "kind": "completion_summary" }),
        )
        .await;
        Ok(requirement_to_json(&item).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{ActivityEvent, RequirementEvent};
    use std::collections::HashMap;
    use tokio::sync::{broadcast, RwLock};

    /// Tiny in-memory `RequirementStore` for the tool unit tests. We
    /// can't depend on `harness-store` from `harness-tools` (would
    /// create a cycle), so the impl lives inline.
    struct TestReqStore {
        inner: RwLock<HashMap<String, Requirement>>,
        tx: broadcast::Sender<RequirementEvent>,
    }
    impl TestReqStore {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(8);
            Self {
                inner: RwLock::new(HashMap::new()),
                tx,
            }
        }
    }
    #[async_trait]
    impl RequirementStore for TestReqStore {
        async fn list(&self, project_id: &str) -> Result<Vec<Requirement>, BoxError> {
            let mut rows: Vec<Requirement> = self
                .inner
                .read()
                .await
                .values()
                .filter(|r| r.project_id == project_id)
                .cloned()
                .collect();
            rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(rows)
        }
        async fn get(&self, id: &str) -> Result<Option<Requirement>, BoxError> {
            Ok(self.inner.read().await.get(id).cloned())
        }
        async fn upsert(&self, item: &Requirement) -> Result<(), BoxError> {
            self.inner
                .write()
                .await
                .insert(item.id.clone(), item.clone());
            let _ = self.tx.send(RequirementEvent::Upserted(item.clone()));
            Ok(())
        }
        async fn delete(&self, id: &str) -> Result<bool, BoxError> {
            Ok(self.inner.write().await.remove(id).is_some())
        }
        fn subscribe(&self) -> broadcast::Receiver<RequirementEvent> {
            self.tx.subscribe()
        }
    }

    /// Tiny in-memory `ActivityStore` for the tool unit tests.
    struct TestActStore {
        inner: RwLock<Vec<Activity>>,
        tx: broadcast::Sender<ActivityEvent>,
    }
    impl TestActStore {
        fn new() -> Self {
            let (tx, _) = broadcast::channel(8);
            Self {
                inner: RwLock::new(Vec::new()),
                tx,
            }
        }
        async fn snapshot(&self) -> Vec<Activity> {
            self.inner.read().await.clone()
        }
    }
    #[async_trait]
    impl ActivityStore for TestActStore {
        async fn list_for_requirement(
            &self,
            requirement_id: &str,
        ) -> Result<Vec<Activity>, BoxError> {
            Ok(self
                .inner
                .read()
                .await
                .iter()
                .filter(|a| a.requirement_id == requirement_id)
                .cloned()
                .collect())
        }
        async fn append(&self, activity: &Activity) -> Result<(), BoxError> {
            self.inner.write().await.push(activity.clone());
            let _ = self.tx.send(ActivityEvent::Appended(activity.clone()));
            Ok(())
        }
        fn subscribe(&self) -> broadcast::Receiver<ActivityEvent> {
            self.tx.subscribe()
        }
    }

    fn fixtures() -> (Arc<TestReqStore>, Arc<TestActStore>) {
        (Arc::new(TestReqStore::new()), Arc::new(TestActStore::new()))
    }

    async fn seed(store: &Arc<TestReqStore>, project_id: &str, title: &str) -> Requirement {
        let r = Requirement::new(project_id, title);
        let arc: Arc<dyn RequirementStore> = store.clone();
        arc.upsert(&r).await.unwrap();
        r
    }

    #[tokio::test]
    async fn list_returns_only_matching_project() {
        let (rs, _as) = fixtures();
        seed(&rs, "p-a", "alpha").await;
        seed(&rs, "p-a", "beta").await;
        seed(&rs, "p-b", "gamma").await;
        let tool = RequirementListTool::new(rs);
        let out = tool.invoke(json!({ "project_id": "p-a" })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["count"], 2);
        let titles: Vec<&str> = v["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["title"].as_str())
            .collect();
        assert!(titles.contains(&"alpha"));
        assert!(titles.contains(&"beta"));
        assert!(!titles.contains(&"gamma"));
    }

    #[tokio::test]
    async fn list_filters_by_status() {
        let (rs, acts) = fixtures();
        let r1 = seed(&rs, "p", "open").await;
        seed(&rs, "p", "still-open").await;
        // Bump r1 into in_progress via the start tool.
        let start = RequirementStartTool::new(rs.clone(), acts.clone());
        start.invoke(json!({ "id": r1.id })).await.unwrap();

        let list = RequirementListTool::new(rs);
        let in_prog = list
            .invoke(json!({ "project_id": "p", "status": "in_progress" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&in_prog).unwrap();
        assert_eq!(v["count"], 1);
        assert_eq!(v["items"][0]["title"], "open");

        let backlog = list
            .invoke(json!({ "project_id": "p", "status": "backlog" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&backlog).unwrap();
        assert_eq!(v["count"], 1);
        assert_eq!(v["items"][0]["title"], "still-open");
    }

    #[tokio::test]
    async fn list_rejects_blank_project_id() {
        let (rs, _as) = fixtures();
        let tool = RequirementListTool::new(rs);
        let err = tool
            .invoke(json!({ "project_id": "   " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[tokio::test]
    async fn list_rejects_unknown_status() {
        let (rs, _as) = fixtures();
        let tool = RequirementListTool::new(rs);
        let err = tool
            .invoke(json!({ "project_id": "p", "status": "zomg" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown status"));
    }

    #[tokio::test]
    async fn start_flips_backlog_to_in_progress_and_records_activity() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "build it").await;
        let start = RequirementStartTool::new(rs.clone(), acts.clone());
        let out = start.invoke(json!({ "id": r.id })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "in_progress");

        let timeline = acts.snapshot().await;
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].kind, ActivityKind::StatusChange);
        assert_eq!(timeline[0].body["from"], "backlog");
        assert_eq!(timeline[0].body["to"], "in_progress");
        // Tool-driven mutations record actor as Agent with placeholder.
        match &timeline[0].actor {
            ActivityActor::Agent { profile_id } => assert_eq!(profile_id, "tool"),
            other => panic!("unexpected actor: {other:?}"),
        }
    }

    #[tokio::test]
    async fn start_with_note_records_comment() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let start = RequirementStartTool::new(rs.clone(), acts.clone());
        start
            .invoke(json!({ "id": r.id, "note": "picking this up" }))
            .await
            .unwrap();
        let timeline = acts.snapshot().await;
        // status_change + comment.
        assert_eq!(timeline.len(), 2);
        assert!(timeline.iter().any(|a| a.kind == ActivityKind::Comment
            && a.body["text"] == "picking this up"));
    }

    #[tokio::test]
    async fn start_idempotent_when_already_in_progress() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let start = RequirementStartTool::new(rs.clone(), acts.clone());
        start.invoke(json!({ "id": r.id })).await.unwrap();
        // Second call: status already InProgress — no extra status_change row.
        let before = acts.snapshot().await.len();
        start.invoke(json!({ "id": r.id })).await.unwrap();
        assert_eq!(acts.snapshot().await.len(), before);
    }

    #[tokio::test]
    async fn start_errors_on_done() {
        let (rs, acts) = fixtures();
        let mut r = Requirement::new("p", "x");
        r.status = RequirementStatus::Done;
        let arc: Arc<dyn RequirementStore> = rs.clone();
        arc.upsert(&r).await.unwrap();

        let start = RequirementStartTool::new(rs, acts);
        let err = start.invoke(json!({ "id": r.id })).await.unwrap_err();
        assert!(err.to_string().contains("already `done`"));
    }

    #[tokio::test]
    async fn start_errors_on_unknown_id() {
        let (rs, acts) = fixtures();
        let start = RequirementStartTool::new(rs, acts);
        let err = start
            .invoke(json!({ "id": "no-such" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn block_records_activity_without_status_change() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let block = RequirementBlockTool::new(rs.clone(), acts.clone());
        let out = block
            .invoke(json!({ "id": r.id, "reason": "missing design spec" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["blocked"], true);
        assert_eq!(v["reason"], "missing design spec");

        // Status untouched on disk.
        let arc: Arc<dyn RequirementStore> = rs;
        let after = arc.get(&r.id).await.unwrap().unwrap();
        assert_eq!(after.status, RequirementStatus::Backlog);

        let timeline = acts.snapshot().await;
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].kind, ActivityKind::Blocked);
        assert_eq!(timeline[0].body["reason"], "missing design spec");
    }

    #[tokio::test]
    async fn block_rejects_blank_reason() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let block = RequirementBlockTool::new(rs, acts);
        let err = block
            .invoke(json!({ "id": r.id, "reason": "  " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[tokio::test]
    async fn complete_flips_to_review_by_default() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let complete = RequirementCompleteTool::new(rs.clone(), acts.clone());
        let out = complete
            .invoke(json!({ "id": r.id, "summary": "done with X and Y" }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "review");

        let timeline = acts.snapshot().await;
        // status_change + completion comment.
        assert_eq!(timeline.len(), 2);
        assert!(timeline
            .iter()
            .any(|a| a.kind == ActivityKind::StatusChange && a.body["to"] == "review"));
        assert!(timeline.iter().any(|a| a.kind == ActivityKind::Comment
            && a.body["kind"] == "completion_summary"));
    }

    #[tokio::test]
    async fn complete_never_writes_done_even_with_auto_complete_arg() {
        // Backwards-compat sanity: even if a caller smuggles in an
        // `auto_complete: true` field (the param was removed), the
        // tool ignores it and still flips to Review. Final
        // acceptance is structurally human-only.
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let complete = RequirementCompleteTool::new(rs, acts.clone());
        let out = complete
            .invoke(json!({
                "id": r.id,
                "summary": "verification passed",
                "auto_complete": true,
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "review");
        let timeline = acts.snapshot().await;
        assert!(!timeline
            .iter()
            .any(|a| a.kind == ActivityKind::StatusChange && a.body["to"] == "done"));
    }

    #[tokio::test]
    async fn complete_errors_on_done() {
        let (rs, acts) = fixtures();
        let mut r = Requirement::new("p", "x");
        r.status = RequirementStatus::Done;
        let arc: Arc<dyn RequirementStore> = rs.clone();
        arc.upsert(&r).await.unwrap();

        let complete = RequirementCompleteTool::new(rs, acts);
        let err = complete
            .invoke(json!({ "id": r.id, "summary": "x" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("already `done`"));
    }

    #[tokio::test]
    async fn complete_skips_status_change_if_already_in_target() {
        let (rs, acts) = fixtures();
        let mut r = Requirement::new("p", "x");
        r.status = RequirementStatus::Review;
        let arc: Arc<dyn RequirementStore> = rs.clone();
        arc.upsert(&r).await.unwrap();

        let complete = RequirementCompleteTool::new(rs, acts.clone());
        complete
            .invoke(json!({ "id": r.id, "summary": "rework finished" }))
            .await
            .unwrap();
        let timeline = acts.snapshot().await;
        // Only the completion comment; no status_change because we
        // were already in Review.
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].kind, ActivityKind::Comment);
    }

    #[test]
    fn no_tool_requires_approval() {
        // requirement.* deliberately does NOT gate on the approver;
        // the audit timeline is the recovery mechanism, and operators
        // who want stricter control register a `RuleApprover` rule.
        // Same opt-in pattern as `todo.*`.
        let (rs, acts) = fixtures();
        let rs_dyn: Arc<dyn RequirementStore> = rs;
        let acts_dyn: Arc<dyn ActivityStore> = acts;
        assert!(!RequirementListTool::new(rs_dyn.clone()).requires_approval());
        assert!(!RequirementStartTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval());
        assert!(!RequirementBlockTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval());
        assert!(!RequirementCompleteTool::new(rs_dyn, acts_dyn).requires_approval());
    }
}
