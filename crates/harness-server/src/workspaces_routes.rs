//! HTTP routes for the persisted workspaces registry.
//!
//! `GET    /v1/workspaces`              — list recent (newest first)
//! `POST   /v1/workspaces`              — touch (insert / promote)
//! `DELETE /v1/workspaces?path=<abs>`   — drop from recent
//!
//! All endpoints require an `Arc<WorkspaceStore>` on `AppState`.
//! Without one, every route returns 503 so callers can distinguish
//! "feature not enabled" from "really broken".

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{delete, get, post},
    Router,
};
use harness_store::WorkspaceStore;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/workspaces", get(list).post(touch).delete(forget))
        // Aliases so callers can use either `?path=` query (DELETE)
        // or the same body as POST. axum routes by method, so the
        // `delete` and `post` above already share the same path.
        .route("/v1/workspaces/touch", post(touch))
        .route("/v1/workspaces/forget", delete(forget))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<WorkspaceStore>, Response> {
    state.workspaces.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "workspaces registry not configured" })),
        )
            .into_response()
    })
}

async fn list(State(state): State<AppState>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    (
        StatusCode::OK,
        Json(json!({ "workspaces": store.list_recent() })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct TouchBody {
    path: String,
}

async fn touch(State(state): State<AppState>, Json(body): Json<TouchBody>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.touch(&body.path) {
        Ok(canonical) => (
            StatusCode::OK,
            Json(json!({ "path": canonical, "recent": store.list_recent() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct ForgetQuery {
    path: String,
}

async fn forget(State(state): State<AppState>, Query(q): Query<ForgetQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    store.forget(&q.path);
    (
        StatusCode::OK,
        Json(json!({ "deleted": true, "recent": store.list_recent() })),
    )
        .into_response()
}
