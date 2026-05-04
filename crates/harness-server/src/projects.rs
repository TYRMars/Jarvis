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
use harness_core::{
    derive_slug, validate_slug, ConversationStore, Project, ProjectStore, ProjectWorkspace,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::error;

use crate::routes::workspace_snapshot;
use crate::state::AppState;

/// Total wall-clock budget for one `/v1/projects/:id/workspaces/status`
/// call. With `tokio::join_all` and per-process git probes (~50ms each
/// in the happy path), this is plenty for a typical 1–10 workspace
/// project; anything that misses the budget surfaces as
/// `vcs: "unknown"` for that row, not a blanket 504.
const WORKSPACES_STATUS_TIMEOUT: Duration = Duration::from_millis(1500);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/projects", post(create).get(list))
        .route(
            "/v1/projects/:id_or_slug",
            get(get_one).put(update).delete(delete_one),
        )
        .route("/v1/projects/:id/restore", post(restore))
        .route(
            "/v1/projects/:id_or_slug/workspaces/status",
            get(workspaces_status),
        )
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
    /// Optional initial workspaces. Each path is resolved (`~`, relative)
    /// and validated as a directory before the project is saved; any
    /// invalid entry rejects the whole create with `400 Bad Request`.
    #[serde(default)]
    workspaces: Vec<ProjectWorkspaceInput>,
}

/// Wire shape for a workspace entry on POST / PUT bodies. We accept a
/// looser variant than `ProjectWorkspace` (path may be `~`-prefixed)
/// and canonicalise on the server before persisting.
#[derive(Debug, Deserialize)]
struct ProjectWorkspaceInput {
    path: String,
    #[serde(default)]
    name: Option<String>,
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
    if !req.workspaces.is_empty() {
        match canonicalise_workspaces(req.workspaces).await {
            Ok(ws) => p.set_workspaces(ws),
            Err(resp) => return resp,
        }
    }
    if let Err(e) = store.save(&p).await {
        return internal_error(e);
    }
    (StatusCode::CREATED, Json(project_to_json(&p))).into_response()
}

/// Resolve `~` and relative paths, run `tokio::fs::canonicalize`, and
/// confirm each entry is a directory. The whole batch is rejected on the
/// first failure so callers always see a consistent saved state.
///
/// Trims display `name` and folds empty strings to `None`. Drops
/// duplicate paths (preserving order) so the UI can't accidentally
/// double-list the same workspace.
async fn canonicalise_workspaces(
    raw: Vec<ProjectWorkspaceInput>,
) -> Result<Vec<ProjectWorkspace>, Response> {
    let mut out: Vec<ProjectWorkspace> = Vec::with_capacity(raw.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for entry in raw {
        let trimmed_path = entry.path.trim();
        if trimmed_path.is_empty() {
            return Err(bad_request("workspace path must not be empty"));
        }
        let expanded = expand_tilde(trimmed_path);
        let canonical = match tokio::fs::canonicalize(&expanded).await {
            Ok(p) => p,
            Err(e) => {
                return Err(bad_request(&format!(
                    "workspace `{}` is not reachable: {e}",
                    trimmed_path
                )))
            }
        };
        if !canonical.is_dir() {
            return Err(bad_request(&format!(
                "workspace `{}` is not a directory",
                canonical.display()
            )));
        }
        let path = canonical.display().to_string();
        if !seen.insert(path.clone()) {
            // Duplicate — silently drop. Keeps the JSON shape compact.
            continue;
        }
        let name = entry
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        out.push(ProjectWorkspace { path, name });
    }
    Ok(out)
}

fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            let mut p = std::path::PathBuf::from(home);
            p.push(rest);
            return p;
        }
    }
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home);
        }
    }
    std::path::PathBuf::from(path)
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
    /// `Some(...)` replaces the whole list. Pass `Some(vec![])` to
    /// clear all workspaces; pass `None` to leave them untouched.
    workspaces: Option<Vec<ProjectWorkspaceInput>>,
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
    if let Some(ws_in) = req.workspaces {
        match canonicalise_workspaces(ws_in).await {
            Ok(ws) => p.set_workspaces(ws),
            Err(resp) => return resp,
        }
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

// ----------------------- workspaces status -----------------------

/// `GET /v1/projects/:id_or_slug/workspaces/status` — fan-out git
/// probes across each of a project's `workspaces` and return the
/// snapshots in the same order the project records them.
///
/// Total wall-clock budget is `WORKSPACES_STATUS_TIMEOUT`; entries
/// that miss the budget come back as `vcs: "unknown"` rather than
/// holding up the rest. Each row's `workspace_snapshot` already
/// degrades gracefully when the path isn't a git repo (`vcs:
/// "none"`).
async fn workspaces_status(
    State(state): State<AppState>,
    Path(id_or_slug): Path<String>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let project = match load_by_id_or_slug(&*store, &id_or_slug).await {
        Ok(Some(p)) => p,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };

    if project.workspaces.is_empty() {
        return Json(Vec::<Value>::new()).into_response();
    }

    // Spawn one probe per entry. We collect indexed results because
    // `tokio::time::timeout` over `join_all` resolves once everyone
    // finishes; the indices are only useful if we add per-row
    // timeouts later — leaving them in for clarity.
    let probes: Vec<_> = project
        .workspaces
        .iter()
        .cloned()
        .enumerate()
        .map(|(idx, ws)| async move {
            let path = std::path::PathBuf::from(&ws.path);
            let snap = workspace_snapshot(&path).await;
            (idx, ws, snap)
        })
        .collect();
    let collected = match tokio::time::timeout(
        WORKSPACES_STATUS_TIMEOUT,
        futures::future::join_all(probes),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => {
            // Total timeout — return one synthetic row per workspace so
            // the UI still gets a stable shape and can retry.
            let rows: Vec<Value> = project
                .workspaces
                .iter()
                .map(|ws| {
                    let mut entry = json!({
                        "path": ws.path,
                        "vcs": "unknown",
                        "error": "git probe timed out",
                    });
                    if let Some(name) = &ws.name {
                        entry["name"] = json!(name);
                    }
                    entry
                })
                .collect();
            return Json(rows).into_response();
        }
    };

    let mut rows: Vec<Value> = Vec::with_capacity(collected.len());
    for (_idx, ws, snap) in collected {
        // workspace_snapshot returns {root, vcs, branch?, head?, dirty?}
        // — we re-key to the workspace's stored path / name so the
        // client can match rows up with project.workspaces by index.
        let mut entry = json!({
            "path": ws.path,
            "vcs": snap.get("vcs").cloned().unwrap_or(json!("unknown")),
        });
        if let Some(name) = &ws.name {
            entry["name"] = json!(name);
        }
        if let Some(b) = snap.get("branch") {
            entry["branch"] = b.clone();
        }
        if let Some(h) = snap.get("head") {
            entry["head"] = h.clone();
        }
        if let Some(d) = snap.get("dirty") {
            entry["dirty"] = d.clone();
        }
        rows.push(entry);
    }
    Json(rows).into_response()
}

// ----------------------- helpers -----------------------

fn bad_request(reason: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response()
}

fn project_to_json(p: &Project) -> Value {
    let workspaces: Vec<Value> = p
        .workspaces
        .iter()
        .map(|w| {
            let mut entry = json!({ "path": w.path });
            if let Some(name) = &w.name {
                entry["name"] = json!(name);
            }
            entry
        })
        .collect();
    json!({
        "id": p.id,
        "slug": p.slug,
        "name": p.name,
        "description": p.description,
        "instructions": p.instructions,
        "tags": p.tags,
        "workspaces": workspaces,
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
                response_id: None,
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
    async fn create_with_workspaces_canonicalises_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let app = full_router(make_state());

        let (status, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Multi",
                        "instructions": "x",
                        "workspaces": [
                            { "path": path, "name": "Primary" },
                            { "path": path }, // duplicate, should be deduped
                        ],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let ws = body["workspaces"].as_array().unwrap();
        assert_eq!(ws.len(), 1, "duplicate path should be deduped");
        assert_eq!(ws[0]["name"], "Primary");
        assert!(ws[0]["path"].as_str().unwrap().ends_with(
            std::path::Path::new(&path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        ));
    }

    #[tokio::test]
    async fn create_with_unreachable_workspace_is_400() {
        let app = full_router(make_state());
        let resp = app
            .oneshot(json_post(
                "/v1/projects",
                json!({
                    "name": "Bad",
                    "instructions": "x",
                    "workspaces": [{ "path": "/this/path/should/not/exist/abc123" }],
                }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_can_replace_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let app = full_router(make_state());

        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "P", "instructions": "x"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        // Set workspaces.
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_put(
                    &format!("/v1/projects/{id}"),
                    json!({"workspaces": [{ "path": path }]}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 1);

        // Clear by passing empty vec.
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_put(
                    &format!("/v1/projects/{id}"),
                    json!({"workspaces": []}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 0);

        // Omitting `workspaces` leaves the existing list untouched.
        // Set them again, then send a no-op patch.
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_put(
                    &format!("/v1/projects/{id}"),
                    json!({"workspaces": [{ "path": path }]}),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 1);
        let (_, body) = body_json(
            app.oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({"name": "Renamed"}),
            ))
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(body["name"], "Renamed");
    }

    #[tokio::test]
    async fn workspaces_status_returns_per_path_snapshot() {
        // Two tempdirs: one git-init'd, one not.
        let git_dir = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(git_dir.path())
            .arg("init")
            .arg("-q")
            .status()
            .expect("git init");
        let plain_dir = tempfile::tempdir().unwrap();
        let git_path = git_dir.path().to_string_lossy().to_string();
        let plain_path = plain_dir.path().to_string_lossy().to_string();

        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Repos",
                        "instructions": "x",
                        "workspaces": [
                            { "path": git_path, "name": "Repo" },
                            { "path": plain_path },
                        ],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/projects/{id}/workspaces/status"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let rows = body.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        // Project.workspaces order is preserved.
        assert_eq!(rows[0]["name"], "Repo");
        assert_eq!(rows[0]["vcs"], "git");
        assert_eq!(rows[1]["vcs"], "none");
        // Non-git rows omit branch / dirty.
        assert!(rows[1].get("branch").is_none());
    }

    #[tokio::test]
    async fn workspaces_status_returns_empty_when_no_workspaces() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "Empty", "instructions": "x"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/projects/{id}/workspaces/status"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 0);
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
