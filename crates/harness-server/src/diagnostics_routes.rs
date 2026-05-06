//! REST routes for Phase 5b diagnostics.
//!
//! Mounted only when [`AppState::worktree_root`] is configured —
//! the only diagnostic today (orphan worktrees) is meaningful only
//! if the worktree feature is in use. Returns `503` otherwise.
//!
//! Endpoints:
//!
//! - `GET    /v1/diagnostics/worktrees/orphans`         — list
//! - `POST   /v1/diagnostics/worktrees/orphans/cleanup` — remove all

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::diagnostics;
use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/diagnostics/worktrees/orphans",
            get(list_orphan_worktrees),
        )
        .route(
            "/v1/diagnostics/worktrees/orphans/cleanup",
            post(cleanup_orphan_worktrees),
        )
        .route("/v1/diagnostics/runs/stuck", get(list_stuck_runs))
        .route("/v1/diagnostics/runs/failed", get(list_failed_runs))
}

#[allow(clippy::result_large_err)]
fn require_worktree_root(state: &AppState) -> Result<std::path::PathBuf, Response> {
    state.worktree_root.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "worktree feature not configured" })),
        )
            .into_response()
    })
}

#[allow(clippy::result_large_err)]
fn require_run_store(
    state: &AppState,
) -> Result<std::sync::Arc<dyn harness_core::RequirementRunStore>, Response> {
    state.requirement_runs.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "requirement run store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "diagnostics error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn json_value(v: impl serde::Serialize) -> Json<Value> {
    Json(serde_json::to_value(v).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// ----------------------- GET /v1/diagnostics/worktrees/orphans ----------

async fn list_orphan_worktrees(State(state): State<AppState>) -> Response {
    let root = match require_worktree_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let runs = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match diagnostics::find_orphan_worktrees(&root, runs.as_ref()).await {
        Ok(items) => json_value(json!({ "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/diagnostics/runs/stuck -----------------

#[derive(Debug, Deserialize)]
struct StuckQuery {
    /// Pending/Running runs older than this many seconds count
    /// as stuck. Default 1h.
    #[serde(default = "default_stuck_seconds")]
    threshold_seconds: i64,
    /// Cap on the upstream `list_all` scan. Default 500.
    #[serde(default = "default_scan_limit")]
    limit: u32,
}

fn default_stuck_seconds() -> i64 {
    60 * 60
}

fn default_scan_limit() -> u32 {
    500
}

async fn list_stuck_runs(State(state): State<AppState>, Query(q): Query<StuckQuery>) -> Response {
    let runs = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match diagnostics::stuck_runs(runs.as_ref(), q.threshold_seconds, q.limit).await {
        Ok(items) => json_value(json!({ "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/diagnostics/runs/failed ----------------

#[derive(Debug, Deserialize)]
struct FailedQuery {
    /// Cap on the returned list. Default 20.
    #[serde(default = "default_failed_limit")]
    limit: u32,
}

fn default_failed_limit() -> u32 {
    20
}

async fn list_failed_runs(State(state): State<AppState>, Query(q): Query<FailedQuery>) -> Response {
    let runs = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    match diagnostics::recent_failures(runs.as_ref(), q.limit).await {
        Ok(items) => json_value(json!({ "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/diagnostics/worktrees/orphans/cleanup --

async fn cleanup_orphan_worktrees(State(state): State<AppState>) -> Response {
    let root = match require_worktree_root(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let runs = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let workspace = state.workspace_root.clone().unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    });
    let orphans = match diagnostics::find_orphan_worktrees(&root, runs.as_ref()).await {
        Ok(items) => items,
        Err(e) => return internal_error(e),
    };
    let report = diagnostics::remove_orphan_worktrees(&workspace, &root, &orphans).await;
    json_value(report).into_response()
}
