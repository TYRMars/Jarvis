//! REST routes for the `/docs` page — `DocProject` + `DocDraft`.
//!
//! Mounted only when [`AppState::docs`] is set. Returns 503 otherwise
//! — same convention as `/v1/todos`, `/v1/projects`, `/v1/requirements`.
//!
//! Endpoints:
//!
//! - `GET    /v1/doc-projects?workspace=<abs>`
//!   — list projects scoped to a workspace (newest-first).
//! - `POST   /v1/doc-projects`
//!   — create (body: `{title, kind?, workspace?}`).
//! - `GET    /v1/doc-projects/:id`
//!   — load a single project.
//! - `PATCH  /v1/doc-projects/:id`
//!   — partial update (body: any subset of `{title, kind}`).
//! - `DELETE /v1/doc-projects/:id`
//!   — hard-delete project + cascade delete its drafts.
//! - `GET    /v1/doc-projects/:id/draft`
//!   — return the most-recent Markdown draft, or `null`.
//! - `PUT    /v1/doc-projects/:id/draft`
//!   — save / replace draft body (body: `{content}`). Inserts a new
//!   draft row each call (cheap append-only history); the UI reads
//!   the latest one.
//!
//! WS bridge in `routes.rs` fans out [`DocEvent`] frames as
//! `doc_project_upserted` / `doc_project_deleted` / `doc_draft_upserted`.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch},
    Router,
};
use harness_core::{canonicalize_workspace, DocDraft, DocKind, DocProject, DocStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/doc-projects", get(list_projects).post(create_project))
        .route(
            "/v1/doc-projects/:id",
            patch(update_project)
                .delete(delete_project)
                .get(get_project),
        )
        .route("/v1/doc-projects/:id/draft", get(get_draft).put(put_draft))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn DocStore>, Response> {
    state.docs.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "doc store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "doc store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

fn bad_request(reason: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": reason.into() })),
    )
        .into_response()
}

fn resolve_workspace(state: &AppState, override_path: Option<&str>) -> Option<String> {
    let path: PathBuf = match override_path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => match state.workspace_root.as_ref() {
            Some(root) => root.clone(),
            None => return None,
        },
    };
    Some(canonicalize_workspace(&path))
}

fn project_json(p: &DocProject) -> Json<Value> {
    Json(serde_json::to_value(p).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

// ----------------------- GET /v1/doc-projects ----------------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    workspace: Option<String>,
}

async fn list_projects(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(workspace) = resolve_workspace(&state, q.workspace.as_deref()) else {
        return bad_request(
            "no workspace pinned on the server; pass `?workspace=<abs path>` explicitly",
        );
    };
    match store.list_projects(&workspace).await {
        Ok(items) => Json(json!({ "workspace": workspace, "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/doc-projects ---------------------------

#[derive(Debug, Deserialize)]
struct CreateBody {
    title: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
}

async fn create_project(State(state): State<AppState>, Json(body): Json<CreateBody>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return bad_request("`title` must not be blank");
    }
    let Some(workspace) = resolve_workspace(&state, body.workspace.as_deref()) else {
        return bad_request("no workspace pinned on the server; include `workspace` in the body");
    };
    let mut item = DocProject::new(workspace, title);
    if let Some(k) = body.kind.as_deref() {
        match DocKind::from_wire(k) {
            Some(parsed) => item.kind = parsed,
            None => return bad_request(format!("unknown kind `{k}`")),
        }
    }
    match store.upsert_project(&item).await {
        Ok(()) => (StatusCode::CREATED, project_json(&item)).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/doc-projects/:id ------------------------

async fn get_project(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.get_project(&id).await {
        Ok(Some(p)) => project_json(&p).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("doc project `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PATCH /v1/doc-projects/:id ----------------------

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    pinned: Option<bool>,
    #[serde(default)]
    archived: Option<bool>,
}

async fn update_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get_project(&id).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("doc project `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    };
    if let Some(t) = body.title {
        let trimmed = t.trim().to_string();
        if trimmed.is_empty() {
            return bad_request("`title` must not be blank");
        }
        item.title = trimmed;
    }
    if let Some(k) = body.kind.as_deref() {
        match DocKind::from_wire(k) {
            Some(parsed) => item.kind = parsed,
            None => return bad_request(format!("unknown kind `{k}`")),
        }
    }
    if let Some(tags) = body.tags {
        // Trim, drop empties, dedup while preserving caller order.
        let mut seen = std::collections::HashSet::new();
        let cleaned: Vec<String> = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty() && seen.insert(t.clone()))
            .collect();
        item.tags = cleaned;
    }
    if let Some(p) = body.pinned {
        item.pinned = p;
    }
    if let Some(a) = body.archived {
        item.archived = a;
    }
    item.touch();
    match store.upsert_project(&item).await {
        Ok(()) => project_json(&item).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/doc-projects/:id ---------------------

async fn delete_project(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete_project(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "deleted": false, "error": format!("doc project `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- GET /v1/doc-projects/:id/draft ------------------

async fn get_draft(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.latest_draft(&id).await {
        Ok(Some(d)) => {
            Json(serde_json::to_value(&d).unwrap_or_else(|e| json!({ "error": e.to_string() })))
                .into_response()
        }
        Ok(None) => Json(serde_json::Value::Null).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PUT /v1/doc-projects/:id/draft ------------------

#[derive(Debug, Deserialize)]
struct PutDraftBody {
    content: String,
}

async fn put_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PutDraftBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    // 404 if the parent project doesn't exist.
    match store.get_project(&id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("doc project `{id}` not found") })),
            )
                .into_response()
        }
        Err(e) => return internal_error(e),
    }
    let draft = DocDraft::new(id, body.content);
    match store.upsert_draft(&draft).await {
        Ok(()) => (
            StatusCode::CREATED,
            Json(
                serde_json::to_value(&draft).unwrap_or_else(|e| json!({ "error": e.to_string() })),
            ),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_store::MemoryDocStore;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Stub LLM — `AppState::new` needs one. Doc routes don't touch
    /// the agent.
    struct StubLlm;
    #[async_trait::async_trait]
    impl harness_core::LlmProvider for StubLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    fn base_state() -> AppState {
        use harness_core::{Agent, AgentConfig};
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent).with_workspace_root(std::path::PathBuf::from("/tmp/doc-test"))
    }

    fn state_with_store() -> AppState {
        let store: Arc<dyn DocStore> = Arc::new(MemoryDocStore::new());
        base_state().with_doc_store(store)
    }

    fn app(state: AppState) -> axum::Router {
        super::router().with_state(state)
    }

    async fn read_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        if bytes.is_empty() {
            return serde_json::Value::Null;
        }
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn returns_503_when_store_absent() {
        let resp = app(base_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/doc-projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_then_list_round_trip() {
        let app = app(state_with_store());

        // Create.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/doc-projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"weekly review","kind":"report"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        assert_eq!(v["title"], "weekly review");
        assert_eq!(v["kind"], "report");
        let id = v["id"].as_str().unwrap().to_string();

        // List.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/doc-projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 1);

        // PUT draft.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/v1/doc-projects/{id}/draft"))
                    .header("content-type", "application/json")
                    .body(Body::from(r##"{"content":"# Hello\n\nbody."}"##))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // GET draft.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/doc-projects/{id}/draft"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["format"], "markdown");
        assert!(v["content"].as_str().unwrap().contains("Hello"));

        // Delete cascades.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/doc-projects/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Subsequent draft GET returns null.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/doc-projects/{id}/draft"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert!(v.is_null());
    }

    #[tokio::test]
    async fn create_rejects_blank_title() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/doc-projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn patch_persists_tags_pinned_archived() {
        let app = app(state_with_store());

        // Create.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/doc-projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"design doc","kind":"design"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        let id = v["id"].as_str().unwrap().to_string();

        // Patch tags + pin + archive in one shot. Whitespace in tags
        // should be trimmed and duplicates dropped.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/doc-projects/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"tags":["q3"," q3 ","ship-ready",""],"pinned":true,"archived":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["pinned"], true);
        assert_eq!(v["archived"], true);
        let tags = v["tags"].as_array().unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0], "q3");
        assert_eq!(tags[1], "ship-ready");

        // Patch with only one field doesn't clobber the others.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/doc-projects/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"pinned":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["pinned"], false);
        assert_eq!(v["archived"], true);
        assert_eq!(v["tags"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn put_draft_unknown_project_returns_404() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/doc-projects/no-such-id/draft")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"content":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
