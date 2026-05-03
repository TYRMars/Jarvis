//! REST routes for runtime provider admin.
//!
//! All endpoints are mounted only when [`AppState::provider_admin`] is
//! `Some(_)`. When the binary didn't wire an impl, every admin call
//! returns `503 Service Unavailable` so the Web UI can render an
//! "edit-from-config-only" hint instead of crashing.
//!
//! Endpoints:
//!
//! - `POST   /v1/providers` — add a new provider
//! - `GET    /v1/providers/:name` — full snapshot for the edit form
//! - `PATCH  /v1/providers/:name` — replace the provider's config and
//!   (optionally) its api_key
//! - `DELETE /v1/providers/:name` — drop the provider; pass
//!   `?purge_secret=true` to also delete the auth-file
//! - `PUT    /v1/providers/default` — set the registry-wide default
//!
//! On any successful mutation the handler bumps
//! `state.providers_changed` (broadcast channel) so connected WS
//! clients can refetch `/v1/providers` and re-render their picker.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, put},
    Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::provider_admin::{ProviderAdmin, ProviderDef, ProvisionError};
use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/providers", axum::routing::post(create_provider))
        .route(
            "/v1/providers/:name",
            get(get_provider)
                .patch(update_provider)
                .delete(delete_provider),
        )
        .route("/v1/providers/default", put(set_default_provider))
}

#[allow(clippy::result_large_err)]
fn require_admin(state: &AppState) -> Result<std::sync::Arc<dyn ProviderAdmin>, Response> {
    state.provider_admin.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "provider admin not configured (binary didn't wire ProviderAdmin)"
            })),
        )
            .into_response()
    })
}

fn map_error(e: ProvisionError) -> Response {
    let (status, msg) = match &e {
        ProvisionError::Invalid(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        ProvisionError::AlreadyExists(_) => (StatusCode::CONFLICT, e.to_string()),
        ProvisionError::NotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
        ProvisionError::Construction(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        ProvisionError::Persistence(_) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    (status, Json(json!({ "error": msg }))).into_response()
}

// ----------------------- POST /v1/providers ------------------------------

async fn create_provider(
    State(state): State<AppState>,
    Json(body): Json<ProviderDef>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match admin.provision(body, false).await {
        Ok(snapshot) => {
            let _ = state.providers_changed.send(());
            (StatusCode::CREATED, Json(json!({ "provider": snapshot }))).into_response()
        }
        Err(e) => map_error(e),
    }
}

// ----------------------- GET /v1/providers/:name -------------------------

async fn get_provider(State(state): State<AppState>, Path(name): Path<String>) -> Response {
    let admin = match require_admin(&state) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match admin.snapshot(&name).await {
        Ok(snapshot) => Json(json!({ "provider": snapshot })).into_response(),
        Err(e) => map_error(e),
    }
}

// ----------------------- PATCH /v1/providers/:name -----------------------

async fn update_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(mut body): Json<ProviderDef>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(a) => a,
        Err(r) => return r,
    };
    // The path's name is authoritative — accepting a body name lets
    // callers send a full ProviderDef back from a GET, but renaming
    // mid-PATCH is not supported (auth-file key would orphan).
    if !body.name.is_empty() && body.name != name {
        return map_error(ProvisionError::Invalid(format!(
            "PATCH cannot rename `{}` → `{}` (delete + re-create)",
            name, body.name
        )));
    }
    body.name = name;
    match admin.provision(body, true).await {
        Ok(snapshot) => {
            let _ = state.providers_changed.send(());
            Json(json!({ "provider": snapshot })).into_response()
        }
        Err(e) => map_error(e),
    }
}

// ----------------------- DELETE /v1/providers/:name ----------------------

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    /// Also wipe `~/.config/jarvis/auth/<name>.json`. Defaults to
    /// `true` for the Web UI's "Delete provider" button — keeping
    /// the secret around when the provider is gone is more confusing
    /// than helpful.
    #[serde(default = "default_purge_secret")]
    purge_secret: bool,
}

fn default_purge_secret() -> bool {
    true
}

async fn delete_provider(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match admin.unprovision(&name, q.purge_secret).await {
        Ok(removed) => {
            if removed {
                let _ = state.providers_changed.send(());
            }
            Json(json!({ "deleted": removed })).into_response()
        }
        Err(e) => map_error(e),
    }
}

// ----------------------- PUT /v1/providers/default -----------------------

#[derive(Debug, Deserialize)]
struct SetDefaultBody {
    name: String,
}

async fn set_default_provider(
    State(state): State<AppState>,
    Json(body): Json<SetDefaultBody>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let name = body.name.trim();
    if name.is_empty() {
        return map_error(ProvisionError::Invalid("`name` must not be blank".into()));
    }
    match admin.set_default(name).await {
        Ok(()) => {
            let _ = state.providers_changed.send(());
            Json(json!({ "default": name })).into_response()
        }
        Err(e) => map_error(e),
    }
}
