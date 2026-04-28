//! HTTP routes for the skill catalogue.
//!
//! `GET    /v1/skills`              — list every loaded skill
//! `GET    /v1/skills/:name`        — fetch one skill (manifest + body)
//! `POST   /v1/skills/reload`       — re-scan disk roots
//!
//! All endpoints require an [`Arc<SkillCatalog>`] on `AppState`.
//! Without one, every route returns 503 so callers can distinguish
//! "feature not enabled" from "really broken".

use std::path::PathBuf;
use std::sync::Arc;

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
fn require_catalog(state: &AppState) -> Result<Arc<SkillCatalog>, Response> {
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
    let entries: Vec<_> = cat
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
    match cat.get(&name) {
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
    let _existing = match require_catalog(&state) {
        Ok(c) => c,
        Err(r) => return r,
    };
    // Catalog is immutable behind Arc — re-loading mutates nothing
    // shared. The intended replacement path is for the binary to
    // construct a fresh `Arc<SkillCatalog>` and swap it in via
    // `with_skills`; we expose this no-op endpoint so the UI button
    // returns success when nothing has changed on disk and so the
    // wire shape is forward-compatible with a real reload once we
    // park the catalogue behind an `RwLock` (deferred to Phase 4
    // to avoid widening the AppState lock surface mid-Phase-2).
    info!("skills/reload received (catalog is currently load-once at startup)");
    let count = state
        .skills
        .as_ref()
        .map(|c| c.len())
        .unwrap_or_default();
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
