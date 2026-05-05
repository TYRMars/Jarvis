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
    derive_slug, validate_column_id, validate_slug, ConversationStore, KanbanColumn, Project,
    ProjectStore, ProjectWorkspace,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::error;

use crate::routes::workspace_snapshot;
use crate::state::AppState;
use crate::worktree::{create_worktree_for_branch, WorktreeOutcome};

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
        .route(
            "/v1/projects/:id_or_slug/workspaces/branches",
            get(workspace_branches),
        )
        .route(
            "/v1/projects/:id_or_slug/workspaces/switch",
            post(workspace_switch),
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
    /// Replace the project's kanban columns wholesale. Pass an empty
    /// vec to revert to the four built-in defaults; pass `None` to
    /// leave the existing setting alone. Each entry is validated
    /// (id shape + non-empty label, no duplicate ids).
    columns: Option<Vec<KanbanColumn>>,
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
    if let Some(cols) = req.columns {
        // Empty vec → revert to defaults (stored as `None` so future
        // changes to the built-in set automatically apply). Otherwise
        // validate each column and persist verbatim.
        if cols.is_empty() {
            p.columns = None;
        } else {
            if let Err(reason) = validate_columns(&cols) {
                return bad_request(&reason);
            }
            p.columns = Some(cols);
        }
        p.touch();
    }

    if let Err(e) = store.save(&p).await {
        return internal_error(e);
    }
    Json(project_to_json(&p)).into_response()
}

/// Validate a column list submitted by the client. Returns an error
/// message suitable for surfacing to the API caller verbatim. Rules:
/// - 1–32 columns
/// - each id passes [`validate_column_id`] (lowercase / digits / `_` / `-`)
/// - ids are unique (case-sensitive)
/// - labels are non-blank after trimming
/// - kind, when set, is one of the four built-in glyph kinds
fn validate_columns(cols: &[KanbanColumn]) -> Result<(), String> {
    if cols.len() > 32 {
        return Err("at most 32 columns are allowed".into());
    }
    let mut seen = std::collections::HashSet::with_capacity(cols.len());
    for col in cols {
        validate_column_id(&col.id).map_err(|reason| format!("column `{}`: {reason}", col.id))?;
        if !seen.insert(col.id.as_str()) {
            return Err(format!("duplicate column id `{}`", col.id));
        }
        if col.label.trim().is_empty() {
            return Err(format!("column `{}`: label must not be blank", col.id));
        }
        if let Some(kind) = col.kind.as_deref() {
            if !matches!(kind, "backlog" | "in_progress" | "review" | "done") {
                return Err(format!(
                    "column `{}`: kind `{kind}` is not one of backlog / in_progress / review / done",
                    col.id
                ));
            }
        }
    }
    Ok(())
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
    let mut out = json!({
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
    });
    // `columns` is omitted from the wire shape when `None` (the "use
    // built-in defaults" sentinel) so legacy clients keep ignoring the
    // field. When customised, the array is emitted verbatim — the
    // KanbanColumn struct's serde derives produce
    // `{id, label, kind?}` per entry.
    if let Some(cols) = &p.columns {
        out["columns"] = serde_json::to_value(cols).unwrap_or(json!([]));
    }
    out
}

// ----------------------- workspace branches -----------------------

#[derive(Debug, Deserialize)]
struct BranchesQuery {
    /// Canonical workspace path; must match one of `project.workspaces[].path`.
    path: String,
}

/// `GET /v1/projects/:id_or_slug/workspaces/branches?path=<canonical>`
/// — list local + remote branches for one of a project's workspaces.
///
/// Path must be in `project.workspaces[]` (we don't probe arbitrary
/// directories). Non-git folders return `{current: null, branches: []}`
/// rather than an error so the UI can render an empty popover.
async fn workspace_branches(
    State(state): State<AppState>,
    Path(id_or_slug): Path<String>,
    Query(q): Query<BranchesQuery>,
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
    if !project.workspaces.iter().any(|w| w.path == q.path) {
        return bad_request("path is not a workspace of this project");
    }
    let path = std::path::PathBuf::from(&q.path);
    let snap = workspace_snapshot(&path).await;
    if snap.get("vcs").and_then(|v| v.as_str()) != Some("git") {
        return Json(json!({ "current": null, "branches": [] })).into_response();
    }
    // `git for-each-ref` is the cheapest way to get a structured branch
    // list. `%(HEAD)` is `*` for the current branch, space otherwise.
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args([
            "for-each-ref",
            "--format=%(HEAD)%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .await;
    let stdout = match out {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            return internal_error(format!(
                "git for-each-ref: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ))
        }
        Err(e) => return internal_error(format!("git for-each-ref: spawn: {e}")),
    };
    let text = String::from_utf8_lossy(&stdout);
    let mut current: Option<String> = None;
    let mut branches: Vec<Value> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        // First char is `*` (current) or ` ` (other); rest is the ref name.
        let (head_marker, name) = line.split_at(1);
        let is_current = head_marker == "*";
        let name = name.trim();
        if name.is_empty() || name == "origin/HEAD" {
            continue;
        }
        // v1.0 heuristic: only `<remote>/<branch>` style names from
        // `refs/remotes` are flagged remote. Local branches that contain
        // a slash (e.g. `feature/foo`) stay local. We can refine by
        // shelling out to `git remote` once we need multi-remote support.
        let is_remote = name.starts_with("origin/");
        if is_current {
            current = Some(name.to_string());
        }
        branches.push(json!({
            "name": name,
            "is_current": is_current,
            "is_remote": is_remote,
        }));
    }
    Json(json!({ "current": current, "branches": branches })).into_response()
}

// ----------------------- workspace switch -----------------------

#[derive(Debug, Deserialize)]
struct SwitchRequest {
    /// Canonical workspace path; must match one of `project.workspaces[].path`.
    path: String,
    /// Branch name to switch to (must already exist locally; remote
    /// branches accepted via `origin/<name>` will land in a detached
    /// state — caller picks).
    branch: String,
    /// `worktree` (default) creates a fresh worktree at
    /// `JARVIS_WORKTREE_ROOT/<branch-slug>-<short-id>` and returns its
    /// path; `checkout` runs `git checkout <branch>` in the workspace
    /// itself.
    #[serde(default = "default_switch_mode")]
    mode: String,
    /// Only respected by `checkout` mode. When `false` (default) and
    /// the workspace is dirty, the call rejects with 409 + a list of
    /// dirty paths so the UI can ask the user to confirm.
    #[serde(default)]
    force: bool,
}

fn default_switch_mode() -> String {
    "worktree".to_string()
}

async fn workspace_switch(
    State(state): State<AppState>,
    Path(id_or_slug): Path<String>,
    Json(req): Json<SwitchRequest>,
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
    if !project.workspaces.iter().any(|w| w.path == req.path) {
        return bad_request("path is not a workspace of this project");
    }
    let branch = req.branch.trim();
    if branch.is_empty() {
        return bad_request("branch must not be empty");
    }
    // Reject anything that smells like a flag — keeps the model from
    // sneaking `--force` etc. through the branch field.
    if branch.starts_with('-') || branch.contains('\n') || branch.contains('\0') {
        return bad_request("branch contains invalid characters");
    }
    let workspace_path = std::path::PathBuf::from(&req.path);

    match req.mode.as_str() {
        "worktree" => {
            // Pick a stable worktree root next to the workspace so it
            // co-locates with whatever the auto-loop scheduler does.
            let wt_root = state
                .workspace_root
                .clone()
                .unwrap_or_else(|| workspace_path.clone())
                .join(".jarvis")
                .join("worktrees");
            let suffix = short_random_suffix();
            let folder = format!("{}-{}", slugify_branch(branch), suffix);
            let target = wt_root.join(folder);
            match create_worktree_for_branch(&workspace_path, &target, branch, false).await {
                WorktreeOutcome::Created(p) => Json(json!({
                    "active_path": p.display().to_string(),
                    "branch": branch,
                    "mode": "worktree",
                }))
                .into_response(),
                WorktreeOutcome::Refused(reason) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": reason })),
                )
                    .into_response(),
            }
        }
        "checkout" => {
            // Dirty check first unless caller forced it.
            if !req.force {
                let status = tokio::process::Command::new("git")
                    .arg("-C")
                    .arg(&workspace_path)
                    .args(["status", "--porcelain"])
                    .output()
                    .await;
                match status {
                    Ok(o) if o.status.success() && !o.stdout.is_empty() => {
                        let dirty: Vec<String> = String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .map(|l| l.to_string())
                            .collect();
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "error": "dirty",
                                "dirty_files": dirty,
                            })),
                        )
                            .into_response();
                    }
                    Ok(o) if !o.status.success() => {
                        return internal_error(format!(
                            "git status: {}",
                            String::from_utf8_lossy(&o.stderr).trim()
                        ))
                    }
                    Ok(_) => {}
                    Err(e) => return internal_error(format!("git status: spawn: {e}")),
                }
            }
            let out = tokio::process::Command::new("git")
                .arg("-C")
                .arg(&workspace_path)
                .args(["checkout", branch])
                .output()
                .await;
            match out {
                Ok(o) if o.status.success() => Json(json!({
                    "active_path": workspace_path.display().to_string(),
                    "branch": branch,
                    "mode": "checkout",
                }))
                .into_response(),
                Ok(o) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": format!(
                            "git checkout failed: {}",
                            String::from_utf8_lossy(&o.stderr).trim()
                        ),
                    })),
                )
                    .into_response(),
                Err(e) => internal_error(format!("git checkout: spawn: {e}")),
            }
        }
        other => bad_request(&format!(
            "mode must be `worktree` or `checkout`, got `{other}`"
        )),
    }
}

/// Convert a branch name into a filesystem-safe slug (no slashes,
/// dots, spaces). Caps length to 32 chars so the worktree folder
/// name doesn't blow up on long descriptive branches.
fn slugify_branch(branch: &str) -> String {
    let s: String = branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed: String = s.trim_matches('-').chars().take(32).collect();
    if trimmed.is_empty() {
        "branch".to_string()
    } else {
        trimmed
    }
}

fn short_random_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Cheap monotonic-ish suffix; we don't need cryptographic
    // randomness — just enough to avoid collision when the user
    // switches between two branches with the same slug.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos & 0xffffff)
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
    async fn create_omits_columns_field_by_default() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.oneshot(json_post(
                "/v1/projects",
                json!({"name": "Default cols", "instructions": "x"}),
            ))
            .await
            .unwrap(),
        )
        .await;
        // No customisation yet — the wire shape stays clean so
        // existing clients don't have to learn about the field.
        assert!(
            body.get("columns").is_none(),
            "unset columns should be omitted, got {body}"
        );
    }

    #[tokio::test]
    async fn update_sets_and_clears_columns() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "Cols", "instructions": "x"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        // Set custom columns.
        let (status, body) = body_json(
            app.clone()
                .oneshot(json_put(
                    &format!("/v1/projects/{id}"),
                    json!({
                        "columns": [
                            {"id": "triage", "label": "Triage", "kind": "backlog"},
                            {"id": "doing",  "label": "Doing",  "kind": "in_progress"},
                            {"id": "blocked","label": "Blocked"},
                        ]
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let cols = body["columns"].as_array().unwrap();
        assert_eq!(cols.len(), 3);
        assert_eq!(cols[0]["id"], "triage");
        assert_eq!(cols[2]["id"], "blocked");
        assert!(
            cols[2].get("kind").is_none(),
            "kindless columns must not serialize a null/empty kind"
        );

        // Empty vec reverts to defaults — `columns` field is omitted
        // from the response.
        let (_, body) = body_json(
            app.oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({"columns": []}),
            ))
            .await
            .unwrap(),
        )
        .await;
        assert!(body.get("columns").is_none());
    }

    #[tokio::test]
    async fn update_rejects_invalid_columns() {
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({"name": "Bad", "instructions": "x"}),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        // Duplicate ids
        let resp = app
            .clone()
            .oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({
                    "columns": [
                        {"id": "x", "label": "X"},
                        {"id": "x", "label": "Y"},
                    ]
                }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Bad id charset
        let resp = app
            .clone()
            .oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({"columns": [{"id": "Bad Id", "label": "Y"}]}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Blank label
        let resp = app
            .clone()
            .oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({"columns": [{"id": "ok", "label": "   "}]}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Unknown kind
        let resp = app
            .oneshot(json_put(
                &format!("/v1/projects/{id}"),
                json!({"columns": [{"id": "ok", "label": "Y", "kind": "magic"}]}),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// Helper: init a real git repo with one commit so HEAD exists.
    async fn init_git_repo_with_branch(dir: &std::path::Path, branch: &str) {
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@t.invalid"],
            vec!["config", "user.name", "t"],
        ] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(&args)
                .output()
                .expect("git");
            assert!(out.status.success());
        }
        std::fs::write(dir.join("seed"), "x").unwrap();
        for args in [vec!["add", "."], vec!["commit", "-q", "-m", "seed"]] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(&args)
                .output()
                .expect("git");
            assert!(out.status.success());
        }
        if branch != "main" {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(["branch", branch])
                .output()
                .expect("git");
            assert!(out.status.success());
        }
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn workspace_branches_lists_local_and_marks_current() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo_with_branch(repo.path(), "feature-x").await;
        let path = repo.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        // Create a project bound to this repo.
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Repo",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let canonical = body["workspaces"][0]["path"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/projects/{id}/workspaces/branches?path={}",
                        canonical.replace(' ', "%20")
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["current"], "main");
        let names: Vec<&str> = body["branches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"feature-x"));
    }

    #[tokio::test]
    async fn workspace_branches_returns_empty_for_non_git_path() {
        let plain = tempfile::tempdir().unwrap();
        let path = plain.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Plain",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let canonical = body["workspaces"][0]["path"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/projects/{id}/workspaces/branches?path={}",
                        canonical.replace(' ', "%20")
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["current"], Value::Null);
        assert_eq!(body["branches"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn workspace_branches_400s_for_unknown_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "P",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/projects/{id}/workspaces/branches?path={}",
                        "/totally/different/path"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn workspace_switch_worktree_creates_new_path() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo_with_branch(repo.path(), "feature-x").await;
        let path = repo.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Repo",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let canonical = body["workspaces"][0]["path"].as_str().unwrap().to_string();

        let (status, body) = body_json(
            app.oneshot(json_post(
                &format!("/v1/projects/{id}/workspaces/switch"),
                json!({
                    "path": canonical,
                    "branch": "feature-x",
                    "mode": "worktree",
                }),
            ))
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "worktree");
        assert_eq!(body["branch"], "feature-x");
        let active = body["active_path"].as_str().unwrap();
        assert!(std::path::Path::new(active).exists());
        assert!(active.contains(".jarvis"));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn workspace_switch_checkout_rejects_dirty() {
        let repo = tempfile::tempdir().unwrap();
        init_git_repo_with_branch(repo.path(), "feature-x").await;
        std::fs::write(repo.path().join("dirty"), "z").unwrap();
        let path = repo.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Repo",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let canonical = body["workspaces"][0]["path"].as_str().unwrap().to_string();

        let resp = app
            .oneshot(json_post(
                &format!("/v1/projects/{id}/workspaces/switch"),
                json!({
                    "path": canonical,
                    "branch": "feature-x",
                    "mode": "checkout",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn workspace_switch_400s_for_invalid_branch() {
        let repo = tempfile::tempdir().unwrap();
        let path = repo.path().to_string_lossy().to_string();
        let app = full_router(make_state());
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post(
                    "/v1/projects",
                    json!({
                        "name": "Repo",
                        "instructions": "x",
                        "workspaces": [{ "path": path }],
                    }),
                ))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let canonical = body["workspaces"][0]["path"].as_str().unwrap().to_string();

        let resp = app
            .oneshot(json_post(
                &format!("/v1/projects/{id}/workspaces/switch"),
                json!({
                    "path": canonical,
                    "branch": "--force",
                    "mode": "worktree",
                }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
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
