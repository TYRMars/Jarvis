//! HTTP routes for runtime MCP server management.
//!
//! `GET    /v1/mcp/servers`              — list every registered server
//! `POST   /v1/mcp/servers`              — add a new server
//! `GET    /v1/mcp/servers/:prefix`      — fetch one server's info
//! `DELETE /v1/mcp/servers/:prefix`      — remove + shut down
//! `PUT    /v1/mcp/servers/:prefix`      — replace config in place
//! `POST   /v1/mcp/servers/:prefix/health` — probe with `tools/list`
//!
//! All endpoints require an MCP manager to be configured on
//! `AppState`. When absent, every route returns 503 so callers can
//! cleanly distinguish "not configured" from "really broken".

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_mcp::{McpClientConfig, McpManager};
use serde_json::json;
use std::sync::Arc;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/mcp/servers", get(list).post(add))
        .route(
            "/v1/mcp/servers/:prefix",
            get(get_one).delete(remove).put(replace),
        )
        .route("/v1/mcp/servers/:prefix/health", post(health))
}

#[allow(clippy::result_large_err)]
fn require_mcp(state: &AppState) -> Result<Arc<McpManager>, Response> {
    state.mcp.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "mcp manager not configured" })),
        )
            .into_response()
    })
}

async fn list(State(state): State<AppState>) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let servers = mcp.list().await;
    (StatusCode::OK, Json(json!({ "servers": servers }))).into_response()
}

async fn get_one(State(state): State<AppState>, Path(prefix): Path<String>) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match mcp.get(&prefix).await {
        Some(info) => (StatusCode::OK, Json(json!(info))).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such mcp server", "prefix": prefix })),
        )
            .into_response(),
    }
}

async fn add(State(state): State<AppState>, Json(cfg): Json<McpClientConfig>) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if cfg.prefix.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "prefix is required" })),
        )
            .into_response();
    }
    let prefix = cfg.prefix.clone();
    match mcp.add(cfg).await {
        Ok(tools) => (
            StatusCode::CREATED,
            Json(json!({ "prefix": prefix, "tools": tools })),
        )
            .into_response(),
        Err(e) => map_mcp_error(e),
    }
}

async fn replace(
    State(state): State<AppState>,
    Path(prefix): Path<String>,
    Json(mut cfg): Json<McpClientConfig>,
) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    // Allow callers to omit the prefix in the body — we trust the
    // path. If they DO send one, it must match.
    if cfg.prefix.trim().is_empty() {
        cfg.prefix = prefix.clone();
    } else if cfg.prefix != prefix {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "body prefix does not match path",
                "path": prefix,
                "body": cfg.prefix,
            })),
        )
            .into_response();
    }
    match mcp.replace(&prefix, cfg).await {
        Ok(tools) => (
            StatusCode::OK,
            Json(json!({ "prefix": prefix, "tools": tools })),
        )
            .into_response(),
        Err(e) => map_mcp_error(e),
    }
}

async fn remove(State(state): State<AppState>, Path(prefix): Path<String>) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match mcp.remove(&prefix).await {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({ "deleted": true, "prefix": prefix })),
        )
            .into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such mcp server", "prefix": prefix })),
        )
            .into_response(),
        Err(e) => map_mcp_error(e),
    }
}

async fn health(State(state): State<AppState>, Path(prefix): Path<String>) -> Response {
    let mcp = match require_mcp(&state) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let started = std::time::Instant::now();
    match mcp.health(&prefix).await {
        Ok(count) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "tools": count, "latency_ms": latency_ms })),
            )
                .into_response()
        }
        Err(e) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            (
                StatusCode::OK,
                Json(json!({ "ok": false, "error": e.to_string(), "latency_ms": latency_ms })),
            )
                .into_response()
        }
    }
}

fn map_mcp_error(e: harness_mcp::McpError) -> Response {
    let msg = e.to_string();
    let status = if msg.contains("already registered") || msg.contains("would conflict") {
        StatusCode::CONFLICT
    } else if msg.contains("unknown mcp prefix") || msg.contains("does not match") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    (status, Json(json!({ "error": msg }))).into_response()
}
