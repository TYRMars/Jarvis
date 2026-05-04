//! REST routes for the per-project Requirement kanban.
//!
//! Mounted only when [`AppState::requirements`] is set. Returns
//! `503` otherwise — same convention as `/v1/todos`, `/v1/projects`,
//! `/v1/permissions`.
//!
//! Endpoints:
//!
//! - `GET    /v1/projects/:project_id/requirements`
//!   — list, newest-first
//! - `POST   /v1/projects/:project_id/requirements`
//!   — create (body: `{title, description?, status?}`)
//! - `PATCH  /v1/requirements/:id`
//!   — partial update (body: any subset of
//!   `{title, description, status, conversation_ids}`)
//! - `POST   /v1/requirements/:id/conversations`
//!   — link a conversation id (body: `{conversation_id}`); idempotent
//! - `POST   /v1/requirements/:id/runs`
//!   — start a fresh-session run: builds a manifest from the
//!   workspace, mints a new conversation seeded with the manifest
//!   summary, links the conversation back to the requirement, flips
//!   status to `in_progress` (when the source state is `backlog`).
//!   Returns `{run, conversation_id, manifest_summary, requirement}`.
//!   Requires both a configured requirement store and a
//!   conversation store; returns 503 otherwise. When the optional
//!   [`RequirementRunStore`](harness_core::RequirementRunStore) is
//!   configured the [`RequirementRun`] row is persisted (a
//!   subscribe-time miss only loses telemetry, never the response).
//! - `GET    /v1/requirements/:id/runs`
//!   — list run history for one requirement (newest first).
//!   Requires the run store; 503 otherwise.
//! - `GET    /v1/runs/:id`
//!   — fetch one run by id; 404 if absent.
//! - `PATCH  /v1/runs/:id`
//!   — partial update (any subset of
//!   `{status, summary, error, finished_at}`). Triggers a
//!   `requirement_run_finished` WS frame when the patch flips the
//!   row to a terminal status.
//! - `POST   /v1/runs/:id/verification`
//!   — attach a [`VerificationResult`](harness_core::VerificationResult)
//!   to a run. Idempotent overwrite. Triggers a
//!   `requirement_run_verified` WS frame; if the result is terminal
//!   for the run the row is also flipped to `Completed` / `Failed`
//!   accordingly (which fires `requirement_run_finished` too).
//! - `DELETE /v1/requirements/:id`
//!   — remove
//!
//! WS clients subscribe via the existing chat socket; the broadcast
//! bridge in `routes.rs` filters [`RequirementEvent`]s and
//! [`RequirementRunEvent`](harness_core::RequirementRunEvent)s and
//! forwards as `requirement_upserted` / `requirement_deleted` /
//! `requirement_run_started` / `requirement_run_finished` /
//! `requirement_run_verified` frames.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch, post},
    Router,
};
use harness_core::{
    Activity, ActivityActor, ActivityKind, ActivityStore, Conversation, ConversationMetadata,
    Message, Requirement, RequirementRun, RequirementRunEvent, RequirementRunStatus,
    RequirementRunStore, RequirementStatus, RequirementStore, TriageState, VerificationPlan,
    VerificationResult, VerificationStatus,
};
use harness_requirement::{build_default_manifest, render_manifest_summary};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{error, info, warn};

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/:project_id/requirements",
            get(list_requirements).post(create_requirement),
        )
        .route(
            "/v1/requirements/:id",
            patch(update_requirement).delete(delete_requirement),
        )
        .route("/v1/requirements/:id/approve", post(approve_requirement))
        .route("/v1/requirements/:id/reject", post(reject_requirement))
        .route(
            "/v1/requirements/:id/conversations",
            post(link_conversation),
        )
        .route(
            "/v1/requirements/:id/runs",
            get(list_runs).post(start_run),
        )
        .route(
            "/v1/requirements/:id/activities",
            get(list_activities),
        )
        .route("/v1/runs/:id", get(get_run).patch(update_run))
        .route("/v1/runs/:id/verification", post(set_run_verification))
        .route("/v1/runs/:id/verify", post(verify_run))
        .route("/v1/runs/:id/worktree", axum::routing::delete(delete_worktree))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn RequirementStore>, Response> {
    state.requirements.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "requirement store not configured" })),
        )
            .into_response()
    })
}

#[allow(clippy::result_large_err)]
fn require_run_store(state: &AppState) -> Result<Arc<dyn RequirementRunStore>, Response> {
    state.requirement_runs.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "requirement run store not configured" })),
        )
            .into_response()
    })
}

#[allow(clippy::result_large_err)]
fn require_activity_store(state: &AppState) -> Result<Arc<dyn ActivityStore>, Response> {
    state.activities.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "activity store not configured" })),
        )
            .into_response()
    })
}

/// Fire-and-forget audit append. Failures are logged at WARN — the
/// caller's response still goes through, since losing a telemetry
/// row should never break the user-visible mutation. Mirrors the
/// `start_run` run-store WARN-on-fail policy.
async fn record_activity(
    state: &AppState,
    requirement_id: &str,
    kind: ActivityKind,
    actor: ActivityActor,
    body: Value,
) {
    let Some(store) = state.activities.as_ref() else {
        return;
    };
    let activity = Activity::new(requirement_id, kind, actor, body);
    if let Err(e) = store.append(&activity).await {
        warn!(error = %e, requirement_id, "failed to append Activity");
    }
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "requirement store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn bad_request(reason: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": reason.into() })),
    )
        .into_response()
}

// ----------------------- GET /v1/projects/:project_id/requirements -------

#[derive(Debug, Deserialize, Default)]
struct ListQuery {
    /// Optional triage gate filter. Wire form: `approved`,
    /// `proposed_by_agent`, `proposed_by_scan`, or the synthetic
    /// `proposed` (matches both `proposed_by_*`). Anything else 400s.
    #[serde(default)]
    triage_state: Option<String>,
}

async fn list_requirements(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let filter = match query.triage_state.as_deref() {
        None => None,
        Some("proposed") => Some(TriageFilter::AnyProposed),
        Some(other) => match TriageState::from_wire(other) {
            Some(state) => Some(TriageFilter::Exact(state)),
            None => return bad_request(format!("unknown triage_state `{other}`")),
        },
    };
    match store.list(&project_id).await {
        Ok(mut items) => {
            if let Some(f) = filter {
                items.retain(|r| f.matches(r.triage_state));
            }
            Json(json!({ "project_id": project_id, "items": items })).into_response()
        }
        Err(e) => internal_error(e),
    }
}

#[derive(Debug, Clone, Copy)]
enum TriageFilter {
    Exact(TriageState),
    /// Synthetic — matches anything that needs human attention
    /// (`ProposedByAgent` ∨ `ProposedByScan`). Useful for the UI
    /// Triage drawer which doesn't care which channel surfaced it.
    AnyProposed,
}

impl TriageFilter {
    fn matches(self, ts: TriageState) -> bool {
        match self {
            Self::Exact(target) => ts == target,
            Self::AnyProposed => ts.needs_triage(),
        }
    }
}

// ----------------------- POST /v1/projects/:project_id/requirements -------

#[derive(Debug, Deserialize)]
struct CreateBody {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// Optional triage gate. Defaults to `approved` for REST callers
    /// (this endpoint is hit by humans / scripts who already
    /// approved). The agent-driven `requirement.create` tool sets
    /// `proposed_by_agent` instead.
    #[serde(default)]
    triage_state: Option<String>,
    /// Optional dependency list. Other requirement ids that must
    /// reach `done` before the auto executor will pick this one up.
    #[serde(default)]
    depends_on: Option<Vec<String>>,
}

async fn create_requirement(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return bad_request("`title` must not be blank");
    }
    let mut item = Requirement::new(project_id, title);
    if let Some(s) = body.status.as_deref() {
        match RequirementStatus::from_wire(s) {
            Some(parsed) => item.status = parsed,
            None => return bad_request(format!("unknown status `{s}`")),
        }
    }
    if let Some(s) = body.triage_state.as_deref() {
        match TriageState::from_wire(s) {
            Some(parsed) => item.triage_state = parsed,
            None => return bad_request(format!("unknown triage_state `{s}`")),
        }
    }
    if let Some(deps) = body.depends_on {
        item.depends_on = deps.into_iter().filter(|d| !d.trim().is_empty()).collect();
    }
    item.description = body
        .description
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    match store.upsert(&item).await {
        Ok(()) => (StatusCode::CREATED, item_json(&item)).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PATCH /v1/requirements/:id ---------------------

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)]
    title: Option<String>,
    /// `Some("")` clears the description; `None` leaves it as-is.
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// Replaces the whole list when present. To append a single id
    /// without a round-trip use `POST /v1/requirements/:id/conversations`.
    #[serde(default)]
    conversation_ids: Option<Vec<String>>,
    /// Phase 3.6 — set / clear the assigned [`AgentProfile`]. The
    /// outer `Option<...>` distinguishes "field omitted" (None) from
    /// "field present"; the inner `Option<String>` distinguishes
    /// "set to X" from "clear" (`null`). Wire form:
    /// `{"assignee_id": "<uuid>"}` to set, `{"assignee_id": null}`
    /// to clear, or simply omit the key to leave as-is.
    #[serde(default, deserialize_with = "deserialize_optional_optional_string")]
    assignee_id: OptionalAssignee,
    /// Phase 6 — set / clear the per-requirement verification
    /// plan template that auto mode (and a future "Verify with
    /// pinned plan" UI button) reaches for. Same three-state
    /// semantics as `assignee_id`: omit ⇒ leave as-is, `null` ⇒
    /// clear, object ⇒ set.
    #[serde(default, deserialize_with = "deserialize_optional_plan")]
    verification_plan: OptionalPlan,
    /// v1.0 — set the triage gate. Omit to leave as-is. Wire form:
    /// one of `approved` / `proposed_by_agent` / `proposed_by_scan`.
    /// For triage approval / rejection prefer the dedicated
    /// `/v1/requirements/:id/approve` and `/reject` endpoints, which
    /// also write a structured Activity row.
    #[serde(default)]
    triage_state: Option<String>,
    /// v1.0 — replace the dependency list. Other requirement ids
    /// that must reach `done` before the auto executor will pick
    /// this one up. Omit to leave as-is; pass `[]` to clear.
    #[serde(default)]
    depends_on: Option<Vec<String>>,
}

/// Three-state value for `verification_plan` in PATCH —
/// mirror of [`OptionalAssignee`].
#[derive(Debug, Default)]
enum OptionalPlan {
    #[default]
    Missing,
    Clear,
    Set(VerificationPlan),
}

fn deserialize_optional_plan<'de, D>(de: D) -> Result<OptionalPlan, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt: Option<VerificationPlan> = Option::deserialize(de)?;
    Ok(match opt {
        Some(p) => OptionalPlan::Set(p),
        None => OptionalPlan::Clear,
    })
}

/// Three-state value for `assignee_id` in PATCH:
/// - `Missing`  — key absent, leave row as-is.
/// - `Clear`    — key present and `null`, clear the assignment.
/// - `Set(id)`  — key present and a string, assign that profile.
#[derive(Debug, Default)]
enum OptionalAssignee {
    #[default]
    Missing,
    Clear,
    Set(String),
}

fn deserialize_optional_optional_string<'de, D>(de: D) -> Result<OptionalAssignee, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // serde calls the `with` deserializer only when the key is
    // present, so `Missing` is set by `#[serde(default)]` above and
    // we just need to distinguish null vs string here.
    let opt: Option<String> = Option::deserialize(de)?;
    Ok(match opt {
        Some(s) => OptionalAssignee::Set(s),
        None => OptionalAssignee::Clear,
    })
}

async fn update_requirement(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("requirement `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    if let Some(t) = body.title {
        let trimmed = t.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`title` must not be blank");
        }
        item.title = trimmed;
    }
    if let Some(d) = body.description {
        item.description = if d.trim().is_empty() {
            None
        } else {
            Some(d.trim().to_string())
        };
    }
    let prior_status = item.status;
    if let Some(s) = body.status.as_deref() {
        match RequirementStatus::from_wire(s) {
            Some(parsed) => item.status = parsed,
            None => return bad_request(format!("unknown status `{s}`")),
        }
    }
    if let Some(ids) = body.conversation_ids {
        item.conversation_ids = ids;
    }
    let prior_assignee = item.assignee_id.clone();
    match body.assignee_id {
        OptionalAssignee::Missing => {}
        OptionalAssignee::Clear => item.assignee_id = None,
        OptionalAssignee::Set(s) => {
            let trimmed = s.trim().to_string();
            item.assignee_id = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
    }
    match body.verification_plan {
        OptionalPlan::Missing => {}
        OptionalPlan::Clear => item.verification_plan = None,
        OptionalPlan::Set(p) => item.verification_plan = Some(p),
    }
    let prior_triage = item.triage_state;
    if let Some(s) = body.triage_state.as_deref() {
        match TriageState::from_wire(s) {
            Some(parsed) => item.triage_state = parsed,
            None => return bad_request(format!("unknown triage_state `{s}`")),
        }
    }
    if let Some(deps) = body.depends_on {
        item.depends_on = deps.into_iter().filter(|d| !d.trim().is_empty()).collect();
    }
    item.touch();
    match store.upsert(&item).await {
        Ok(()) => {
            if item.status != prior_status {
                record_activity(
                    &state,
                    &item.id,
                    ActivityKind::StatusChange,
                    ActivityActor::Human,
                    json!({
                        "from": prior_status.as_wire(),
                        "to": item.status.as_wire(),
                    }),
                )
                .await;
            }
            if item.assignee_id != prior_assignee {
                record_activity(
                    &state,
                    &item.id,
                    ActivityKind::AssigneeChange,
                    ActivityActor::Human,
                    json!({
                        "from": prior_assignee,
                        "to": item.assignee_id,
                    }),
                )
                .await;
            }
            if item.triage_state != prior_triage {
                record_activity(
                    &state,
                    &item.id,
                    ActivityKind::Comment,
                    ActivityActor::Human,
                    json!({
                        "kind": "triage_change",
                        "from": prior_triage.as_wire(),
                        "to": item.triage_state.as_wire(),
                    }),
                )
                .await;
            }
            item_json(&item).into_response()
        }
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/requirements/:id/approve --------------
// ----------------------- POST /v1/requirements/:id/reject  --------------

#[derive(Debug, Deserialize, Default)]
struct RejectBody {
    /// User-readable reason for rejection. Required and non-blank;
    /// stored verbatim on the activity timeline so a future
    /// reviewer can tell why the candidate was discarded.
    #[serde(default)]
    reason: Option<String>,
}

async fn approve_requirement(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("requirement `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let prior = item.triage_state;
    if prior == TriageState::Approved {
        // Idempotent: already approved, no audit row, no upsert.
        return Json(json!({
            "approved": true,
            "requirement": item,
            "no_op": true
        }))
        .into_response();
    }
    item.triage_state = TriageState::Approved;
    item.touch();
    if let Err(e) = store.upsert(&item).await {
        return internal_error(e);
    }
    record_activity(
        &state,
        &item.id,
        ActivityKind::Comment,
        ActivityActor::Human,
        json!({
            "kind": "approved",
            "from": prior.as_wire(),
            "to": item.triage_state.as_wire(),
        }),
    )
    .await;
    Json(json!({ "approved": true, "requirement": item })).into_response()
}

async fn reject_requirement(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RejectBody>,
) -> Response {
    let reason = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(reason) = reason else {
        return bad_request("`reason` must not be blank");
    };
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("requirement `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let prior = item.triage_state;
    // Reject = soft-discard. We do NOT set status=Done (that is the
    // human-only acceptance gate); instead we leave the kanban
    // status alone and only flip the triage row out of the queue
    // by deleting it. The structured reason lives on the audit
    // store of the parent project, addressable by the deleted id —
    // future "Recently Rejected" UI can replay this.
    record_activity(
        &state,
        &item.id,
        ActivityKind::Comment,
        ActivityActor::Human,
        json!({
            "kind": "rejected",
            "reason": reason,
            "from": prior.as_wire(),
        }),
    )
    .await;
    let project_id_for_log = item.project_id.clone();
    let title_for_log = std::mem::take(&mut item.title);
    drop(item);
    match store.delete(&id).await {
        Ok(deleted) => {
            info!(
                requirement_id = %id,
                project_id = %project_id_for_log,
                title = %title_for_log,
                reason = %reason,
                "rejected triage candidate"
            );
            Json(json!({ "rejected": true, "deleted": deleted, "reason": reason })).into_response()
        }
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/requirements/:id/conversations ---------

#[derive(Debug, Deserialize)]
struct LinkConversationBody {
    conversation_id: String,
}

async fn link_conversation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<LinkConversationBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let conv_id = body.conversation_id.trim().to_string();
    if conv_id.is_empty() {
        return bad_request("`conversation_id` must not be blank");
    }
    let mut item = match store.get(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("requirement `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let appended = item.link_conversation(conv_id);
    if appended {
        if let Err(e) = store.upsert(&item).await {
            return internal_error(e);
        }
    }
    Json(json!({ "appended": appended, "requirement": item })).into_response()
}

// ----------------------- DELETE /v1/requirements/:id ---------------------

async fn delete_requirement(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "deleted": false, "error": format!("requirement `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

fn item_json(item: &Requirement) -> Json<Value> {
    Json(serde_json::to_value(item).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// ----------------------- POST /v1/requirements/:id/runs -----------------

/// Start a fresh-session run against `requirement`.
///
/// The flow is intentionally minimal in v0:
///
/// 1. Load the requirement (404 if missing).
/// 2. Build a [`RequirementContextManifest`] rooted at the server's
///    pinned workspace (or the workspace path captured on
///    [`AppState`] if set).
/// 3. Mint a fresh [`Conversation`] whose first system message is
///    the rendered manifest summary, save it to the conversation
///    store with metadata.
/// 4. Append the new `conversation_id` to
///    `requirement.conversation_ids` (idempotent).
/// 5. If the requirement is in `Backlog`, transition to
///    `InProgress`.
/// 6. Return a typed [`RequirementRun`] in the `Pending` state plus
///    the manifest summary so the UI can show "manifest applied,
///    waiting on first model turn".
///
/// **What this does NOT do** (deliberately, for v0): it does not
/// invoke the agent loop here. The client opens a WS / SSE on the
/// returned `conversation_id` to drive the actual run. That keeps
/// the handler synchronous and side-effect-light; long-running
/// orchestration belongs to the chat WS code path.
async fn start_run(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let req_store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let convo_store = match state.store.clone() {
        Some(s) => s,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "conversation store not configured" })),
            )
                .into_response()
        }
    };

    // 1. Load requirement.
    let mut requirement = match req_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("requirement `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };

    // 2. Build manifest. Use the server's pinned workspace root;
    // when none is configured fall back to the current process cwd
    // (test harnesses typically don't pin one but still want the
    // endpoint to behave deterministically).
    let workspace = state
        .workspace_root
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
    let manifest = build_default_manifest(&workspace, &requirement).await;
    let summary = render_manifest_summary(&manifest);

    // 2.5 (Phase 3.6). If the requirement is assigned, look up
    // the AgentProfile and prepend its `system_prompt` to the
    // manifest. Look-up failures (missing profile, store glitch)
    // are non-fatal: we WARN and run with the bare manifest
    // rather than blocking the user-visible action.
    let assignee_prompt = match (
        requirement.assignee_id.as_deref(),
        state.agent_profiles.as_ref(),
    ) {
        (Some(aid), Some(prof_store)) => match prof_store.get(aid).await {
            Ok(Some(p)) => p.system_prompt.clone(),
            Ok(None) => {
                warn!(
                    requirement_id = %requirement.id,
                    assignee_id = %aid,
                    "requirement assignee profile not found; running without it",
                );
                None
            }
            Err(e) => {
                warn!(error = %e, "agent profile lookup failed on start_run");
                None
            }
        },
        _ => None,
    };
    let composed_summary = match assignee_prompt.as_deref() {
        Some(prompt) if !prompt.trim().is_empty() => {
            format!("=== assignee instructions ===\n{}\n\n{}", prompt.trim(), summary)
        }
        _ => summary.clone(),
    };

    // 3. Mint fresh conversation. The system message is the
    // (possibly assignee-prefixed) manifest summary; the
    // user-side first turn arrives later via WS / REST messages
    // on the conversation.
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut conv = Conversation::new();
    conv.push(Message::system(composed_summary));
    let metadata = ConversationMetadata {
        project_id: Some(requirement.project_id.clone()),
    };
    if let Err(e) = convo_store
        .save_envelope(&conversation_id, &conv, &metadata)
        .await
    {
        return internal_error(e);
    }

    // 4. Link conversation_id back to the requirement.
    let appended = requirement.link_conversation(conversation_id.clone());
    // 5. Auto-advance Backlog → InProgress.
    let advanced = if requirement.status == RequirementStatus::Backlog {
        requirement.status = RequirementStatus::InProgress;
        requirement.touch();
        true
    } else {
        false
    };
    if appended || advanced {
        if let Err(e) = req_store.upsert(&requirement).await {
            return internal_error(e);
        }
    }

    // 6. Mint a typed Pending run record. When a
    // `RequirementRunStore` is configured the row is persisted
    // (and the WS bridge fans out a `requirement_run_started`
    // frame). The persistence failure is a WARN, not an error —
    // losing the response because we couldn't write a telemetry
    // row would be strictly worse than serving the response and
    // continuing.
    let mut run = RequirementRun::new(requirement.id.clone(), conversation_id.clone());

    // Phase 5 — when worktree mode is `PerRun`, mint a fresh
    // git worktree at `<root>/<run_id>`. Refusal (non-git
    // workspace, dirty checkout, etc.) is logged at INFO and
    // the run continues without `worktree_path` set; the user
    // sees the cause in the server log, the run still works
    // (just against the main checkout).
    if state.worktree_mode == crate::worktree::WorktreeMode::PerRun {
        if let Some(root) = state.worktree_root.as_ref() {
            let outcome = crate::worktree::create_worktree(
                &workspace,
                root,
                &run.id,
                !state.worktree_allow_dirty,
            )
            .await;
            match outcome {
                crate::worktree::WorktreeOutcome::Created(p) => {
                    run.worktree_path = Some(p.display().to_string());
                }
                crate::worktree::WorktreeOutcome::Refused(reason) => {
                    info!(run_id = %run.id, reason = %reason, "worktree creation refused; using main checkout");
                }
            }
        }
    }

    if let Some(run_store) = state.requirement_runs.as_ref() {
        if let Err(e) = run_store.upsert(&run).await {
            warn!(error = %e, run_id = %run.id, "failed to persist RequirementRun on start_run");
        }
    }

    // 7. Audit trail. The Backlog→InProgress auto-advance counts
    // as a System actor (no human dragged the card); the run
    // start itself is attributed to Human (a REST POST always
    // implies a human-driven action in v0).
    if advanced {
        record_activity(
            &state,
            &requirement.id,
            ActivityKind::StatusChange,
            ActivityActor::System,
            json!({
                "from": "backlog",
                "to": "in_progress",
                "reason": "run_started",
            }),
        )
        .await;
    }
    record_activity(
        &state,
        &requirement.id,
        ActivityKind::RunStarted,
        ActivityActor::Human,
        json!({
            "run_id": run.id,
            "conversation_id": conversation_id,
        }),
    )
    .await;

    let body = json!({
        "run": run,
        "conversation_id": conversation_id,
        "manifest_summary": summary,
        "requirement": requirement,
    });
    (StatusCode::CREATED, Json(body)).into_response()
}

// ----------------------- GET /v1/requirements/:id/activities ------------

async fn list_activities(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let act_store = match require_activity_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match act_store.list_for_requirement(&id).await {
        Ok(items) => Json(json!({ "requirement_id": id, "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/requirements/:id/runs ------------------

async fn list_runs(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match run_store.list_for_requirement(&id).await {
        Ok(runs) => Json(json!({ "requirement_id": id, "items": runs })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/runs/:id -------------------------------

async fn get_run(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match run_store.get(&id).await {
        Ok(Some(run)) => run_json(&run).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("run `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PATCH /v1/runs/:id -----------------------------

#[derive(Debug, Deserialize)]
struct UpdateRunBody {
    /// Wire form (`pending` / `running` / `completed` / `failed` /
    /// `cancelled`). When absent the existing status is kept.
    #[serde(default)]
    status: Option<String>,
    /// `Some("")` clears the field; `None` leaves it as-is.
    #[serde(default)]
    summary: Option<String>,
    /// `Some("")` clears the field; `None` leaves it as-is.
    #[serde(default)]
    error: Option<String>,
    /// RFC-3339 timestamp. When provided, replaces the current
    /// value; when absent and the patch flips the row to a
    /// terminal status, the server stamps `now()`.
    #[serde(default)]
    finished_at: Option<String>,
}

async fn update_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateRunBody>,
) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut run = match run_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("run `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let was_terminal = run.status.is_terminal();
    if let Some(s) = body.status.as_deref() {
        match RequirementRunStatus::from_wire(s) {
            Some(parsed) => {
                if parsed.is_terminal() && !run.status.is_terminal() {
                    // Use the type's own `finish` so finished_at is
                    // stamped consistently (callers can override
                    // afterwards with the explicit field).
                    run.finish(parsed);
                } else {
                    run.status = parsed;
                }
            }
            None => return bad_request(format!("unknown run status `{s}`")),
        }
    }
    if let Some(s) = body.summary {
        run.summary = if s.trim().is_empty() {
            None
        } else {
            Some(s.trim().to_string())
        };
    }
    if let Some(e) = body.error {
        run.error = if e.trim().is_empty() {
            None
        } else {
            Some(e.trim().to_string())
        };
    }
    if let Some(ts) = body.finished_at {
        run.finished_at = if ts.trim().is_empty() {
            None
        } else {
            Some(ts)
        };
    }
    if let Err(e) = run_store.upsert(&run).await {
        return internal_error(e);
    }
    // Activity: RunFinished only on the terminal transition (not
    // on every patch — summary tweaks shouldn't spam the timeline).
    if !was_terminal && run.status.is_terminal() {
        record_activity(
            &state,
            &run.requirement_id,
            ActivityKind::RunFinished,
            ActivityActor::Human,
            json!({
                "run_id": run.id,
                "status": run.status.as_wire(),
            }),
        )
        .await;
    }
    run_json(&run).into_response()
}

// ----------------------- POST /v1/runs/:id/verification -----------------

async fn set_run_verification(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(result): Json<VerificationResult>,
) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let run = match run_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("run `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    apply_verification(&state, &run, result, run_store).await
}

fn run_json(run: &RequirementRun) -> Json<Value> {
    Json(serde_json::to_value(run).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// ----------------------- POST /v1/runs/:id/verify -----------------------

/// Phase 4 — auto-execute a [`VerificationPlan`] and write the
/// result back to the run.
///
/// The flow:
///
/// 1. Resolve the run (404 if absent).
/// 2. Build a [`VerificationPlan`] from the request body. Empty
///    body / no `commands` ⇒ 400 (no point running an empty plan
///    via this endpoint; the caller should hit `/verification`
///    directly with a manually-built result if they want that).
/// 3. Execute every command via [`crate::verification::execute_plan`]
///    inside the server's pinned workspace root (or `cwd`
///    fallback). This blocks the request until the plan finishes,
///    matching the existing "POST /verification returns the result"
///    contract.
/// 4. Reuse the existing `set_run_verification` machinery to
///    persist + broadcast: same Activity / WS frames, same
///    pass→Completed / fail→Failed terminal-status mapping.
async fn verify_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<VerifyBody>,
) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let run = match run_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("run `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let plan = VerificationPlan {
        commands: body.commands,
        require_diff: body.require_diff.unwrap_or(false),
        require_tests: body.require_tests.unwrap_or(false),
        require_human_review: body.require_human_review.unwrap_or(false),
    };
    if plan.commands.is_empty() {
        return bad_request(
            "`commands` must not be empty; POST /verification directly to attach a result \
             without running anything",
        );
    }
    // Phase 5 — when the run minted a git worktree, route the
    // verification cwd through it instead of the main checkout
    // so commands that mutate files / commits / install deps
    // don't trash the user's working tree. Falls back to the
    // workspace root when worktree_path is absent.
    let workspace = if let Some(wt) = run.worktree_path.as_deref() {
        std::path::PathBuf::from(wt)
    } else {
        state
            .workspace_root
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")))
    };
    let timeout_ms = body.timeout_ms.unwrap_or(crate::verification::DEFAULT_TIMEOUT_MS);
    let result = crate::verification::execute_plan(&workspace, &plan, timeout_ms).await;

    // Reuse the existing set_run_verification path so the
    // bookkeeping (terminal flip, Verified frame, RunFinished
    // activity, etc.) stays in one place.
    apply_verification(&state, &run, result, run_store).await
}

#[derive(Debug, Deserialize)]
struct VerifyBody {
    /// Shell commands to run, in order. Each runs `sh -c <cmd>`
    /// (or `cmd /C` on Windows) inside the server's workspace
    /// root. The first non-zero exit makes the aggregate `Failed`.
    commands: Vec<String>,
    /// Per-command timeout. Defaults to the same 30s budget
    /// `shell.exec` uses.
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    require_diff: Option<bool>,
    #[serde(default)]
    require_tests: Option<bool>,
    /// When true, a clean run becomes [`VerificationStatus::NeedsReview`]
    /// instead of `Passed` — the run still flips terminal but the
    /// requirement-level "done" decision waits on a human.
    #[serde(default)]
    require_human_review: Option<bool>,
}

// ----------------------- DELETE /v1/runs/:id/worktree -------------------

/// Phase 5 — `git worktree remove --force` on the run's
/// `worktree_path`, then clear the field on the row. Idempotent:
/// missing run ⇒ 404, missing worktree (already cleaned) ⇒
/// `{deleted: false}` 200, run with no `worktree_path` ⇒
/// `{deleted: false}` 200 (nothing to do).
async fn delete_worktree(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let run_store = match require_run_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut run = match run_store.get(&id).await {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("run `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    let Some(path) = run.worktree_path.clone() else {
        return Json(json!({ "deleted": false, "reason": "no worktree on this run" })).into_response();
    };
    let Some(root) = state.worktree_root.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "worktree feature not configured" })),
        )
            .into_response();
    };
    let workspace = state
        .workspace_root
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
    let result = crate::worktree::remove_worktree(
        &workspace,
        root,
        std::path::Path::new(&path),
    )
    .await;
    match result {
        Ok(()) => {
            run.worktree_path = None;
            if let Err(e) = run_store.upsert(&run).await {
                warn!(error = %e, run_id = %run.id, "worktree removed on disk but run upsert failed");
            }
            Json(json!({ "deleted": true, "path": path })).into_response()
        }
        Err(reason) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "deleted": false, "error": reason })),
        )
            .into_response(),
    }
}

/// Shared "attach + broadcast" helper. Used by both
/// [`set_run_verification`] (caller already computed the result)
/// and [`verify_run`] (we just computed it).
async fn apply_verification(
    state: &AppState,
    existing: &RequirementRun,
    result: VerificationResult,
    run_store: Arc<dyn RequirementRunStore>,
) -> Response {
    let mut run = existing.clone();
    let was_terminal = run.status.is_terminal();
    if !run.status.is_terminal() {
        match result.status {
            VerificationStatus::Passed => run.finish(RequirementRunStatus::Completed),
            VerificationStatus::Failed => run.finish(RequirementRunStatus::Failed),
            VerificationStatus::NeedsReview | VerificationStatus::Skipped => {}
        }
    }
    run.verification = Some(result.clone());
    if let Err(e) = run_store.upsert(&run).await {
        return internal_error(e);
    }
    run_store.broadcast(RequirementRunEvent::Verified {
        run_id: run.id.clone(),
        result: result.clone(),
    });
    record_activity(
        state,
        &run.requirement_id,
        ActivityKind::VerificationFinished,
        ActivityActor::System,
        json!({
            "run_id": run.id,
            "status": result.status.as_wire(),
        }),
    )
    .await;
    if !was_terminal && run.status.is_terminal() {
        record_activity(
            state,
            &run.requirement_id,
            ActivityKind::RunFinished,
            ActivityActor::System,
            json!({
                "run_id": run.id,
                "status": run.status.as_wire(),
                "reason": "verification",
            }),
        )
        .await;
    }
    run_json(&run).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_store::MemoryRequirementStore;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Stub LLM — `AppState::new` needs one. Requirement routes don't
    /// touch the agent.
    struct StubLlm;
    #[async_trait::async_trait]
    impl harness_core::LlmProvider for StubLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    fn base_state() -> AppState {
        use harness_core::{Agent, AgentConfig};
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent)
    }

    fn state_with_store() -> AppState {
        let store: Arc<dyn RequirementStore> = Arc::new(MemoryRequirementStore::new());
        base_state().with_requirement_store(store)
    }

    fn app(state: AppState) -> axum::Router {
        super::router().with_state(state)
    }

    async fn read_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn returns_503_when_store_absent() {
        let resp = app(base_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p/requirements")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_then_list_round_trip() {
        let app = app(state_with_store());

        // Create.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p1/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"title":"ship the kanban","description":"build it"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        assert_eq!(v["title"], "ship the kanban");
        assert_eq!(v["status"], "backlog");
        assert_eq!(v["project_id"], "p1");
        let id = v["id"].as_str().unwrap().to_string();

        // List.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p1/requirements")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 1);

        // Patch (move to review).
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/requirements/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"review"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["status"], "review");

        // Link a conversation.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{id}/conversations"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"conversation_id":"c1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["appended"], true);
        assert_eq!(v["requirement"]["conversation_ids"][0], "c1");

        // Delete.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/requirements/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Second delete → 404.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/requirements/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_rejects_blank_title() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_unknown_id_returns_404() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/requirements/no-such-id")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    // ---- Triage routes -------------------------------------------------

    async fn seed_proposed(state: &AppState, project_id: &str, title: &str) -> String {
        let store = state.requirements.as_ref().unwrap().clone();
        let mut req = Requirement::new(project_id, title);
        req.triage_state = TriageState::ProposedByAgent;
        store.upsert(&req).await.unwrap();
        req.id
    }

    #[tokio::test]
    async fn list_filters_by_triage_state() {
        let state = state_with_store();
        // Two proposed + one approved.
        seed_proposed(&state, "p1", "scan finding 1").await;
        seed_proposed(&state, "p1", "agent follow-up").await;
        let approved_id = {
            let store = state.requirements.as_ref().unwrap().clone();
            let req = Requirement::new("p1", "user-confirmed work");
            store.upsert(&req).await.unwrap();
            req.id
        };

        // No filter → all 3.
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p1/requirements")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 3);

        // proposed (synthetic, both proposed_by_*) → 2.
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p1/requirements?triage_state=proposed")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 2);

        // approved → 1.
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p1/requirements?triage_state=approved")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], approved_id);
    }

    #[tokio::test]
    async fn list_rejects_unknown_triage_filter() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .uri("/v1/projects/p/requirements?triage_state=zomg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn approve_flips_triage_state_and_records_activity() {
        let (state, _, act_store) = state_with_activities();
        let id = seed_proposed(&state, "p", "candidate").await;
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{id}/approve"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["approved"], true);
        // After approve, triage_state is the default (Approved) and
        // skip_serializing_if drops it from the wire.
        assert!(v["requirement"].get("triage_state").is_none());

        let stored = state
            .requirements
            .as_ref()
            .unwrap()
            .get(&id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.triage_state, TriageState::Approved);

        let acts = act_store.list_for_requirement(&id).await.unwrap();
        assert!(
            acts.iter().any(|a| a.body["kind"] == "approved"),
            "expected an approved activity, got {acts:?}"
        );
    }

    #[tokio::test]
    async fn approve_already_approved_is_no_op() {
        let state = state_with_store();
        let store = state.requirements.as_ref().unwrap().clone();
        let req = Requirement::new("p", "already approved");
        store.upsert(&req).await.unwrap();
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{}/approve", req.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["no_op"], true);
    }

    #[tokio::test]
    async fn reject_records_reason_and_deletes_row() {
        let (state, _, act_store) = state_with_activities();
        let id = seed_proposed(&state, "p", "bad candidate").await;
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{id}/reject"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":"out of scope for v1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["rejected"], true);
        assert_eq!(v["deleted"], true);

        // Row gone from store.
        assert!(state
            .requirements
            .as_ref()
            .unwrap()
            .get(&id)
            .await
            .unwrap()
            .is_none());

        // Reason landed on the activity timeline (we appended *before*
        // deletion so the row is addressable by the now-orphaned id).
        let acts = act_store.list_for_requirement(&id).await.unwrap();
        let rejected = acts
            .iter()
            .find(|a| a.body["kind"] == "rejected")
            .expect("rejected activity");
        assert_eq!(rejected.body["reason"], "out of scope for v1");
    }

    #[tokio::test]
    async fn reject_blank_reason_is_400() {
        let state = state_with_store();
        let id = seed_proposed(&state, "p", "x").await;
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{id}/reject"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"reason":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn create_with_explicit_triage_and_depends_on() {
        let state = state_with_store();
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"title":"x","triage_state":"proposed_by_scan","depends_on":["a","b"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        assert_eq!(v["triage_state"], "proposed_by_scan");
        assert_eq!(v["depends_on"], serde_json::json!(["a", "b"]));
    }

    // ---- POST /runs ----------------------------------------------------

    use harness_store::{
        MemoryActivityStore, MemoryConversationStore, MemoryProjectStore,
        MemoryRequirementRunStore,
    };

    fn state_with_runs() -> AppState {
        let req_store: Arc<dyn RequirementStore> = Arc::new(MemoryRequirementStore::new());
        let convo_store: Arc<dyn harness_core::ConversationStore> =
            Arc::new(MemoryConversationStore::new());
        let proj_store: Arc<dyn harness_core::ProjectStore> = Arc::new(MemoryProjectStore::new());
        base_state()
            .with_requirement_store(req_store)
            .with_store(convo_store)
            .with_project_store(proj_store)
    }

    fn state_with_run_store() -> (AppState, Arc<dyn RequirementRunStore>) {
        let run_store: Arc<dyn RequirementRunStore> = Arc::new(MemoryRequirementRunStore::new());
        let state = state_with_runs().with_run_store(Arc::clone(&run_store));
        (state, run_store)
    }

    fn state_with_activities() -> (
        AppState,
        Arc<dyn RequirementRunStore>,
        Arc<dyn ActivityStore>,
    ) {
        let act_store: Arc<dyn ActivityStore> = Arc::new(MemoryActivityStore::new());
        let (state, run_store) = state_with_run_store();
        (state.with_activity_store(Arc::clone(&act_store)), run_store, act_store)
    }

    #[tokio::test]
    async fn start_run_returns_503_without_conversation_store() {
        // Have a requirement store but no conversation store.
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/requirements/whatever/runs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn start_run_creates_conversation_links_back_and_advances_status() {
        let state = state_with_runs();
        let app = app(state.clone());

        // Seed a requirement to start a run on.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/proj-7/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"ship the kanban"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        let req_id = v["id"].as_str().unwrap().to_string();

        // Start a run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        let conv_id = v["conversation_id"].as_str().unwrap().to_string();
        assert!(!conv_id.is_empty());
        assert_eq!(v["run"]["status"], "pending");
        assert_eq!(v["run"]["requirement_id"], req_id);
        assert_eq!(v["run"]["conversation_id"], conv_id);
        // Manifest summary should reference the goal.
        assert!(v["manifest_summary"]
            .as_str()
            .unwrap()
            .contains("ship the kanban"));
        // Requirement should have flipped to in_progress.
        assert_eq!(v["requirement"]["status"], "in_progress");
        assert_eq!(
            v["requirement"]["conversation_ids"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // Conversation persisted with a system message holding the
        // manifest summary.
        let saved = state.store.unwrap().load(&conv_id).await.unwrap().unwrap();
        assert_eq!(saved.messages.len(), 1);
        match &saved.messages[0] {
            harness_core::Message::System { content, .. } => {
                assert!(content.contains("ship the kanban"));
            }
            other => panic!("expected System, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn start_run_unknown_requirement_returns_404() {
        let resp = app(state_with_runs())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/requirements/no-such-id/runs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    // ---- run store wiring ---------------------------------------------

    #[tokio::test]
    async fn start_run_persists_run_when_store_configured() {
        let (state, run_store) = state_with_run_store();
        let app = app(state.clone());

        // Seed a requirement.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/proj/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"persist a run"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        let req_id = v["id"].as_str().unwrap().to_string();

        // Start a run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        let run_id = v["run"]["id"].as_str().unwrap().to_string();

        // Run should be persisted in the store.
        let stored = run_store.get(&run_id).await.unwrap().unwrap();
        assert_eq!(stored.requirement_id, req_id);
        assert_eq!(stored.status.as_wire(), "pending");

        // List API returns the same run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["id"].as_str().unwrap(), run_id);
    }

    #[tokio::test]
    async fn start_run_without_run_store_still_returns_pending() {
        let app = app(state_with_runs());

        // Seed.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        let req_id = v["id"].as_str().unwrap().to_string();

        // Start a run — should still respond 201 even though no run
        // store is wired up.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // List endpoint returns 503 because the run store is absent.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn patch_run_flips_to_terminal_and_emits_finished() {
        let (state, run_store) = state_with_run_store();
        let app = app(state.clone());
        let mut rx = run_store.subscribe();

        // Seed requirement + run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        // Drain the Started event.
        let _ = rx.recv().await.unwrap();

        // PATCH to completed.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/runs/{run_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"status":"completed","summary":"all green"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["status"], "completed");
        assert_eq!(v["summary"], "all green");
        assert!(v["finished_at"].is_string());

        // The store should fan out a Finished event.
        match rx.recv().await.unwrap() {
            harness_core::RequirementRunEvent::Finished(run) => {
                assert_eq!(run.id, run_id);
                assert_eq!(run.status.as_wire(), "completed");
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    // ---- activity timeline ---------------------------------------------

    #[tokio::test]
    async fn list_activities_returns_503_without_store() {
        let resp = app(state_with_run_store().0)
            .oneshot(
                Request::builder()
                    .uri("/v1/requirements/whatever/activities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn start_run_appends_run_started_and_status_change_activities() {
        let (state, _run_store, act_store) = state_with_activities();
        let app = app(state.clone());

        // Seed.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();

        // start_run.
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let acts = act_store.list_for_requirement(&req_id).await.unwrap();
        // Backlog→InProgress auto-advance + RunStarted, newest first
        // (RunStarted append happens after StatusChange, so it has
        // the later timestamp).
        assert_eq!(acts.len(), 2);
        assert_eq!(acts[0].kind, harness_core::ActivityKind::RunStarted);
        assert_eq!(acts[1].kind, harness_core::ActivityKind::StatusChange);
        // System actor on the auto-advance, Human on the run start.
        assert_eq!(acts[1].actor, harness_core::ActivityActor::System);
        assert_eq!(acts[0].actor, harness_core::ActivityActor::Human);
    }

    #[tokio::test]
    async fn list_activities_returns_recorded_rows() {
        let (state, _run_store, _act_store) = state_with_activities();
        let app = app(state.clone());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();

        // Drive a status change directly to record an activity.
        app.clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/requirements/{req_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"review"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/requirements/{req_id}/activities"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["kind"], "status_change");
        assert_eq!(items[0]["body"]["from"], "backlog");
        assert_eq!(items[0]["body"]["to"], "review");
    }

    #[tokio::test]
    async fn verification_records_verification_finished_and_run_finished() {
        let (state, _run_store, act_store) = state_with_activities();
        let app = app(state.clone());

        // Seed + start a run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        // Pass-verify the run → both VerificationFinished and
        // RunFinished should land in the timeline.
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/runs/{run_id}/verification"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"status":"passed","command_results":[]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let acts = act_store.list_for_requirement(&req_id).await.unwrap();
        let kinds: Vec<&str> = acts
            .iter()
            .map(|a| match a.kind {
                harness_core::ActivityKind::StatusChange => "status",
                harness_core::ActivityKind::RunStarted => "run_started",
                harness_core::ActivityKind::RunFinished => "run_finished",
                harness_core::ActivityKind::VerificationFinished => "verify",
                _ => "other",
            })
            .collect();
        assert!(
            kinds.contains(&"verify"),
            "expected VerificationFinished in {kinds:?}"
        );
        assert!(
            kinds.contains(&"run_finished"),
            "expected RunFinished in {kinds:?}"
        );
    }

    // ---- Phase 4 — auto-verify executor --------------------------------

    #[tokio::test]
    #[cfg(unix)]
    async fn verify_route_runs_commands_and_marks_completed_on_pass() {
        let (state, _, act_store) = state_with_activities();
        let app = app(state.clone());

        // Seed + start a run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        // Run two passing commands. /verify should execute them
        // and flip the run terminal.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/runs/{run_id}/verify"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"commands":["true","echo hi"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["status"], "completed");
        assert_eq!(v["verification"]["status"], "passed");
        let cmd_results = v["verification"]["command_results"].as_array().unwrap();
        assert_eq!(cmd_results.len(), 2);
        assert_eq!(cmd_results[0]["exit_code"], 0);
        assert_eq!(cmd_results[1]["exit_code"], 0);
        assert!(cmd_results[1]["stdout"].as_str().unwrap().contains("hi"));

        // Activity should include verification_finished + run_finished.
        let acts = act_store.list_for_requirement(&req_id).await.unwrap();
        let kinds: Vec<_> = acts.iter().map(|a| a.kind).collect();
        assert!(kinds.contains(&harness_core::ActivityKind::VerificationFinished));
        assert!(kinds.contains(&harness_core::ActivityKind::RunFinished));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn verify_route_marks_failed_on_nonzero_exit() {
        let (state, _, _) = state_with_activities();
        let app = app(state.clone());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/runs/{run_id}/verify"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"commands":["true","false"]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["verification"]["status"], "failed");
        assert_eq!(v["status"], "failed");
    }

    #[tokio::test]
    async fn verify_route_returns_400_on_empty_commands() {
        let (state, _, _) = state_with_activities();
        let app = app(state.clone());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runs/never/verify")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"commands":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        // /verify resolves the run before validating commands, so a
        // missing run id 404s before the empty-commands check —
        // make a real run first to exercise the 400 path.
        assert!(matches!(resp.status(), StatusCode::NOT_FOUND));
    }

    #[tokio::test]
    async fn verify_route_returns_400_on_empty_commands_real_run() {
        let (state, _, _) = state_with_activities();
        let app = app(state.clone());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/runs/{run_id}/verify"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"commands":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn verification_attaches_result_and_emits_verified_frame() {
        let (state, run_store) = state_with_run_store();
        let app = app(state.clone());
        let mut rx = run_store.subscribe();

        // Seed requirement + run.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/projects/p/requirements")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let req_id = read_json(resp).await["id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/requirements/{req_id}/runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let run_id = read_json(resp).await["run"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let _ = rx.recv().await.unwrap(); // Drain Started.

        // Post a passed verification result.
        let body = r#"{
            "status":"passed",
            "command_results":[{"command":"cargo test","exit_code":0,"stdout":"ok","stderr":"","duration_ms":100}]
        }"#;
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/runs/{run_id}/verification"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["verification"]["status"], "passed");
        // Passed verification on a non-terminal run flips it to
        // Completed.
        assert_eq!(v["status"], "completed");

        // Two events expected: Finished (status flipped) and
        // Verified (broadcast). Order: Finished first (from the
        // upsert classifier) then Verified (explicit broadcast).
        let mut saw_finished = false;
        let mut saw_verified = false;
        for _ in 0..2 {
            match rx.recv().await.unwrap() {
                harness_core::RequirementRunEvent::Finished(_) => saw_finished = true,
                harness_core::RequirementRunEvent::Verified { run_id: id, .. } => {
                    assert_eq!(id, run_id);
                    saw_verified = true;
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert!(saw_finished, "missing Finished event");
        assert!(saw_verified, "missing Verified event");
    }
}
