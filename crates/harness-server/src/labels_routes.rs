//! REST routes for [`Label`](harness_core::Label) — Phase 3.8
//! project-scoped tags.
//!
//! Mounted only when [`AppState::labels`] is configured. Returns
//! `503 Service Unavailable` otherwise.
//!
//! Endpoints:
//!
//! - `GET    /v1/projects/:project_id/labels`     — list, alpha-sorted
//! - `POST   /v1/projects/:project_id/labels`     — create
//! - `PATCH  /v1/labels/:label_id`                — rename / recolour / re-describe
//! - `DELETE /v1/labels/:label_id`                — delete (does NOT cascade into Requirement.label_ids)
//!
//! Validation comes from
//! [`harness_core::label::validate_label_name`] and
//! `validate_label_colour`. Name uniqueness inside a project is
//! enforced by the store layer; we surface its `already exists`
//! error as `409 Conflict`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch},
    Router,
};
use harness_core::{validate_label_colour, validate_label_name, Label, LabelStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

/// Soft cap on `description`. Long descriptions belong in a doc, not
/// hovering on a kanban chip.
const MAX_LABEL_DESCRIPTION_BYTES: usize = 256;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/projects/:project_id/labels",
            get(list_labels).post(create_label),
        )
        .route(
            "/v1/labels/:label_id",
            patch(update_label).delete(delete_label),
        )
}

#[allow(clippy::result_large_err)]
fn require_label_store(state: &AppState) -> Result<Arc<dyn LabelStore>, Response> {
    state.labels.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "label store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "labels error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn bad_request(msg: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.into() })),
    )
        .into_response()
}

fn conflict(msg: impl Into<String>) -> Response {
    (StatusCode::CONFLICT, Json(json!({ "error": msg.into() }))).into_response()
}

fn not_found(msg: impl Into<String>) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg.into() }))).into_response()
}

fn json_value(v: impl serde::Serialize) -> Json<Value> {
    Json(serde_json::to_value(v).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

/// Map `LabelStore::create` / `update` errors into the right HTTP
/// status. The store surfaces "already exists" as a free-form
/// message; we pattern-match on the substring rather than carrying
/// a typed error through the trait, which keeps the trait surface
/// minimal.
fn map_label_store_err(e: harness_core::BoxError) -> Response {
    let msg = e.to_string();
    if msg.contains("already exists") {
        conflict(msg)
    } else {
        internal_error(msg)
    }
}

// ----------------------- GET /v1/projects/:project_id/labels ------------

async fn list_labels(State(state): State<AppState>, Path(project_id): Path<String>) -> Response {
    let store = match require_label_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list_for_project(&project_id).await {
        Ok(items) => {
            json_value(json!({ "project_id": project_id, "items": items })).into_response()
        }
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/projects/:project_id/labels -----------

#[derive(Debug, Deserialize)]
struct CreateLabelBody {
    name: String,
    /// `#rrggbb` (case-insensitive). Validated server-side.
    colour: String,
    #[serde(default)]
    description: Option<String>,
}

async fn create_label(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<CreateLabelBody>,
) -> Response {
    let store = match require_label_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let name = match validate_label_name(&payload.name) {
        Ok(n) => n,
        Err(e) => return bad_request(e),
    };
    let colour = match validate_label_colour(&payload.colour) {
        Ok(c) => c,
        Err(e) => return bad_request(e),
    };
    let description = match validate_description(payload.description.as_deref()) {
        Ok(d) => d,
        Err(e) => return bad_request(e),
    };

    let mut label = Label::new(project_id.clone(), name, colour);
    label.description = description;
    match store.create(&label).await {
        Ok(()) => (StatusCode::CREATED, json_value(&label)).into_response(),
        Err(e) => map_label_store_err(e),
    }
}

// ----------------------- PATCH /v1/labels/:label_id ---------------------

/// Patch body — every field is optional; absent fields are left as-is.
#[derive(Debug, Deserialize)]
struct UpdateLabelBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    colour: Option<String>,
    /// `Some("")` clears the description; `None` leaves it.
    #[serde(default)]
    description: Option<String>,
}

async fn update_label(
    State(state): State<AppState>,
    Path(label_id): Path<String>,
    Json(payload): Json<UpdateLabelBody>,
) -> Response {
    let store = match require_label_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut existing = match store.get(&label_id).await {
        Ok(Some(l)) => l,
        Ok(None) => return not_found(format!("label `{label_id}` not found")),
        Err(e) => return internal_error(e),
    };
    if let Some(name) = payload.name.as_deref() {
        match validate_label_name(name) {
            Ok(n) => existing.name = n,
            Err(e) => return bad_request(e),
        }
    }
    if let Some(colour) = payload.colour.as_deref() {
        match validate_label_colour(colour) {
            Ok(c) => existing.colour = c,
            Err(e) => return bad_request(e),
        }
    }
    if let Some(description) = payload.description.as_deref() {
        match validate_description(Some(description)) {
            Ok(d) => existing.description = d,
            Err(e) => return bad_request(e),
        }
    }
    existing.touch();
    match store.update(&existing).await {
        Ok(true) => json_value(&existing).into_response(),
        Ok(false) => not_found(format!("label `{label_id}` not found")),
        Err(e) => map_label_store_err(e),
    }
}

// ----------------------- DELETE /v1/labels/:label_id --------------------

async fn delete_label(State(state): State<AppState>, Path(label_id): Path<String>) -> Response {
    let store = match require_label_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let existing = match store.get(&label_id).await {
        Ok(Some(l)) => l,
        Ok(None) => return not_found(format!("label `{label_id}` not found")),
        Err(e) => return internal_error(e),
    };
    match store.delete(&existing.project_id, &label_id).await {
        Ok(true) => json_value(json!({
            "deleted": true,
            "label_id": label_id,
            "project_id": existing.project_id,
        }))
        .into_response(),
        Ok(false) => not_found(format!("label `{label_id}` not found")),
        Err(e) => internal_error(e),
    }
}

// ---- helpers -----------------------------------------------------------

/// Validate / canonicalise the optional description. Maps:
/// - `None`            → `Ok(None)` (don't touch)
/// - `Some("")`        → `Ok(None)` (clear)
/// - `Some(longer)`    → `Ok(Some(trimmed))` if within cap, else `Err`
fn validate_description(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_LABEL_DESCRIPTION_BYTES {
        return Err(format!(
            "label description exceeds {MAX_LABEL_DESCRIPTION_BYTES}-byte cap"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::MAX_LABEL_NAME_LEN;

    #[test]
    fn description_validator_clears_on_blank_input() {
        assert_eq!(validate_description(Some("")).unwrap(), None);
        assert_eq!(validate_description(Some("   ")).unwrap(), None);
        assert_eq!(validate_description(None).unwrap(), None);
    }

    #[test]
    fn description_validator_trims() {
        assert_eq!(
            validate_description(Some("  hello  ")).unwrap(),
            Some("hello".to_string())
        );
    }

    #[test]
    fn description_validator_caps_length() {
        let s = "a".repeat(MAX_LABEL_DESCRIPTION_BYTES + 1);
        assert!(validate_description(Some(&s)).is_err());
    }

    /// `MAX_LABEL_NAME_LEN` is re-exported so the route can mention
    /// it in errors; this just guards against an accidental rename.
    #[test]
    fn name_cap_is_re_exported() {
        let _ = MAX_LABEL_NAME_LEN;
    }
}
