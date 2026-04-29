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
