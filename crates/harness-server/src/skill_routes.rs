//! HTTP routes for the skill catalogue.
//!
//! `GET    /v1/skills`              — list every loaded skill
//! `GET    /v1/skills/:name`        — fetch one skill (manifest + body)
//! `POST   /v1/skills/reload`       — re-scan disk roots
//!
//! All endpoints require an `Arc<RwLock<SkillCatalog>>` on
//! `AppState`. Without one, every route returns 503 so callers can
//! distinguish "feature not enabled" from "really broken".

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_skill::{SkillCatalog, SkillSource};
use serde_json::json;
use tracing::info;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/skills", get(list))
        .route("/v1/skills/:name", get(get_one))
        .route("/v1/skills/reload", post(reload))
}

#[allow(clippy::result_large_err)]
fn require_catalog(state: &AppState) -> Result<Arc<RwLock<SkillCatalog>>, Response> {
    state.skills.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "skill catalogue not configured" })),
        )
            .into_response()
    })
}

async fn list(State(state): State<AppState>) -> Response {
    let cat = match require_catalog(&state) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let guard = match cat.read() {
        Ok(g) => g,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "skill catalogue lock poisoned" })),
            )
                .into_response();
        }
    };
    let entries: Vec<_> = guard
        .entries()
        .map(|e| {
            json!({
                "name": e.manifest.name,
                "description": e.manifest.description,
                "license": e.manifest.license,
                "allowed_tools": e.manifest.allowed_tools,
                "activation": e.manifest.activation,
                "keywords": e.manifest.keywords,
                "version": e.manifest.version,
                "source": e.source,
                "path": e.path.display().to_string(),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({ "skills": entries }))).into_response()
}

async fn get_one(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let cat = match require_catalog(&state) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let guard = match cat.read() {
        Ok(g) => g,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "skill catalogue lock poisoned" })),
            )
                .into_response();
        }
    };
    match guard.get(&name) {
        Some(e) => (
            StatusCode::OK,
            Json(json!({
                "name": e.manifest.name,
                "description": e.manifest.description,
                "license": e.manifest.license,
                "allowed_tools": e.manifest.allowed_tools,
                "activation": e.manifest.activation,
                "keywords": e.manifest.keywords,
                "version": e.manifest.version,
                "source": e.source,
                "path": e.path.display().to_string(),
                "body": e.body,
            })),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such skill", "name": name })),
        )
            .into_response(),
    }
}

async fn reload(State(state): State<AppState>) -> Response {
    let cat = match require_catalog(&state) {
        Ok(c) => c,
        Err(r) => return r,
    };
    // Catalog mutations (plugin install / uninstall) flow through
    // the manager, so the on-disk roots aren't the only source of
    // truth anymore — a naive re-scan would clobber plugin entries.
    // We stay conservative here: surface the current count and let
    // a future "rescan disk roots and merge" build on this once the
    // semantics are pinned down.
    info!("skills/reload received (no-op stub)");
    let count = cat.read().map(|g| g.len()).unwrap_or(0);
    (StatusCode::OK, Json(json!({ "count": count, "reloaded": false }))).into_response()
}

/// Helper used by the binary at startup: build the canonical roots
/// list `(user_dir, workspace_dir)` honouring the `JARVIS_SKILLS_DIR`
/// override. Returned in load order — workspace shadows user.
pub fn default_roots(
    user_dir: Option<PathBuf>,
    workspace_dir: Option<PathBuf>,
) -> Vec<(PathBuf, SkillSource)> {
    let mut out = Vec::new();
    if let Some(p) = user_dir {
        out.push((p, SkillSource::User));
    }
    if let Some(p) = workspace_dir {
        out.push((p, SkillSource::Workspace));
    }
    out
}
