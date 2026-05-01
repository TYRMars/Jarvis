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
//!   conversation store; returns 503 otherwise.
//! - `DELETE /v1/requirements/:id`
//!   — remove
//!
//! WS clients subscribe via the existing chat socket; the broadcast
//! bridge in `routes.rs` filters [`RequirementEvent`]s and forwards as
//! `requirement_upserted` / `requirement_deleted` frames.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch, post},
    Router,
};
use harness_core::{
    Conversation, ConversationMetadata, Message, Requirement, RequirementStatus, RequirementStore,
};
use harness_requirement::{build_default_manifest, render_manifest_summary, RequirementRun};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

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
        .route(
            "/v1/requirements/:id/conversations",
            post(link_conversation),
        )
        .route("/v1/requirements/:id/runs", post(start_run))
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

async fn list_requirements(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list(&project_id).await {
        Ok(items) => Json(json!({ "project_id": project_id, "items": items })).into_response(),
        Err(e) => internal_error(e),
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
    /// `Some("")` clears the assignee; `Some(id)` sets it; `None`
    /// leaves it alone. Cross-validation against `AgentProfileStore`
    /// is intentionally not done here — a deleted profile id leaves a
    /// dangling pointer that the UI renders as "(unknown agent)"
    /// rather than failing the patch.
    #[serde(default)]
    assignee_id: Option<String>,
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
    if let Some(s) = body.status.as_deref() {
        match RequirementStatus::from_wire(s) {
            Some(parsed) => item.status = parsed,
            None => return bad_request(format!("unknown status `{s}`")),
        }
    }
    if let Some(ids) = body.conversation_ids {
        item.conversation_ids = ids;
    }
    if let Some(a) = body.assignee_id {
        let trimmed = a.trim().to_string();
        item.assignee_id = if trimmed.is_empty() { None } else { Some(trimmed) };
    }
    item.touch();
    match store.upsert(&item).await {
        Ok(()) => item_json(&item).into_response(),
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

    // 3. Mint fresh conversation. The system message is the
    // manifest summary; the user-side first turn arrives later via
    // WS / REST messages on the conversation.
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut conv = Conversation::new();
    conv.push(Message::system(summary.clone()));
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

    // 6. Return a typed Pending run record. (Persisting the run
    // itself is a follow-up — v0 derives runs from
    // `requirement.conversation_ids`; the typed shape is returned
    // so clients can display it without a second round-trip.)
    let run = RequirementRun::new(requirement.id.clone(), conversation_id.clone());

    let body = json!({
        "run": run,
        "conversation_id": conversation_id,
        "manifest_summary": summary,
        "requirement": requirement,
    });
    (StatusCode::CREATED, Json(body)).into_response()
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

    // ---- POST /runs ----------------------------------------------------

    use harness_store::{MemoryConversationStore, MemoryProjectStore};

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
}
