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
//! Approval policy: status-mutation tools (`requirement.start /
//! block / complete`) are **not** approval-gated — the user wants
//! the agent to drive board state freely; the audit timeline
//! ([`Activity`]) is the recovery mechanism, not an upfront
//! block. Operators who want stricter control can register a
//! `RuleApprover` rule against `requirement.*` — same opt-in
//! pattern as `todo.*`.
//!
//! `requirement.create / update / delete` (v1.0) are different —
//! they create or remove backlog rows that the auto executor will
//! later spend real tokens on. They run **without** an approval
//! gate, but new rows the agent creates default to
//! [`TriageState::ProposedByAgent`] so they sit in the triage
//! queue until a human approves. That's a structural gate the
//! model can't bypass: even if the agent calls `requirement.create`
//! freely, nothing executes without explicit human acceptance.
//! REST callers (humans hitting `POST /v1/projects/:id/requirements`)
//! still default to [`TriageState::Approved`] for back-compat.
//!
//! The one human-only gate is the `Review → Done` transition,
//! enforced structurally: `requirement.complete` simply cannot
//! write `Done`.
//!
//! Tools are registered conditionally — both
//! `BuiltinsConfig::requirement_store` AND `activity_store` must
//! be `Some(_)`. A half-enabled set (mutations land but the audit
//! row goes nowhere) is strictly worse than off.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    Activity, ActivityActor, ActivityKind, ActivityStore, BoxError, Requirement, RequirementStatus,
    RequirementStore, RequirementTodo, RequirementTodoCreator, RequirementTodoEvidence,
    RequirementTodoKind, RequirementTodoStatus, Tool, ToolCategory, TriageState, VerificationPlan,
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
        let status_filter = parsed.status.as_deref().map(parse_status).transpose()?;
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

// ---------- requirement.review_verdict ------------------------------------
//
// Tool the reviewer subagent uses to record its verdict. **NOT** part of
// the default tool registration — `register_builtins` does not register
// it. The composition root is responsible for adding it ONLY to the
// reviewer subagent's tool registry, so the work agent can never write
// `Done` directly. See `docs/proposals/subagents.zh-CN.md` (the
// "Reviewer Verdict" section).
//
// Behaviour:
//   - `pass`  → status: Review → Done, two Activity rows (StatusChange + Comment).
//   - `fail`  → status: Review → InProgress, two Activity rows. The
//     commentary travels with the row so the next pickup can read it.
//   - Errors out if the row isn't currently in `Review` (unexpected —
//     reviewer is dispatched by the auto loop after the work agent
//     flipped to Review).

pub struct RequirementReviewVerdictTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementReviewVerdictTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
    }
}

#[async_trait]
impl Tool for RequirementReviewVerdictTool {
    fn name(&self) -> &str {
        "requirement.review_verdict"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn description(&self) -> &str {
        "Record a reviewer verdict on a requirement currently in Review. \
         `pass` flips it to Done; `fail` bounces it back to InProgress \
         with the commentary attached so the next work-agent pickup can \
         adapt. Reviewer subagents call this exactly once per run; the \
         main work agent does not have access to this tool."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Requirement UUID under review."
                },
                "verdict": {
                    "type": "string",
                    "enum": ["pass", "fail"],
                    "description": "`pass` accepts the work; `fail` bounces it back."
                },
                "commentary": {
                    "type": "string",
                    "description": "1-2 sentence justification visible to humans and to the next work-agent pickup on `fail`."
                },
                "evidence": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional bullets — verification_plan items + their pass/fail status, file paths checked, etc."
                }
            },
            "required": ["id", "verdict", "commentary"]
        })
    }

    fn summary_for_audit(&self, args: &Value) -> Option<String> {
        args.get("id").and_then(|v| v.as_str()).map(str::to_string)
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        #[derive(Deserialize)]
        struct Args {
            id: String,
            verdict: String,
            commentary: String,
            #[serde(default)]
            evidence: Vec<String>,
        }
        let parsed: Args = serde_json::from_value(args).map_err(|e| -> BoxError {
            format!("requirement.review_verdict: bad args: {e}").into()
        })?;
        let commentary = parsed.commentary.trim().to_owned();
        if commentary.is_empty() {
            return Err("requirement.review_verdict: `commentary` must not be blank".into());
        }
        let pass = match parsed.verdict.as_str() {
            "pass" => true,
            "fail" => false,
            other => {
                return Err(format!(
                    "requirement.review_verdict: bad verdict `{other}` — expected `pass` or `fail`"
                )
                .into())
            }
        };

        let mut item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement.review_verdict: id `{}` not found", parsed.id).into()
            })?;
        if item.status != RequirementStatus::Review {
            return Err(format!(
                "requirement.review_verdict: id `{}` is `{}`, not `review` — \
                 reviewer should only run after work agent flipped to Review",
                parsed.id,
                item.status.as_wire()
            )
            .into());
        }

        let prior = item.status;
        item.status = if pass {
            RequirementStatus::Done
        } else {
            RequirementStatus::InProgress
        };
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
        record_activity(
            &self.activity,
            &item.id,
            ActivityKind::Comment,
            json!({
                "text": commentary,
                "kind": if pass { "review_passed" } else { "review_failed" },
                "evidence": parsed.evidence,
            }),
        )
        .await;
        Ok(requirement_to_json(&item).to_string())
    }
}

// ---------- requirement.create --------------------------------------------

/// Helper: parse a string `triage_state` argument into the enum, or
/// fall back to a context-appropriate default.
fn parse_triage_state(
    raw: Option<&str>,
    default_when_missing: TriageState,
) -> Result<TriageState, BoxError> {
    match raw {
        None => Ok(default_when_missing),
        Some(s) => TriageState::from_wire(s.trim()).ok_or_else(|| -> BoxError {
            format!(
                "unknown triage_state `{s}` — expected one of \
                 approved / proposed_by_agent / proposed_by_scan"
            )
            .into()
        }),
    }
}

#[derive(Debug, Deserialize)]
struct RequirementTodoInput {
    title: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    evidence: Option<RequirementTodoEvidence>,
    #[serde(default)]
    depends_on: Option<Vec<String>>,
    #[serde(default)]
    created_by: Option<String>,
}

fn todo_from_input(input: RequirementTodoInput) -> Result<RequirementTodo, BoxError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("requirement todo `title` must not be blank".into());
    }
    let kind_wire = input.kind.as_deref().unwrap_or("work");
    let kind = RequirementTodoKind::from_wire(kind_wire).ok_or_else(|| -> BoxError {
        format!("unknown requirement todo kind `{kind_wire}`").into()
    })?;
    let mut todo = RequirementTodo::new(title, kind);
    if let Some(s) = input.status.as_deref() {
        todo.status = RequirementTodoStatus::from_wire(s).ok_or_else(|| -> BoxError {
            format!("unknown requirement todo status `{s}`").into()
        })?;
    }
    todo.command = input
        .command
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    todo.evidence = input.evidence;
    todo.depends_on = input
        .depends_on
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(s) = input.created_by.as_deref() {
        todo.created_by = RequirementTodoCreator::from_wire(s).ok_or_else(|| -> BoxError {
            format!("unknown requirement todo creator `{s}`").into()
        })?;
    }
    Ok(todo)
}

pub struct RequirementCreateTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementCreateTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
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

    fn description(&self) -> &str {
        "Create a new requirement card under a project. The agent \
         calls this when a user describes work to be done, or when \
         decomposing a spec/doc into kanban rows. New rows default to \
         status=`backlog` and triage_state=`proposed_by_agent` — they \
         appear in the project's Triage queue and DO NOT run \
         automatically until a human approves. Pass \
         `triage_state=approved` only when the user has explicitly \
         confirmed the card (e.g. \"yes, add these and start\"). \
         Optional `verification_plan.commands` (e.g. \
         [\"cargo test\"]) pin the verification gate that runs after \
         each agent run finishes. Optional `depends_on` lists other \
         requirement ids that must reach `done` first. Optional \
         `todos` stores structured work/check/ci/deploy/review/manual \
         checklist items with command and evidence fields."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": { "type": "string", "description": "Project UUID. Use project.list to find it." },
                "title": { "type": "string", "description": "One-sentence headline." },
                "description": { "type": "string", "description": "Optional longer body (markdown allowed)." },
                "verification_plan": {
                    "type": "object",
                    "description": "Optional pinned verification template. Has a `commands` array of shell strings (e.g. [\"cargo test -p foo\"]) and optional `require_diff` / `require_tests` / `require_human_review` booleans.",
                    "properties": {
                        "commands": { "type": "array", "items": { "type": "string" } },
                        "require_diff": { "type": "boolean" },
                        "require_tests": { "type": "boolean" },
                        "require_human_review": { "type": "boolean" }
                    }
                },
                "depends_on": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Other requirement ids that must reach `done` before this one is auto-eligible."
                },
                "todos": {
                    "type": "array",
                    "description": "Structured execution/checklist items for this requirement. Use for CI/CD commands, deploy checks, manual QA, or review gates that should be inspectable later.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "kind": { "type": "string", "enum": ["work", "check", "ci", "deploy", "review", "manual"] },
                            "status": { "type": "string", "enum": ["pending", "running", "passed", "failed", "skipped", "blocked"] },
                            "command": { "type": "string" },
                            "depends_on": { "type": "array", "items": { "type": "string" } },
                            "created_by": { "type": "string", "enum": ["human", "agent", "workflow"] },
                            "evidence": { "type": "object" }
                        },
                        "required": ["title"]
                    }
                },
                "assignee_id": { "type": "string", "description": "Optional AgentProfile id to pin." },
                "triage_state": {
                    "type": "string",
                    "enum": ["approved", "proposed_by_agent", "proposed_by_scan"],
                    "description": "Triage gate. Defaults to `proposed_by_agent` so agent-created rows wait for human approval. Pass `approved` only when the user explicitly confirmed."
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
            verification_plan: Option<VerificationPlan>,
            #[serde(default)]
            depends_on: Option<Vec<String>>,
            #[serde(default)]
            todos: Option<Vec<RequirementTodoInput>>,
            #[serde(default)]
            assignee_id: Option<String>,
            #[serde(default)]
            triage_state: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.create: bad args: {e}").into() })?;
        let project_id = parsed.project_id.trim().to_string();
        if project_id.is_empty() {
            return Err("requirement.create: `project_id` must not be blank".into());
        }
        let title = parsed.title.trim().to_string();
        if title.is_empty() {
            return Err("requirement.create: `title` must not be blank".into());
        }
        // Agent-driven creation defaults to ProposedByAgent — the
        // model can override to Approved when the user confirms.
        let triage_state =
            parse_triage_state(parsed.triage_state.as_deref(), TriageState::ProposedByAgent)?;

        let mut req = Requirement::new(&project_id, &title);
        if let Some(d) = parsed
            .description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            req.description = Some(d.to_string());
        }
        if let Some(plan) = parsed.verification_plan {
            req.verification_plan = Some(plan);
        }
        if let Some(deps) = parsed.depends_on {
            req.depends_on = deps.into_iter().filter(|d| !d.trim().is_empty()).collect();
        }
        if let Some(todos) = parsed.todos {
            for todo in todos {
                req.todos.push(todo_from_input(todo)?);
            }
        }
        if let Some(a) = parsed
            .assignee_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            req.assignee_id = Some(a.to_string());
        }
        req.triage_state = triage_state;

        self.store.upsert(&req).await?;
        // Audit: log creation as a Comment with kind=created so the
        // timeline carries the source channel.
        record_activity(
            &self.activity,
            &req.id,
            ActivityKind::Comment,
            json!({
                "kind": "created",
                "title": req.title,
                "triage_state": req.triage_state.as_wire(),
            }),
        )
        .await;
        Ok(requirement_to_json(&req).to_string())
    }
}

// ---------- requirement.update --------------------------------------------

pub struct RequirementUpdateTool {
    store: Arc<dyn RequirementStore>,
    activity: Arc<dyn ActivityStore>,
}

impl RequirementUpdateTool {
    pub fn new(store: Arc<dyn RequirementStore>, activity: Arc<dyn ActivityStore>) -> Self {
        Self { store, activity }
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

    fn description(&self) -> &str {
        "Update mutable metadata on an existing requirement. Pass any \
         subset of {title, description, verification_plan, depends_on, \
         todos, assignee_id, triage_state} — omitted fields keep their current \
         value. To clear `description`, pass an empty string. To clear \
         `assignee_id` pass an empty string. Status transitions go \
         through requirement.{start,complete,block} instead, not this \
         tool."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "description": { "type": "string", "description": "Empty string clears." },
                "verification_plan": { "type": "object" },
                "depends_on": { "type": "array", "items": { "type": "string" } },
                "todos": {
                    "type": "array",
                    "description": "Replace the full structured TODO/checklist list. Each item supports title, kind, status, command, evidence, depends_on, created_by.",
                    "items": { "type": "object" }
                },
                "assignee_id": { "type": "string", "description": "Empty string clears." },
                "triage_state": {
                    "type": "string",
                    "enum": ["approved", "proposed_by_agent", "proposed_by_scan"]
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
            title: Option<String>,
            #[serde(default)]
            description: Option<String>,
            #[serde(default)]
            verification_plan: Option<VerificationPlan>,
            #[serde(default)]
            depends_on: Option<Vec<String>>,
            #[serde(default)]
            todos: Option<Vec<RequirementTodoInput>>,
            #[serde(default)]
            assignee_id: Option<String>,
            #[serde(default)]
            triage_state: Option<String>,
        }
        let parsed: Args = serde_json::from_value(args)
            .map_err(|e| -> BoxError { format!("requirement.update: bad args: {e}").into() })?;
        let mut item = self
            .store
            .get(&parsed.id)
            .await?
            .ok_or_else(|| -> BoxError {
                format!("requirement.update: id `{}` not found", parsed.id).into()
            })?;
        let prior_triage = item.triage_state;
        let mut changed = false;
        if let Some(t) = parsed.title {
            let trimmed = t.trim().to_string();
            if trimmed.is_empty() {
                return Err("requirement.update: `title` must not be blank".into());
            }
            if item.title != trimmed {
                item.title = trimmed;
                changed = true;
            }
        }
        if let Some(d) = parsed.description {
            let trimmed = d.trim().to_string();
            let new_desc = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
            if item.description != new_desc {
                item.description = new_desc;
                changed = true;
            }
        }
        if let Some(plan) = parsed.verification_plan {
            item.verification_plan = Some(plan);
            changed = true;
        }
        if let Some(deps) = parsed.depends_on {
            let cleaned: Vec<String> = deps.into_iter().filter(|d| !d.trim().is_empty()).collect();
            if item.depends_on != cleaned {
                item.depends_on = cleaned;
                changed = true;
            }
        }
        if let Some(todos) = parsed.todos {
            let mut parsed_todos = Vec::with_capacity(todos.len());
            for todo in todos {
                parsed_todos.push(todo_from_input(todo)?);
            }
            item.todos = parsed_todos;
            changed = true;
        }
        if let Some(a) = parsed.assignee_id {
            let trimmed = a.trim().to_string();
            let new_assignee = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
            if item.assignee_id != new_assignee {
                item.assignee_id = new_assignee;
                changed = true;
            }
        }
        if let Some(raw) = parsed.triage_state.as_deref() {
            let parsed_state = parse_triage_state(Some(raw), TriageState::Approved)?;
            if item.triage_state != parsed_state {
                item.triage_state = parsed_state;
                changed = true;
            }
        }
        if !changed {
            return Ok(requirement_to_json(&item).to_string());
        }
        item.touch();
        self.store.upsert(&item).await?;
        if prior_triage != item.triage_state {
            record_activity(
                &self.activity,
                &item.id,
                ActivityKind::Comment,
                json!({
                    "kind": "triage_change",
                    "from": prior_triage.as_wire(),
                    "to": item.triage_state.as_wire(),
                }),
            )
            .await;
        }
        Ok(requirement_to_json(&item).to_string())
    }
}

// ---------- requirement.delete --------------------------------------------

pub struct RequirementDeleteTool {
    store: Arc<dyn RequirementStore>,
}

impl RequirementDeleteTool {
    pub fn new(store: Arc<dyn RequirementStore>) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RequirementDeleteTool {
    fn name(&self) -> &str {
        "requirement.delete"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn description(&self) -> &str {
        "Permanently remove a requirement row. Use sparingly — the \
         row's run history and activity timeline disappear with it. \
         For \"this no longer applies\" the better move is \
         requirement.update setting triage_state=approved + \
         requirement.complete (lands in Review for the human to flip \
         to Done). This tool is gated by approval."
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
            .map_err(|e| -> BoxError { format!("requirement.delete: bad args: {e}").into() })?;
        let deleted = self.store.delete(&parsed.id).await?;
        Ok(json!({ "id": parsed.id, "deleted": deleted }).to_string())
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
        assert!(timeline
            .iter()
            .any(|a| a.kind == ActivityKind::Comment && a.body["text"] == "picking this up"));
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
        let err = start.invoke(json!({ "id": "no-such" })).await.unwrap_err();
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
        assert!(timeline
            .iter()
            .any(|a| a.kind == ActivityKind::Comment && a.body["kind"] == "completion_summary"));
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
    fn no_status_tool_requires_approval() {
        // Status-mutation tools (`start / block / complete`) and
        // `create / update` are NOT approval-gated; the audit timeline
        // + the structural Triage gate are the recovery mechanisms.
        // `requirement.delete` IS gated because it discards run history
        // irrecoverably.
        let (rs, acts) = fixtures();
        let rs_dyn: Arc<dyn RequirementStore> = rs;
        let acts_dyn: Arc<dyn ActivityStore> = acts;
        assert!(!RequirementListTool::new(rs_dyn.clone()).requires_approval());
        assert!(!RequirementStartTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval());
        assert!(!RequirementBlockTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval());
        assert!(
            !RequirementCompleteTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval()
        );
        assert!(!RequirementCreateTool::new(rs_dyn.clone(), acts_dyn.clone()).requires_approval());
        assert!(!RequirementUpdateTool::new(rs_dyn.clone(), acts_dyn).requires_approval());
        assert!(RequirementDeleteTool::new(rs_dyn).requires_approval());
    }

    // ---------- create / update / delete --------------------------------

    #[tokio::test]
    async fn create_defaults_to_proposed_by_agent_and_backlog() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs.clone(), acts.clone());
        let out = create
            .invoke(json!({
                "project_id": "p1",
                "title": "Add avatar upload",
                "description": "Multipart POST /api/avatar"
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["title"], "Add avatar upload");
        assert_eq!(v["status"], "backlog");
        assert_eq!(v["triage_state"], "proposed_by_agent");
        assert_eq!(v["project_id"], "p1");
        assert_eq!(v["description"], "Multipart POST /api/avatar");

        let timeline = acts.snapshot().await;
        assert_eq!(timeline.len(), 1);
        assert_eq!(timeline[0].kind, ActivityKind::Comment);
        assert_eq!(timeline[0].body["kind"], "created");
        assert_eq!(timeline[0].body["triage_state"], "proposed_by_agent");
    }

    #[tokio::test]
    async fn create_with_explicit_approved_overrides_default() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs, acts);
        let out = create
            .invoke(json!({
                "project_id": "p",
                "title": "user-confirmed task",
                "triage_state": "approved"
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // Default Approved field is skipped on the wire (serde
        // skip_serializing_if), so absence == approved.
        assert!(v.get("triage_state").is_none());
    }

    #[tokio::test]
    async fn create_persists_verification_plan_and_depends_on() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs.clone(), acts);
        let out = create
            .invoke(json!({
                "project_id": "p",
                "title": "x",
                "verification_plan": {
                    "commands": ["cargo test -p foo"],
                    "require_tests": true
                },
                "depends_on": ["dep-1", "dep-2", "  "],
                "todos": [
                    {
                        "title": "Run workspace CI",
                        "kind": "ci",
                        "command": "cargo test --workspace",
                        "created_by": "workflow"
                    }
                ]
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let id = v["id"].as_str().unwrap();
        let arc: Arc<dyn RequirementStore> = rs;
        let stored = arc.get(id).await.unwrap().unwrap();
        assert_eq!(
            stored.depends_on,
            vec!["dep-1".to_string(), "dep-2".to_string()]
        );
        assert!(stored.verification_plan.is_some());
        assert!(stored.verification_plan.as_ref().unwrap().require_tests);
        assert_eq!(stored.todos.len(), 1);
        assert_eq!(stored.todos[0].kind, RequirementTodoKind::Ci);
        assert_eq!(
            stored.todos[0].command.as_deref(),
            Some("cargo test --workspace")
        );
        assert_eq!(stored.todos[0].created_by, RequirementTodoCreator::Workflow);
    }

    #[tokio::test]
    async fn create_rejects_blank_title_or_project() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs, acts);
        let err = create
            .invoke(json!({ "project_id": "p", "title": "  " }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("title"));
    }

    #[tokio::test]
    async fn create_rejects_unknown_triage_state() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs, acts);
        let err = create
            .invoke(json!({ "project_id": "p", "title": "x", "triage_state": "zomg" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown triage_state"));
    }

    #[tokio::test]
    async fn update_changes_title_and_records_triage_change() {
        let (rs, acts) = fixtures();
        let create = RequirementCreateTool::new(rs.clone(), acts.clone());
        let out = create
            .invoke(json!({ "project_id": "p", "title": "draft" }))
            .await
            .unwrap();
        let id = serde_json::from_str::<Value>(&out).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        // wipe the create activity so we can read just the update audit.
        let baseline = acts.snapshot().await.len();

        let update = RequirementUpdateTool::new(rs.clone(), acts.clone());
        let out = update
            .invoke(json!({
                "id": id,
                "title": "final title",
                "triage_state": "approved"
            }))
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["title"], "final title");

        let extra = acts.snapshot().await.len() - baseline;
        assert_eq!(extra, 1, "expected exactly one triage_change activity");
        let tail = &acts.snapshot().await[baseline];
        assert_eq!(tail.body["kind"], "triage_change");
        assert_eq!(tail.body["from"], "proposed_by_agent");
        assert_eq!(tail.body["to"], "approved");
    }

    #[tokio::test]
    async fn update_no_op_when_nothing_changes() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let baseline = r.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));

        let update = RequirementUpdateTool::new(rs.clone(), acts);
        update.invoke(json!({ "id": r.id })).await.unwrap();
        let arc: Arc<dyn RequirementStore> = rs;
        let after = arc.get(&r.id).await.unwrap().unwrap();
        assert_eq!(
            after.updated_at, baseline,
            "no-op should not touch updated_at"
        );
    }

    #[tokio::test]
    async fn update_clears_description_with_empty_string() {
        let (rs, acts) = fixtures();
        let mut r = Requirement::new("p", "x");
        r.description = Some("longform".into());
        let arc: Arc<dyn RequirementStore> = rs.clone();
        arc.upsert(&r).await.unwrap();

        let update = RequirementUpdateTool::new(rs.clone(), acts);
        update
            .invoke(json!({ "id": r.id, "description": "" }))
            .await
            .unwrap();
        let after = arc.get(&r.id).await.unwrap().unwrap();
        assert!(after.description.is_none());
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let (rs, acts) = fixtures();
        let r = seed(&rs, "p", "x").await;
        let arc: Arc<dyn RequirementStore> = rs.clone();
        let _ = acts; // unused

        let delete = RequirementDeleteTool::new(rs);
        let out = delete.invoke(json!({ "id": r.id.clone() })).await.unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["deleted"], true);
        assert!(arc.get(&r.id).await.unwrap().is_none());
    }
}
