//! REST routes for [`AgentProfile`]s — server-global named agent
//! identities (provider/model/system_prompt presets) used as
//! requirement assignees, @mentions, and (later) restricted
//! auto-loop dispatch targets.
//!
//! Mounted only when [`AppState::agent_profiles`] is set. Returns
//! `503` otherwise — same convention as `/v1/projects`,
//! `/v1/permissions`, `/v1/requirements`.
//!
//! Endpoints:
//!
//! - `GET    /v1/agent-profiles` — list, newest-first
//! - `POST   /v1/agent-profiles` — create
//!   (body: `{name, provider, model, avatar?, system_prompt?,
//!            default_workspace?, allowed_tools?}`)
//! - `PATCH  /v1/agent-profiles/:id` — partial update; any subset of
//!   the create fields. `name`, `provider`, `model` are required at
//!   creation but the patch can replace any of them. `Some("")` on
//!   string fields like `avatar` / `system_prompt` /
//!   `default_workspace` **clears** the field; `None` leaves it
//!   alone. `allowed_tools` always replaces the whole list when
//!   present.
//! - `DELETE /v1/agent-profiles/:id` — remove
//!
//! WS clients subscribe via the existing chat socket; the broadcast
//! bridge in `routes.rs` forwards [`AgentProfileEvent`]s as
//! `agent_profile_upserted` / `agent_profile_deleted` frames.

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
        .route(
            "/v1/agent-profiles",
            get(list_profiles).post(create_profile),
        )
        .route(
            "/v1/agent-profiles/:id",
            patch(update_profile).delete(delete_profile),
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

fn item_json(item: &AgentProfile) -> Json<Value> {
    Json(json!({ "profile": item }))
}

// ----------------------- GET /v1/agent-profiles -------------------------

async fn list_profiles(State(state): State<AppState>) -> Response {
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

async fn create_profile(
    State(state): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Response {
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

    let mut item = AgentProfile::new(name, provider, model);
    item.avatar = body
        .avatar
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    item.system_prompt = body
        .system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    item.default_workspace = body
        .default_workspace
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(tools) = body.allowed_tools {
        item.allowed_tools = tools.into_iter().filter(|s| !s.is_empty()).collect();
    }

    match store.upsert(&item).await {
        Ok(()) => (StatusCode::CREATED, item_json(&item)).into_response(),
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
    /// `Some("")` clears the field; `None` leaves it as-is.
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    default_workspace: Option<String>,
    /// Replaces the whole list when present.
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

async fn update_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get(&id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "no such agent profile" })),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };

    let mut changed = false;
    if let Some(name) = body.name {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`name` must not be blank");
        }
        item.name = trimmed;
        changed = true;
    }
    if let Some(provider) = body.provider {
        let trimmed = provider.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`provider` must not be blank");
        }
        item.provider = trimmed;
        changed = true;
    }
    if let Some(model) = body.model {
        let trimmed = model.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`model` must not be blank");
        }
        item.model = trimmed;
        changed = true;
    }
    if let Some(avatar) = body.avatar {
        let trimmed = avatar.trim().to_string();
        item.avatar = if trimmed.is_empty() { None } else { Some(trimmed) };
        changed = true;
    }
    if let Some(prompt) = body.system_prompt {
        let trimmed = prompt.trim().to_string();
        item.system_prompt = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
        changed = true;
    }
    if let Some(workspace) = body.default_workspace {
        let trimmed = workspace.trim().to_string();
        item.default_workspace = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
        changed = true;
    }
    if let Some(tools) = body.allowed_tools {
        item.allowed_tools = tools.into_iter().filter(|s| !s.is_empty()).collect();
        changed = true;
    }

    if changed {
        item.touch();
    }
    match store.upsert(&item).await {
        Ok(()) => item_json(&item).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/agent-profiles/:id ------------------

async fn delete_profile(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(removed) => Json(json!({ "deleted": removed })).into_response(),
        Err(e) => internal_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router as full_router;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use harness_store::MemoryAgentProfileStore;
    use tower::ServiceExt;

    struct NoopLlm;
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
            })
        }
    }

    fn make_state(with_store: bool) -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        let mut state = AppState::new(Arc::new(agent));
        if with_store {
            state = state.with_agent_profile_store(Arc::new(MemoryAgentProfileStore::new()));
        }
        state
    }

    async fn body_json(resp: axum::response::Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
    }

    fn json_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn json_patch(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("PATCH")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn list_returns_503_when_store_unconfigured() {
        let app = full_router(make_state(false));
        let resp = app
            .oneshot(Request::builder().uri("/v1/agent-profiles").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_get_update_delete_roundtrip() {
        let app = full_router(make_state(true));

        // create
        let resp = app
            .clone()
            .oneshot(json_post(
                "/v1/agent-profiles",
                json!({
                    "name": "Alice",
                    "provider": "anthropic",
                    "model": "claude-3-5-sonnet-latest",
                    "avatar": "🦊",
                }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["profile"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["profile"]["name"], "Alice");
        assert_eq!(body["profile"]["provider"], "anthropic");
        assert_eq!(body["profile"]["model"], "claude-3-5-sonnet-latest");
        assert_eq!(body["profile"]["avatar"], "🦊");

        // list
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
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"].as_array().unwrap().len(), 1);

        // patch — clear avatar with empty string, change model
        let resp = app
            .clone()
            .oneshot(json_patch(
                &format!("/v1/agent-profiles/{id}"),
                json!({
                    "avatar": "",
                    "model": "claude-3-5-haiku-latest",
                }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["profile"]["avatar"].is_null());
        assert_eq!(body["profile"]["model"], "claude-3-5-haiku-latest");

        // patch with blank required field → 400
        let resp = app
            .clone()
            .oneshot(json_patch(
                &format!("/v1/agent-profiles/{id}"),
                json!({ "name": "  " }),
            ))
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // patch unknown id → 404
        let resp = app
            .clone()
            .oneshot(json_patch(
                "/v1/agent-profiles/nope",
                json!({ "name": "x" }),
            ))
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // delete
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
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        // delete again is idempotent (deleted=false)
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
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], false);
    }

    #[tokio::test]
    async fn create_validates_required_fields() {
        let app = full_router(make_state(true));
        for (name, provider, model) in [
            ("", "openai", "gpt-4o-mini"),
            ("Alice", "", "gpt-4o-mini"),
            ("Alice", "openai", ""),
        ] {
            let resp = app
                .clone()
                .oneshot(json_post(
                    "/v1/agent-profiles",
                    json!({ "name": name, "provider": provider, "model": model }),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }
    }
}
