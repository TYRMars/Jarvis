//! REST routes for the permission rule engine.
//!
//! Mounted only when `AppState::permission_store` is set. Returns
//! `503` otherwise so callers can distinguish "not configured" from
//! "really broken" — same convention as the conversation / project
//! routes.
//!
//! Endpoints:
//!
//! - `GET    /v1/permissions`           — full table snapshot
//! - `POST   /v1/permissions/rules`     — append rule (body: `{scope, bucket, rule}`)
//! - `DELETE /v1/permissions/rules`     — delete rule (query: `scope, bucket, index`)
//! - `PUT    /v1/permissions/mode`      — set the default mode of a scope (body: `{scope, mode}`)

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post, put},
    Router,
};
use harness_core::permission::{Decision, PermissionMode, PermissionRule, PermissionStore, Scope};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/permissions", get(get_table))
        .route("/v1/permissions/rules", post(post_rule).delete(delete_rule))
        .route("/v1/permissions/mode", put(put_mode))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn PermissionStore>, Response> {
    state.permission_store.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "permission store not configured"
            })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "permission store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn bad_request(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response()
}

// ----------------------- GET /v1/permissions -----------------------

async fn get_table(State(state): State<AppState>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let table = store.snapshot().await;
    // Serialise plus the active default mode reflected from the store
    // (which already merges all scopes per the
    // `JsonFilePermissionStore::merge` rules).
    Json(json!({
        "default_mode": table.default_mode,
        "deny": table.deny,
        "ask": table.ask,
        "allow": table.allow,
    }))
    .into_response()
}

// ----------------------- POST /v1/permissions/rules -----------------------

#[derive(Debug, Deserialize)]
struct PostRuleBody {
    scope: Scope,
    /// Which bucket this rule belongs to: "deny", "ask", or "allow".
    bucket: Decision,
    rule: PermissionRule,
}

async fn post_rule(State(state): State<AppState>, Json(body): Json<PostRuleBody>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if body.rule.tool.is_empty() {
        return bad_request("rule.tool must not be empty");
    }
    match store.append_rule(body.scope, body.bucket, body.rule).await {
        Ok(()) => (StatusCode::CREATED, Json(json!({ "ok": true }))).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/permissions/rules -----------------------

#[derive(Debug, Deserialize)]
struct DeleteRuleQuery {
    scope: Scope,
    bucket: Decision,
    index: usize,
}

async fn delete_rule(State(state): State<AppState>, Query(q): Query<DeleteRuleQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete_rule(q.scope, q.bucket, q.index).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => {
            // Out-of-bounds is the most common shape — surface as 404.
            let msg = e.to_string();
            if msg.contains("out of bounds") {
                (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
            } else {
                internal_error(e)
            }
        }
    }
}

// ----------------------- PUT /v1/permissions/mode -----------------------

#[derive(Debug, Deserialize)]
struct PutModeBody {
    scope: Scope,
    mode: PermissionMode,
}

async fn put_mode(State(state): State<AppState>, Json(body): Json<PutModeBody>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    // Bypass mode is never writable to the project scope — it would
    // let any committed file silently disable approval for everyone
    // who pulls the repo. User / session scope is fine: those are
    // private to this machine / process.
    if body.scope == Scope::Project && body.mode == PermissionMode::Bypass {
        return bad_request(
            "bypass mode cannot be written to project scope (it would commit to git and \
             affect every teammate); use user or session scope instead",
        );
    }
    if body.mode == PermissionMode::Bypass {
        tracing::warn!(
            scope = ?body.scope,
            "default permission mode set to BYPASS — all gated tools will run without prompting",
        );
    }
    match store.set_default_mode(body.scope, body.mode).await {
        Ok(()) => {
            let _: Value = json!({ "ok": true });
            Json(json!({ "ok": true, "mode": body.mode })).into_response()
        }
        Err(e) => internal_error(e),
    }
}
