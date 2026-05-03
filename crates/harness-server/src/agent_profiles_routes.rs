//! REST routes for named [`AgentProfile`](harness_core::AgentProfile)s.
//!
//! Process-wide CRUD; mounted only when [`AppState::agent_profiles`]
//! is set. Returns `503` otherwise — same convention as
//! `/v1/requirements`, `/v1/todos`, etc.
//!
//! Endpoints:
//!
//! - `GET    /v1/agent-profiles`         — list, sorted by name asc
//! - `POST   /v1/agent-profiles`         — create (body: `{name, provider, model, ...}`)
//! - `GET    /v1/agent-profiles/:id`     — fetch one (404 if missing)
//! - `PATCH  /v1/agent-profiles/:id`     — partial update (any subset of editable fields)
//! - `DELETE /v1/agent-profiles/:id`     — remove (idempotent: 404 if absent)
//!
//! WS sessions subscribe via the existing chat socket; the
//! broadcast bridge in `routes.rs` filters
//! [`AgentProfileEvent`](harness_core::AgentProfileEvent)s and
//! forwards as `agent_profile_upserted` / `agent_profile_deleted`
//! frames.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch},
    Router,
};
use harness_core::{AgentProfile, AgentProfileStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/agent-profiles", get(list).post(create))
        .route(
            "/v1/agent-profiles/:id",
            patch(update).delete(remove).get(fetch),
        )
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn AgentProfileStore>, Response> {
    state.agent_profiles.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "agent profile store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "agent profile store error");
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

fn profile_json(p: &AgentProfile) -> Json<Value> {
    Json(serde_json::to_value(p).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// ----------------------- GET /v1/agent-profiles -------------------------

async fn list(State(state): State<AppState>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list().await {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/agent-profiles ------------------------

#[derive(Debug, Deserialize)]
struct CreateBody {
    name: String,
    provider: String,
    model: String,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    default_workspace: Option<String>,
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

async fn create(State(state): State<AppState>, Json(body): Json<CreateBody>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return bad_request("`name` must not be blank");
    }
    let provider = body.provider.trim().to_string();
    if provider.is_empty() {
        return bad_request("`provider` must not be blank");
    }
    let model = body.model.trim().to_string();
    if model.is_empty() {
        return bad_request("`model` must not be blank");
    }
    let mut p = AgentProfile::new(name, provider, model);
    p.avatar = body
        .avatar
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    p.system_prompt = body
        .system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    p.default_workspace = body
        .default_workspace
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    p.allowed_tools = body.allowed_tools.unwrap_or_default();
    match store.upsert(&p).await {
        Ok(()) => (StatusCode::CREATED, profile_json(&p)).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/agent-profiles/:id ---------------------

async fn fetch(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.get(&id).await {
        Ok(Some(p)) => profile_json(&p).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent profile `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PATCH /v1/agent-profiles/:id -------------------

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// `Some("")` clears, `None` leaves as-is.
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    default_workspace: Option<String>,
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut p = match store.get(&id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("agent profile `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    if let Some(s) = body.name {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`name` must not be blank");
        }
        p.name = trimmed;
    }
    if let Some(s) = body.provider {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`provider` must not be blank");
        }
        p.provider = trimmed;
    }
    if let Some(s) = body.model {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`model` must not be blank");
        }
        p.model = trimmed;
    }
    if let Some(s) = body.avatar {
        p.avatar = if s.trim().is_empty() {
            None
        } else {
            Some(s.trim().to_string())
        };
    }
    if let Some(s) = body.system_prompt {
        p.system_prompt = if s.trim().is_empty() {
            None
        } else {
            Some(s.trim().to_string())
        };
    }
    if let Some(s) = body.default_workspace {
        p.default_workspace = if s.trim().is_empty() {
            None
        } else {
            Some(s.trim().to_string())
        };
    }
    if let Some(tools) = body.allowed_tools {
        p.allowed_tools = tools;
    }
    p.touch();
    match store.upsert(&p).await {
        Ok(()) => profile_json(&p).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/agent-profiles/:id ------------------

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "deleted": false, "error": format!("agent profile `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_store::MemoryAgentProfileStore;
    use std::sync::Arc;
    use tower::ServiceExt;

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
        let store: Arc<dyn AgentProfileStore> = Arc::new(MemoryAgentProfileStore::new());
        base_state().with_agent_profile_store(store)
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
                    .uri("/v1/agent-profiles")
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
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/agent-profiles")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"Alice","provider":"openai","model":"gpt-4o-mini"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        let id = v["id"].as_str().unwrap().to_string();
        assert_eq!(v["name"], "Alice");
        assert_eq!(v["provider"], "openai");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/agent-profiles")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        assert_eq!(v["items"][0]["id"], id);
    }

    #[tokio::test]
    async fn create_rejects_blank_name() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/agent-profiles")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"   ","provider":"openai","model":"gpt-4o"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn patch_updates_fields_and_touches_updated_at() {
        let app = app(state_with_store());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/agent-profiles")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"Alice","provider":"openai","model":"gpt-4o-mini"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        let id = v["id"].as_str().unwrap().to_string();
        let original_updated_at = v["updated_at"].as_str().unwrap().to_string();

        // Sleep just enough that the rfc3339 millisecond value differs.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/agent-profiles/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"system_prompt":"You are Alice.","avatar":"🦊"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["system_prompt"], "You are Alice.");
        assert_eq!(v["avatar"], "🦊");
        assert_ne!(v["updated_at"], original_updated_at);
    }

    #[tokio::test]
    async fn delete_idempotent_404_after_first() {
        let app = app(state_with_store());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/agent-profiles")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"name":"Alice","provider":"openai","model":"gpt-4o-mini"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let id = read_json(resp).await["id"].as_str().unwrap().to_string();

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/agent-profiles/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/agent-profiles/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
