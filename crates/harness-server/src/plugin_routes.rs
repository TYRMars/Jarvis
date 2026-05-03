//! HTTP routes for the plugin manager.
//!
//! `GET    /v1/plugins`              — list installed plugins
//! `POST   /v1/plugins/install`      — install from a local path
//! `DELETE /v1/plugins/:name`        — uninstall by name
//! `GET    /v1/plugins/:name`        — fetch one plugin's record
//! `GET    /v1/plugins/marketplace`  — built-in catalogue stub
//!
//! The "marketplace" today is a hard-coded list shipped with the
//! binary. A future Phase-4 PR can swap it for a remote JSON index
//! without touching client code.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_plugin::{PluginManager, PluginManagerError};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/plugins", get(list))
        .route("/v1/plugins/install", post(install))
        .route("/v1/plugins/marketplace", get(marketplace))
        .route("/v1/plugins/:name", get(get_one).delete(remove))
}

#[allow(clippy::result_large_err)]
fn require_manager(state: &AppState) -> Result<Arc<PluginManager>, Response> {
    state.plugins.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "plugin manager not configured" })),
        )
            .into_response()
    })
}

async fn list(State(state): State<AppState>) -> Response {
    let mgr = match require_manager(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let entries = mgr.list().await;
    (StatusCode::OK, Json(json!({ "plugins": entries }))).into_response()
}

async fn get_one(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let mgr = match require_manager(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match mgr.get(&name).await {
        Some(p) => (StatusCode::OK, Json(json!(p))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such plugin", "name": name })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case")]
enum InstallRequest {
    /// Install from a local directory containing a `plugin.json`.
    Path { value: String },
    // Reserved for future flavours: Git { url, ref?: String }.
}

async fn install(State(state): State<AppState>, Json(req): Json<InstallRequest>) -> Response {
    let mgr = match require_manager(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match req {
        InstallRequest::Path { value } => match mgr.install_from_path(&value).await {
            Ok(report) => (StatusCode::CREATED, Json(json!(report))).into_response(),
            Err(e) => map_error(e),
        },
    }
}

async fn remove(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let mgr = match require_manager(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match mgr.uninstall(&name).await {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "deleted": true, "name": name })),
        )
            .into_response(),
        Err(e) => map_error(e),
    }
}

async fn marketplace(State(_state): State<AppState>) -> Response {
    // Hard-coded built-in list. Each entry points at a path that
    // ships in-repo (under `examples/plugins/`) so a clean clone
    // can install one with a single click. Phase 4 swaps this for
    // a remote JSON index.
    let entries: Vec<Value> = vec![
        json!({
            "name": "code-review-pack",
            "description": "Bundles the in-tree `code-review` skill as a real plugin.",
            "source": "path",
            "value": "examples/plugins/code-review-pack",
            "tags": ["skills"],
        }),
        json!({
            "name": "gitnexus",
            "description": "Bridges GitNexus (knowledge-graph code intelligence) as an MCP server, plus a workflow skill.",
            "source": "path",
            "value": "examples/plugins/gitnexus",
            "tags": ["mcp", "skills", "code-intelligence"],
        }),
    ];
    (StatusCode::OK, Json(json!({ "plugins": entries }))).into_response()
}

fn map_error(e: PluginManagerError) -> Response {
    let (status, msg) = match &e {
        PluginManagerError::AlreadyInstalled(_) | PluginManagerError::Conflict { .. } => {
            (StatusCode::CONFLICT, e.to_string())
        }
        PluginManagerError::NotInstalled(_) => (StatusCode::NOT_FOUND, e.to_string()),
        PluginManagerError::Manifest(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    (status, Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router as full_router;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use tower::ServiceExt;

    struct NoopLlm;
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
            })
        }
    }

    fn make_state() -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        AppState::new(Arc::new(agent))
    }

    /// The marketplace stub is the entry point users hit via
    /// `jarvis plugin marketplace`. Pin both built-in entries so a
    /// careless edit to the hard-coded list shows up as a CI failure
    /// instead of a silently-disappeared install path.
    #[tokio::test]
    async fn marketplace_lists_builtin_entries() {
        let app = full_router(make_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/plugins/marketplace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let plugins = body["plugins"].as_array().expect("plugins array");
        let names: Vec<&str> = plugins
            .iter()
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(names.contains(&"code-review-pack"), "names={names:?}");
        assert!(names.contains(&"gitnexus"), "names={names:?}");

        // Each entry must carry the fields `jarvis plugin install`
        // depends on: `source` ("path") and `value` (relative path).
        for p in plugins {
            assert_eq!(p["source"].as_str(), Some("path"), "entry={p}");
            assert!(p["value"].as_str().is_some(), "entry={p}");
        }

        // Spot-check the gitnexus entry routes to the on-disk plugin.
        let gitnexus = plugins
            .iter()
            .find(|p| p["name"].as_str() == Some("gitnexus"))
            .unwrap();
        assert_eq!(
            gitnexus["value"].as_str(),
            Some("examples/plugins/gitnexus")
        );
    }
}
