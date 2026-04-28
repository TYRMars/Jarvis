//! REST routes for [`Project`](harness_core::Project) CRUD.
//!
//! Mounted only when `AppState` carries a `ProjectStore`; otherwise
//! every endpoint here returns `503 Service Unavailable` so callers
//! can distinguish "not configured" from "really broken" — same
//! convention as `crate::conversations`.
//!
//! Endpoints:
//!
//! - `POST   /v1/projects`           — create
//! - `GET    /v1/projects`           — list (newest-updated first)
//! - `GET    /v1/projects/:id_or_slug` — detail by id or slug
//! - `PUT    /v1/projects/:id`       — partial update (any field)
//! - `DELETE /v1/projects/:id`       — soft-delete by default; `?hard=true`
//!   hard-delete (refuses if conversations are still bound)
//! - `POST   /v1/projects/:id/restore` — undo soft delete

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_core::{derive_slug, validate_slug, ConversationStore, Project, ProjectStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/projects", post(create).get(list))
        .route(
            "/v1/projects/:id_or_slug",
            get(get_one).put(update).delete(delete_one),
        )
        .route("/v1/projects/:id/restore", post(restore))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn ProjectStore>, Response> {
    state.projects.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "project store not configured; set JARVIS_DB_URL"
            })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "project store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "project not found" })),
    )
        .into_response()
}

// ----------------------- create -----------------------

#[derive(Debug, Deserialize)]
struct CreateRequest {
    name: String,
    instructions: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

async fn create(State(state): State<AppState>, Json(req): Json<CreateRequest>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if req.name.trim().is_empty() {
        return bad_request("name must not be empty");
    }
    if req.instructions.trim().is_empty() {
        return bad_request("instructions must not be empty");
    }

    // Resolve slug: caller-supplied wins; otherwise derive from name.
    // Then disambiguate against existing rows.
    let slug_seed = req.slug.clone().unwrap_or_else(|| derive_slug(&req.name));
    if let Err(reason) = validate_slug(&slug_seed) {
        return bad_request(reason);
    }
    let slug = match resolve_unique_slug(&*store, &slug_seed, req.slug.is_some()).await {
        Ok(s) => s,
        Err(e) => return e,
    };

    let mut p = Project::new(req.name, req.instructions).with_slug(slug);
    if let Some(d) = req.description {
        p.set_description(Some(d));
    }
    if !req.tags.is_empty() {
        p.set_tags(req.tags);
    }
    if let Err(e) = store.save(&p).await {
        return internal_error(e);
    }
    (StatusCode::CREATED, Json(project_to_json(&p))).into_response()
}

/// If `caller_supplied_slug == true` the seed is a hard requirement —
/// reject collisions with `409 Conflict` so the client sees the
/// problem. Otherwise the seed is just a default and we'll quietly
/// append `-2`, `-3`, … until something fits.
async fn resolve_unique_slug(
    store: &dyn ProjectStore,
    seed: &str,
    caller_supplied: bool,
) -> Result<String, Response> {
    if store
        .find_by_slug(seed)
        .await
        .map_err(internal_error)?
        .is_none()
    {
        return Ok(seed.to_string());
    }
    if caller_supplied {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("slug '{seed}' already in use"),
            })),
        )
            .into_response());
    }
    // Try -2, -3, ...
    for n in 2..=99 {
        let candidate = format!("{seed}-{n}");
        if validate_slug(&candidate).is_err() {
            // overflow — give up rather than truncate
            break;
        }
        if store
            .find_by_slug(&candidate)
            .await
            .map_err(internal_error)?
            .is_none()
        {
            return Ok(candidate);
        }
    }
    Err((
        StatusCode::CONFLICT,
        Json(json!({
            "error": format!("could not derive a unique slug from '{seed}'"),
        })),
    )
        .into_response())
}

// ----------------------- list -----------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    include_archived: bool,
}
fn default_limit() -> u32 {
    50
}

async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list(q.include_archived, q.limit).await {
        Ok(rows) => {
            let conv_store = state.store.as_ref();
            let mut out = Vec::with_capacity(rows.len());
            for p in rows {
                let mut v = project_to_json(&p);
                // Best-effort conversation count per project — handy for
                // sidebar pickers. Skipped silently if the conversation
                // store is unavailable or errors.
                if let Some(cs) = conv_store {
                    if let Some(n) = count_bound_conversations(cs.as_ref(), &p.id).await {
                        v["conversation_count"] = json!(n);
                    }
                }
                out.push(v);
            }
            Json(out).into_response()
        }
        Err(e) => internal_error(e),
    }
}

async fn count_bound_conversations(store: &dyn ConversationStore, project_id: &str) -> Option<u64> {
    // Cap at 200 — if you have a project with more than 200 bound
    // conversations the badge says "200+" anyway. Keeps the per-list
    // cost bounded.
    match store.list_by_project(project_id, 200).await {
        Ok(rows) => Some(rows.len() as u64),
        Err(e) => {
            error!(error = %e, project_id, "list_by_project failed during count");
            None
        }
    }
}

// ----------------------- get -----------------------

async fn get_one(State(state): State<AppState>, Path(id_or_slug): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match load_by_id_or_slug(&*store, &id_or_slug).await {
        Ok(Some(p)) => Json(project_to_json(&p)).into_response(),
        Ok(None) => not_found(),
        Err(e) => internal_error(e),
    }
}

async fn load_by_id_or_slug(
    store: &dyn ProjectStore,
    needle: &str,
) -> Result<Option<Project>, harness_core::BoxError> {
    if let Some(p) = store.load(needle).await? {
        return Ok(Some(p));
    }
    store.find_by_slug(needle).await
}

/// Public re-export for `crate::conversations` (and the WS handler) so
/// they can share the id-or-slug lookup convention.
pub(crate) async fn lookup_project(
    store: &dyn ProjectStore,
    needle: &str,
) -> Result<Option<Project>, harness_core::BoxError> {
    load_by_id_or_slug(store, needle).await
}

// ----------------------- update -----------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct UpdateRequest {
    name: Option<String>,
    slug: Option<String>,
    description: Option<String>,
    instructions: Option<String>,
    tags: Option<Vec<String>>,
    /// Pass `Some(false)` to un-archive in one call; `Some(true)`
    /// reaches the same place as `DELETE` (without `?hard=true`).
    archived: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    Path(id_or_slug): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut p = match load_by_id_or_slug(&*store, &id_or_slug).await {
        Ok(Some(p)) => p,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };

    if let Some(name) = req.name {
        if name.trim().is_empty() {
            return bad_request("name must not be empty");
        }
        p.set_name(name);
    }
    if let Some(new_slug) = req.slug {
        if let Err(reason) = validate_slug(&new_slug) {
            return bad_request(reason);
        }
        if new_slug != p.slug {
            // Make sure no *other* project owns this slug.
            match store.find_by_slug(&new_slug).await {
                Ok(Some(other)) if other.id != p.id => {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({
                            "error": format!("slug '{new_slug}' already in use"),
                        })),
                    )
                        .into_response();
                }
                Ok(_) => p.set_slug(new_slug),
                Err(e) => return internal_error(e),
            }
        }
    }
    if let Some(d) = req.description {
        p.set_description(if d.is_empty() { None } else { Some(d) });
    }
    if let Some(i) = req.instructions {
        if i.trim().is_empty() {
            return bad_request("instructions must not be empty");
        }
        p.set_instructions(i);
    }
    if let Some(t) = req.tags {
        p.set_tags(t);
    }
    if let Some(archived) = req.archived {
        if archived {
            p.archive();
        } else {
            p.unarchive();
        }
    }

    if let Err(e) = store.save(&p).await {
        return internal_error(e);
    }
    Json(project_to_json(&p)).into_response()
}

// ----------------------- delete -----------------------

#[derive(Debug, Default, Deserialize)]
struct DeleteQuery {
    /// Default `false` — soft-delete (archive). `true` requests a
    /// hard delete; refused with `409` if any conversations are still
    /// bound.
    #[serde(default)]
    hard: bool,
}

async fn delete_one(
    State(state): State<AppState>,
    Path(id_or_slug): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let p = match load_by_id_or_slug(&*store, &id_or_slug).await {
        Ok(Some(p)) => p,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };

    if !q.hard {
        return match store.archive(&p.id).await {
            Ok(true) => Json(json!({ "archived": true, "id": p.id })).into_response(),
            Ok(false) => not_found(),
            Err(e) => internal_error(e),
        };
    }

    // Hard delete: refuse if any conversations are still bound.
    if let Some(conv_store) = state.store.as_ref() {
        match conv_store.list_by_project(&p.id, 5).await {
            Ok(rows) if !rows.is_empty() => {
                let bound: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": "project has bound conversations; archive instead or unbind them first",
                        "bound_conversations": bound,
                    })),
                )
                    .into_response();
            }
            Ok(_) => {}
            Err(e) => return internal_error(e),
        }
    }
    match store.delete(&p.id).await {
        Ok(true) => Json(json!({ "deleted": true, "id": p.id })).into_response(),
        Ok(false) => not_found(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- restore -----------------------

async fn restore(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut p = match load_by_id_or_slug(&*store, &id).await {
        Ok(Some(p)) => p,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    if !p.archived {
        return Json(project_to_json(&p)).into_response();
    }
    p.unarchive();
    if let Err(e) = store.save(&p).await {
        return internal_error(e);
    }
    Json(project_to_json(&p)).into_response()
}

// ----------------------- helpers -----------------------

fn bad_request(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response()
}

fn project_to_json(p: &Project) -> Value {
    json!({
        "id": p.id,
        "slug": p.slug,
        "name": p.name,
        "description": p.description,
        "instructions": p.instructions,
        "tags": p.tags,
        "archived": p.archived,
        "created_at": p.created_at,
        "updated_at": p.updated_at,
    })
}

// ============================== tests ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router as full_router;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use harness_store::{MemoryConversationStore, MemoryProjectStore};
    use serde_json::Value;
    use tower::ServiceExt;

    struct NoopLlm;
    #[async_trait]
    impl LlmProvider for NoopLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
            })
        }
    }

    fn make_state() -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        AppState::new(Arc::new(agent))
            .with_store(Arc::new(MemoryConversationStore::new()))
            .with_project_store(Arc::new(MemoryProjectStore::new()))
    }

    fn make_state_no_projects() -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        AppState::new(Arc::new(agent)).with_store(Arc::new(MemoryConversationStore::new()))
    }

    async fn body_json(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
    }

    fn json_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn json_put(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn create_get_list_round_trip() {
        let app = full_router(make_state());

        let (status, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Customer Support",
                        "instructions": "Be terse and helpful.",
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();
        assert_eq!(body["slug"], "customer-support");

        // get by slug
        let (_, body) = body_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/projects/customer-support")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["id"], id);

        // list
        let (status, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri("/v1/projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 1);
        assert_eq!(body[0]["conversation_count"], 0);
    }

    #[tokio::test]
    async fn create_caller_slug_collision_is_409() {
        let app = full_router(make_state());

        app.clone()
            .oneshot(json_post(
                "/v1/projects",
                json!({"name": "A", "instructions": "x", "slug": "dup"}),
            ))
            .await
            .unwrap();

        let resp = app
            .oneshot(json_post(
                "/v1/projects",
                json!({"name": "B", "instructions": "y", "slug": "dup"}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn create_derived_slug_disambiguates_with_suffix() {
        let app = full_router(make_state());

        app.clone()
            .oneshot(json_post(
                "/v1/projects",
                json!({"name": "Writing Project", "instructions": "x"}),
            ))
            .await
            .unwrap();

        let (_, body) = body_json(
            app.oneshot(json_post(
                "/v1/projects",
                json!({"name": "Writing Project", "instructions": "y"}),
            ))
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(body["slug"], "writing-project-2");
    }

    #[tokio::test]
    async fn update_partial_fields() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "Old", "instructions": "old"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.clone()
                .oneshot(json_put(
                    &format!("/v1/projects/{id}"),
                    json!({"instructions": "new body"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["instructions"], "new body");
        assert_eq!(body["name"], "Old"); // untouched
    }

    #[tokio::test]
    async fn delete_default_is_soft() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "Z", "instructions": "x"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/projects/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["archived"], true);

        // Default list excludes it.
        let (_, body) = body_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/projects")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body.as_array().unwrap().len(), 0);

        // Restore brings it back.
        let resp = app
            .oneshot(json_post(&format!("/v1/projects/{id}/restore"), json!({})))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["archived"], false);
    }

    #[tokio::test]
    async fn hard_delete_refuses_when_conversations_are_bound() {
        let state = make_state();
        let conv_store = state.store.clone().unwrap();
        let proj_store = state.projects.clone().unwrap();

        let p = Project::new("X", "x").with_slug("x");
        proj_store.save(&p).await.unwrap();
        // Bind a conversation to this project.
        conv_store
            .save_envelope(
                "convA",
                &harness_core::Conversation::new(),
                &harness_core::ConversationMetadata::with_project(p.id.clone()),
            )
            .await
            .unwrap();

        let app = full_router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/projects/{}?hard=true", p.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn no_project_store_returns_503() {
        let app = full_router(make_state_no_projects());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
