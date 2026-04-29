//! REST routes for the persistent project TODO board.
//!
//! Mounted only when [`AppState::todos`] is set. Returns `503`
//! otherwise — same convention as the conversation / project /
//! permission routes.
//!
//! Endpoints:
//!
//! - `GET    /v1/todos?workspace=<abs>` — list (default workspace =
//!   the server's pinned root).
//! - `POST   /v1/todos`                 — create
//!   (body: `{title, status?, notes?, workspace?}`).
//! - `PATCH  /v1/todos/:id`             — partial update
//!   (body: any subset of `{title, status, notes}`).
//! - `DELETE /v1/todos/:id`             — remove.
//!
//! WS clients subscribe via the existing chat socket; the broadcast
//! bridge in `routes.rs` filters [`TodoEvent`]s by the socket's
//! pinned workspace and forwards as `todo_upserted` /
//! `todo_deleted` frames. Both REST and tool mutations use the
//! store's [`TodoStore::subscribe`] fanout, so a single mutation
//! reaches every connected client without duplicate emits.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, patch},
    Router,
};
use harness_core::{canonicalize_workspace, TodoItem, TodoPriority, TodoStatus, TodoStore};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/todos", get(list_todos).post(create_todo))
        .route("/v1/todos/:id", patch(update_todo).delete(delete_todo))
}

#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn TodoStore>, Response> {
    state.todos.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "todo store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "todo store error");
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

// ----------------------- GET /v1/todos -----------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    workspace: Option<String>,
}

async fn list_todos(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(workspace) = resolve_workspace(&state, q.workspace.as_deref()) else {
        return bad_request(
            "no workspace pinned on the server; pass `?workspace=<abs path>` explicitly",
        );
    };
    match store.list(&workspace).await {
        Ok(items) => Json(json!({ "workspace": workspace, "items": items })).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- POST /v1/todos -----------------------

#[derive(Debug, Deserialize)]
struct CreateBody {
    title: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
}

async fn create_todo(State(state): State<AppState>, Json(body): Json<CreateBody>) -> Response {
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
    let mut item = TodoItem::new(workspace, title);
    if let Some(s) = body.status.as_deref() {
        match TodoStatus::from_wire(s) {
            Some(parsed) => item.status = parsed,
            None => return bad_request(format!("unknown status `{s}`")),
        }
    }
    if let Some(p) = body.priority.as_deref().filter(|p| !p.is_empty()) {
        match TodoPriority::from_wire(p) {
            Some(parsed) => item.priority = Some(parsed),
            None => return bad_request(format!("unknown priority `{p}`")),
        }
    }
    item.notes = body
        .notes
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    match store.upsert(&item).await {
        Ok(()) => (StatusCode::CREATED, item_json(&item)).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- PATCH /v1/todos/:id -----------------------

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// `Some("")` clears the priority; `None` leaves it as-is.
    #[serde(default)]
    priority: Option<String>,
    /// `Some("")` clears the note; `None` leaves it as-is.
    #[serde(default)]
    notes: Option<String>,
}

async fn update_todo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut item = match store.get(&id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("todo `{id}` not found") })),
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
    if let Some(s) = body.status.as_deref() {
        match TodoStatus::from_wire(s) {
            Some(parsed) => item.status = parsed,
            None => return bad_request(format!("unknown status `{s}`")),
        }
    }
    if let Some(p) = body.priority {
        item.priority = if p.trim().is_empty() {
            None
        } else {
            match TodoPriority::from_wire(p.trim()) {
                Some(parsed) => Some(parsed),
                None => return bad_request(format!("unknown priority `{p}`")),
            }
        };
    }
    if let Some(n) = body.notes {
        item.notes = if n.trim().is_empty() {
            None
        } else {
            Some(n.trim().to_string())
        };
    }
    item.touch();
    match store.upsert(&item).await {
        Ok(()) => item_json(&item).into_response(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- DELETE /v1/todos/:id -----------------------

async fn delete_todo(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "deleted": false, "error": format!("todo `{id}` not found") })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

fn item_json(item: &TodoItem) -> Json<Value> {
    Json(serde_json::to_value(item).unwrap_or_else(|e| json!({ "error": e.to_string() })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_store::MemoryTodoStore;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Minimal stub LLM provider so we can build an `AppState`. The
    /// TODO routes don't touch the agent, but `AppState::new` needs
    /// one.
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
        AppState::new(agent).with_workspace_root(std::path::PathBuf::from("/tmp/test-repo"))
    }

    fn state_with_store() -> AppState {
        let store: Arc<dyn TodoStore> = Arc::new(MemoryTodoStore::new());
        base_state().with_todo_store(store)
    }

    fn app(state: AppState) -> axum::Router {
        super::router().with_state(state)
    }

    async fn read_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn returns_503_when_store_absent() {
        let resp = app(base_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/todos")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_then_list_round_trip() {
        let state = state_with_store();
        let app = app(state);

        // Create.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/todos")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"refactor parser"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let v = read_json(resp).await;
        assert_eq!(v["title"], "refactor parser");
        assert_eq!(v["status"], "pending");
        let id = v["id"].as_str().unwrap().to_string();

        // List.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/todos")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["items"].as_array().unwrap().len(), 1);

        // Patch (mark completed).
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/v1/todos/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"completed"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = read_json(resp).await;
        assert_eq!(v["status"], "completed");

        // Delete.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/todos/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Second delete → 404.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/todos/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_rejects_blank_title() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/todos")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_unknown_id_returns_404() {
        let resp = app(state_with_store())
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/v1/todos/no-such-id")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"x"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
