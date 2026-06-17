//! Project-connector REST surface (proposal: project-connectors.zh-CN.md,
//! Phase 1 with GitHub Issues first per the feature-gap audit).
//!
//! ```text
//! GET  /v1/connectors                                  → registered connector kinds
//! GET  /v1/connectors/accounts                         → account rows
//! POST /v1/connectors/:connector/accounts              → create account {display_name, auth_ref}
//! DELETE /v1/connectors/accounts/:id
//! GET  /v1/connectors/:connector/projects?account_id=… → list remote projects
//! POST /v1/connectors/:connector/import                → bind + initial pull
//! GET  /v1/project-bindings?project_id=…
//! POST /v1/project-bindings/:id/sync                   → re-pull (idempotent upsert)
//! POST /v1/requirement-bindings/:id/push               → write-back {action?, comment?, force?}
//! ```
//!
//! 503 when the stores / secret resolver are unconfigured (the
//! workspace-wide convention). The local store stays the source of
//! truth: pulls only create/refresh rows, never delete; pushes are
//! explicit caller actions, never derived from local status changes.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use harness_connectors::{
    ConnectorAccount, ConnectorAuth, ConnectorError, ProjectBinding, ProjectConnector,
    RemoteIssue, RemoteIssueState, RequirementBinding, RequirementPush,
};
use harness_project::{
    Activity, ActivityActor, ActivityKind, Project, Requirement, RequirementStatus,
};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use harness_project::derive_slug;
use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/connectors", get(list_connectors))
        .route("/v1/connectors/accounts", get(list_accounts))
        .route("/v1/connectors/accounts/:id", axum::routing::delete(delete_account))
        .route("/v1/connectors/:connector/accounts", post(create_account))
        .route("/v1/connectors/:connector/projects", get(list_remote_projects))
        .route("/v1/connectors/:connector/import", post(import_remote_project))
        .route("/v1/project-bindings", get(list_project_bindings))
        .route("/v1/project-bindings/:id/sync", post(sync_project_binding))
        .route("/v1/requirement-bindings/:id/push", post(push_requirement_binding))
}

// ---------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------

struct ConnectorCtx {
    connector: Arc<dyn ProjectConnector>,
    accounts: Arc<dyn harness_connectors::ConnectorAccountStore>,
    project_bindings: Arc<dyn harness_connectors::ProjectBindingStore>,
    requirement_bindings: Arc<dyn harness_connectors::RequirementBindingStore>,
}

#[allow(clippy::result_large_err)]
fn ctx(state: &AppState, connector_id: &str) -> Result<ConnectorCtx, Response> {
    let (Some(accounts), Some(project_bindings), Some(requirement_bindings)) = (
        state.connector_accounts.clone(),
        state.connector_project_bindings.clone(),
        state.connector_requirement_bindings.clone(),
    ) else {
        return Err(unavailable("connector stores not configured"));
    };
    let Some(connector) = state.connectors.iter().find(|c| c.id() == connector_id).cloned()
    else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("unknown connector: {connector_id}")})),
        )
            .into_response());
    };
    Ok(ConnectorCtx {
        connector,
        accounts,
        project_bindings,
        requirement_bindings,
    })
}

#[allow(clippy::result_large_err)]
fn resolve_auth(state: &AppState, account: &ConnectorAccount) -> Result<ConnectorAuth, Response> {
    let Some(resolver) = state.connector_secrets.as_ref() else {
        return Err(unavailable("connector secret resolver not configured"));
    };
    match resolver(&account.auth_ref) {
        Some(token) if !token.trim().is_empty() => Ok(ConnectorAuth { token }),
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!(
                    "secret `{}` not resolvable; set the environment variable and restart",
                    account.auth_ref
                )
            })),
        )
            .into_response()),
    }
}

fn unavailable(msg: &str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": msg}))).into_response()
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": e.to_string()})),
    )
        .into_response()
}

fn connector_error(e: ConnectorError) -> Response {
    let status = match &e {
        ConnectorError::Auth(_) => StatusCode::BAD_GATEWAY,
        ConnectorError::NotFound(_) => StatusCode::NOT_FOUND,
        ConnectorError::Conflict { .. } => StatusCode::CONFLICT,
        ConnectorError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
        ConnectorError::Other(_) => StatusCode::BAD_GATEWAY,
    };
    (status, Json(json!({"error": e.to_string()}))).into_response()
}

async fn record_connector_activity(state: &AppState, requirement_id: &str, body: serde_json::Value) {
    let Some(store) = state.activities.as_ref() else {
        return;
    };
    let activity = Activity::new(
        requirement_id,
        ActivityKind::ConnectorSync,
        ActivityActor::System,
        body,
    );
    if let Err(e) = store.append(&activity).await {
        warn!(error = %e, requirement_id, "failed to append connector Activity");
    }
}

// ---------------------------------------------------------------------
// Connector kinds + accounts
// ---------------------------------------------------------------------

async fn list_connectors(State(state): State<AppState>) -> Response {
    let kinds: Vec<_> = state
        .connectors
        .iter()
        .map(|c| json!({"id": c.id(), "display_name": c.display_name()}))
        .collect();
    Json(json!({"items": kinds})).into_response()
}

async fn list_accounts(State(state): State<AppState>) -> Response {
    let Some(store) = state.connector_accounts.as_ref() else {
        return unavailable("connector stores not configured");
    };
    match store.list().await {
        Ok(items) => Json(json!({"items": items})).into_response(),
        Err(e) => internal_error(e),
    }
}

#[derive(Debug, Deserialize)]
struct CreateAccountRequest {
    display_name: String,
    /// Name of the secret (v1: env-var name). Never a raw token — a
    /// value that looks like one is rejected to keep tokens out of the
    /// store.
    auth_ref: String,
}

async fn create_account(
    State(state): State<AppState>,
    Path(connector_id): Path<String>,
    Json(req): Json<CreateAccountRequest>,
) -> Response {
    let cx = match ctx(&state, &connector_id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let auth_ref = req.auth_ref.trim();
    // Heuristic tripwire: env-var names are short and SCREAMING_SNAKE;
    // anything long or token-shaped is almost certainly a pasted secret.
    let looks_like_token = auth_ref.len() > 64
        || auth_ref
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_'));
    if auth_ref.is_empty() || looks_like_token {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "auth_ref must be the NAME of a secret (e.g. GITHUB_TOKEN), never the token itself"
            })),
        )
            .into_response();
    }
    let account = ConnectorAccount::new(cx.connector.id(), req.display_name.trim(), auth_ref);
    match cx.accounts.upsert(&account).await {
        Ok(()) => (StatusCode::CREATED, Json(json!({"account": account}))).into_response(),
        Err(e) => internal_error(e),
    }
}

async fn delete_account(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.connector_accounts.as_ref() else {
        return unavailable("connector stores not configured");
    };
    match store.delete(&id).await {
        Ok(deleted) => Json(json!({"deleted": deleted})).into_response(),
        Err(e) => internal_error(e),
    }
}

// ---------------------------------------------------------------------
// Remote listing + import
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RemoteProjectsQuery {
    account_id: String,
}

async fn list_remote_projects(
    State(state): State<AppState>,
    Path(connector_id): Path<String>,
    Query(q): Query<RemoteProjectsQuery>,
) -> Response {
    let cx = match ctx(&state, &connector_id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let account = match cx.accounts.get(&q.account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "unknown account", "id": q.account_id})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let auth = match resolve_auth(&state, &account) {
        Ok(a) => a,
        Err(r) => return r,
    };
    match cx.connector.list_remote_projects(&auth).await {
        Ok(items) => Json(json!({"items": items})).into_response(),
        Err(e) => connector_error(e),
    }
}

#[derive(Debug, Deserialize)]
struct ImportRequest {
    account_id: String,
    /// Connector-scoped remote project id (GitHub: `owner/repo`).
    remote_project_id: String,
    /// Bind into this existing Jarvis project (id or slug). Mutually
    /// exclusive with `name`; when both absent a project named after
    /// the remote id is created.
    #[serde(default)]
    project_id: Option<String>,
    /// Name for a newly created Jarvis project.
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Default, serde::Serialize)]
struct SyncSummary {
    created: usize,
    updated: usize,
    unchanged: usize,
}

async fn import_remote_project(
    State(state): State<AppState>,
    Path(connector_id): Path<String>,
    Json(req): Json<ImportRequest>,
) -> Response {
    let cx = match ctx(&state, &connector_id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (Some(projects), Some(requirements)) = (state.projects.clone(), state.requirements.clone())
    else {
        return unavailable("project/requirement stores not configured");
    };
    let account = match cx.accounts.get(&req.account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "unknown account", "id": req.account_id})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let auth = match resolve_auth(&state, &account) {
        Ok(a) => a,
        Err(r) => return r,
    };

    // Refuse a second binding for the same (connector, remote project):
    // two bindings would race the same remote rows into two projects.
    match cx.project_bindings.list(None).await {
        Ok(existing) => {
            if let Some(b) = existing.iter().find(|b| {
                b.connector == cx.connector.id() && b.remote_project_id == req.remote_project_id
            }) {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": "remote project already bound",
                        "binding_id": b.id,
                        "project_id": b.project_id,
                    })),
                )
                    .into_response();
            }
        }
        Err(e) => return internal_error(e),
    }

    // Resolve or create the target Jarvis project.
    let project = if let Some(id_or_slug) = req.project_id.as_deref() {
        let by_id = projects.load(id_or_slug).await;
        let resolved = match by_id {
            Ok(Some(p)) => Ok(Some(p)),
            Ok(None) => projects.find_by_slug(id_or_slug).await,
            Err(e) => Err(e),
        };
        match resolved {
            Ok(Some(p)) => p,
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error": "unknown project", "id": id_or_slug})),
                )
                    .into_response();
            }
            Err(e) => return internal_error(e),
        }
    } else {
        let name = req
            .name
            .clone()
            .unwrap_or_else(|| req.remote_project_id.clone());
        let mut p = Project::new(
            &name,
            format!(
                "Imported from {} ({})",
                cx.connector.display_name(),
                req.remote_project_id
            ),
        );
        p.slug = derive_slug(&name);
        if let Err(e) = projects.save(&p).await {
            return internal_error(e);
        }
        p
    };

    let mut binding = ProjectBinding::new(
        cx.connector.id(),
        &account.id,
        &project.id,
        &req.remote_project_id,
    );

    let summary = match pull_into(
        &state,
        &cx,
        &auth,
        &mut binding,
        requirements.as_ref(),
    )
    .await
    {
        Ok(s) => s,
        Err(r) => return r,
    };

    if let Err(e) = cx.project_bindings.upsert(&binding).await {
        return internal_error(e);
    }

    (
        StatusCode::CREATED,
        Json(json!({
            "binding": binding,
            "project_id": project.id,
            "summary": summary,
        })),
    )
        .into_response()
}

// ---------------------------------------------------------------------
// Bindings: list + sync
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct BindingsQuery {
    #[serde(default)]
    project_id: Option<String>,
}

async fn list_project_bindings(
    State(state): State<AppState>,
    Query(q): Query<BindingsQuery>,
) -> Response {
    let Some(store) = state.connector_project_bindings.as_ref() else {
        return unavailable("connector stores not configured");
    };
    match store.list(q.project_id.as_deref()).await {
        Ok(items) => Json(json!({"items": items})).into_response(),
        Err(e) => internal_error(e),
    }
}

async fn sync_project_binding(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(binding_store) = state.connector_project_bindings.clone() else {
        return unavailable("connector stores not configured");
    };
    let mut binding = match binding_store.get(&id).await {
        Ok(Some(b)) => b,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "unknown project binding", "id": id})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let cx = match ctx(&state, &binding.connector.clone()) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(requirements) = state.requirements.clone() else {
        return unavailable("requirement store not configured");
    };
    let account = match cx.accounts.get(&binding.account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "binding's account no longer exists", "id": binding.account_id})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let auth = match resolve_auth(&state, &account) {
        Ok(a) => a,
        Err(r) => return r,
    };

    let summary = match pull_into(&state, &cx, &auth, &mut binding, requirements.as_ref()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Err(e) = binding_store.upsert(&binding).await {
        return internal_error(e);
    }
    Json(json!({"binding": binding, "summary": summary})).into_response()
}

/// Pull the remote project's issues and upsert them as requirements.
///
/// Idempotency key: `(project_binding_id, remote_task_id)` via the
/// requirement-binding store. New issues become `Backlog` (open) /
/// `Done` (closed) rows; existing rows only refresh `title` /
/// `description` — local status, todos, verification plans, triage and
/// dependency edges are Jarvis-owned and never overwritten by a pull.
async fn pull_into(
    state: &AppState,
    cx: &ConnectorCtx,
    auth: &ConnectorAuth,
    binding: &mut ProjectBinding,
    requirements: &dyn harness_project::RequirementStore,
) -> Result<SyncSummary, Response> {
    let pulled = cx
        .connector
        .pull_requirements(auth, binding)
        .await
        .map_err(connector_error)?;

    let mut summary = SyncSummary::default();
    for issue in &pulled.issues {
        match cx
            .requirement_bindings
            .find_by_remote(&binding.id, &issue.id)
            .await
        {
            Ok(Some(mut rb)) => {
                let changed =
                    refresh_existing(requirements, &rb.requirement_id, issue).await?;
                rb.remote_updated_at = issue.updated_at.clone();
                rb.remote_url = issue.url.clone();
                rb.touch();
                cx.requirement_bindings
                    .upsert(&rb)
                    .await
                    .map_err(internal_error)?;
                if changed {
                    summary.updated += 1;
                } else {
                    summary.unchanged += 1;
                }
            }
            Ok(None) => {
                let mut req = Requirement::new(&binding.project_id, &issue.title);
                req.description = issue.body.clone();
                req.status = match issue.state {
                    RemoteIssueState::Open => RequirementStatus::Backlog,
                    RemoteIssueState::Closed => RequirementStatus::Done,
                };
                requirements.upsert(&req).await.map_err(internal_error)?;

                let mut rb =
                    RequirementBinding::new(cx.connector.id(), &binding.id, &req.id, &issue.id);
                rb.remote_url = issue.url.clone();
                rb.remote_updated_at = issue.updated_at.clone();
                cx.requirement_bindings
                    .upsert(&rb)
                    .await
                    .map_err(internal_error)?;

                record_connector_activity(
                    state,
                    &req.id,
                    json!({
                        "connector": cx.connector.id(),
                        "action": "imported",
                        "remote_task_id": issue.id,
                        "remote_url": issue.url,
                    }),
                )
                .await;
                summary.created += 1;
            }
            Err(e) => return Err(internal_error(e)),
        }
    }
    if pulled.cursor.is_some() {
        binding.sync_cursor = pulled.cursor;
    }
    binding.touch();
    Ok(summary)
}

/// Refresh title/description of an already-imported requirement.
/// Returns whether anything changed. A vanished local row is not an
/// error — the binding is simply stale (v1 keeps it; no auto-repair).
async fn refresh_existing(
    requirements: &dyn harness_project::RequirementStore,
    requirement_id: &str,
    issue: &RemoteIssue,
) -> Result<bool, Response> {
    let Some(mut req) = requirements
        .get(requirement_id)
        .await
        .map_err(internal_error)?
    else {
        return Ok(false);
    };
    let mut changed = false;
    if req.title != issue.title && !issue.title.trim().is_empty() {
        req.title = issue.title.clone();
        changed = true;
    }
    if req.description != issue.body {
        req.description = issue.body.clone();
        changed = true;
    }
    if changed {
        req.touch();
        requirements.upsert(&req).await.map_err(internal_error)?;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------
// Push (write-back)
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PushRequest {
    #[serde(flatten)]
    change: RequirementPush,
    /// Skip the remote-conflict check (after the caller has looked at
    /// the 409 payload and decided to overwrite).
    #[serde(default)]
    force: bool,
}

async fn push_requirement_binding(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PushRequest>,
) -> Response {
    if req.change.action.is_none()
        && req
            .change
            .comment
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "push needs an `action` and/or a non-empty `comment`"})),
        )
            .into_response();
    }
    let Some(rb_store) = state.connector_requirement_bindings.clone() else {
        return unavailable("connector stores not configured");
    };
    let mut rb = match rb_store.get(&id).await {
        Ok(Some(b)) => b,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "unknown requirement binding", "id": id})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let cx = match ctx(&state, &rb.connector.clone()) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let project_binding = match cx.project_bindings.get(&rb.project_binding_id).await {
        Ok(Some(b)) => b,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "binding's project binding no longer exists"})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let account = match cx.accounts.get(&project_binding.account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "binding's account no longer exists"})),
            )
                .into_response();
        }
        Err(e) => return internal_error(e),
    };
    let auth = match resolve_auth(&state, &account) {
        Ok(a) => a,
        Err(r) => return r,
    };

    // Conflict gate: if the remote moved since our last pull/push,
    // surface 409 with both timestamps instead of overwriting blind.
    if !req.force {
        match cx
            .connector
            .fetch_issue(&auth, &project_binding, &rb.remote_task_id)
            .await
        {
            Ok(remote) => {
                if let (Some(remote_now), Some(baseline)) =
                    (remote.updated_at.as_deref(), rb.remote_updated_at.as_deref())
                {
                    if remote_now > baseline {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "error": "remote issue changed since last sync; re-sync or pass force=true",
                                "remote_updated_at": remote_now,
                                "last_synced_at": baseline,
                            })),
                        )
                            .into_response();
                    }
                }
            }
            Err(e) => return connector_error(e),
        }
    }

    let result = match cx
        .connector
        .push_requirement(&auth, &project_binding, &rb.remote_task_id, &req.change)
        .await
    {
        Ok(r) => r,
        Err(e) => return connector_error(e),
    };

    let now = chrono::Utc::now().to_rfc3339();
    rb.last_pushed_at = Some(now);
    if result.remote_updated_at.is_some() {
        rb.remote_updated_at = result.remote_updated_at.clone();
    }
    rb.touch();
    if let Err(e) = rb_store.upsert(&rb).await {
        return internal_error(e);
    }

    record_connector_activity(
        &state,
        &rb.requirement_id,
        json!({
            "connector": cx.connector.id(),
            "action": "pushed",
            "remote_task_id": rb.remote_task_id,
            "push_action": req.change.action,
            "commented": req.change.comment.is_some(),
        }),
    )
    .await;

    Json(json!({"binding": rb})).into_response()
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use harness_connectors::{PullResult, PushAction, PushResult, RemoteProject};
    use harness_core::{Agent, AgentConfig, ChatRequest, ChatResponse, Error, LlmProvider};
    use harness_store::{
        MemoryActivityStore, MemoryConnectorAccountStore, MemoryProjectBindingStore,
        MemoryProjectStore, MemoryRequirementBindingStore, MemoryRequirementStore,
    };
    use std::sync::Mutex;
    use tower::ServiceExt;

    struct StubLlm;
    #[async_trait::async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Err(Error::Provider("stub".into()))
        }
    }

    /// Scripted connector: serves a fixed issue list, records pushes.
    struct MockConnector {
        issues: Mutex<Vec<RemoteIssue>>,
        pushes: Mutex<Vec<(String, RequirementPush)>>,
        /// What `fetch_issue` reports as the remote's updated_at.
        remote_updated_at: Mutex<Option<String>>,
    }

    impl MockConnector {
        fn new(issues: Vec<RemoteIssue>) -> Self {
            Self {
                issues: Mutex::new(issues),
                pushes: Mutex::new(Vec::new()),
                remote_updated_at: Mutex::new(None),
            }
        }
    }

    #[async_trait::async_trait]
    impl ProjectConnector for MockConnector {
        fn id(&self) -> &'static str {
            "mock"
        }
        fn display_name(&self) -> &'static str {
            "Mock Tracker"
        }
        async fn list_remote_projects(
            &self,
            _auth: &ConnectorAuth,
        ) -> Result<Vec<RemoteProject>, ConnectorError> {
            Ok(vec![RemoteProject {
                id: "acme/demo".into(),
                name: "demo".into(),
                url: None,
                description: None,
            }])
        }
        async fn pull_requirements(
            &self,
            _auth: &ConnectorAuth,
            _binding: &ProjectBinding,
        ) -> Result<PullResult, ConnectorError> {
            Ok(PullResult {
                issues: self.issues.lock().unwrap().clone(),
                cursor: None,
            })
        }
        async fn fetch_issue(
            &self,
            _auth: &ConnectorAuth,
            _binding: &ProjectBinding,
            remote_task_id: &str,
        ) -> Result<RemoteIssue, ConnectorError> {
            let issues = self.issues.lock().unwrap();
            let mut issue = issues
                .iter()
                .find(|i| i.id == remote_task_id)
                .cloned()
                .ok_or_else(|| ConnectorError::NotFound("no such issue".into()))?;
            if let Some(ts) = self.remote_updated_at.lock().unwrap().clone() {
                issue.updated_at = Some(ts);
            }
            Ok(issue)
        }
        async fn push_requirement(
            &self,
            _auth: &ConnectorAuth,
            _binding: &ProjectBinding,
            remote_task_id: &str,
            change: &RequirementPush,
        ) -> Result<PushResult, ConnectorError> {
            self.pushes
                .lock()
                .unwrap()
                .push((remote_task_id.to_string(), change.clone()));
            Ok(PushResult {
                remote_updated_at: Some("2026-06-10T12:00:00Z".into()),
            })
        }
    }

    fn issue(id: &str, title: &str, state: RemoteIssueState) -> RemoteIssue {
        RemoteIssue {
            id: id.into(),
            title: title.into(),
            body: Some(format!("body of {title}")),
            state,
            url: Some(format!("https://example.test/{id}")),
            labels: vec![],
            updated_at: Some("2026-06-09T00:00:00Z".into()),
        }
    }

    fn test_state(mock: Arc<MockConnector>) -> AppState {
        AppState::new(Arc::new(Agent::new(
            Arc::new(StubLlm) as Arc<dyn LlmProvider>,
            AgentConfig::new("stub-model"),
        )))
        .with_project_store(Arc::new(MemoryProjectStore::new()))
        .with_requirement_store(Arc::new(MemoryRequirementStore::new()))
        .with_activity_store(Arc::new(MemoryActivityStore::new()))
        .with_connector(mock)
        .with_connector_stores(
            Arc::new(MemoryConnectorAccountStore::new()),
            Arc::new(MemoryProjectBindingStore::new()),
            Arc::new(MemoryRequirementBindingStore::new()),
        )
        .with_connector_secrets(Arc::new(|name: &str| {
            (name == "MOCK_TOKEN").then(|| "secret".to_string())
        }))
    }

    async fn post_json(
        router: &axum::Router,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, v)
    }

    async fn setup_account(router: &axum::Router) -> String {
        let (status, v) = post_json(
            router,
            "/v1/connectors/mock/accounts",
            json!({"display_name": "test", "auth_ref": "MOCK_TOKEN"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
        v["account"]["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn create_account_rejects_token_shaped_auth_ref() {
        let state = test_state(Arc::new(MockConnector::new(vec![])));
        let router = crate::routes::router(state);
        let (status, v) = post_json(
            &router,
            "/v1/connectors/mock/accounts",
            json!({"display_name": "x", "auth_ref": "ghp_AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789x"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
    }

    #[tokio::test]
    async fn import_creates_project_requirements_and_bindings() {
        let mock = Arc::new(MockConnector::new(vec![
            issue("1", "open thing", RemoteIssueState::Open),
            issue("2", "closed thing", RemoteIssueState::Closed),
        ]));
        let state = test_state(mock);
        let requirements = state.requirements.clone().unwrap();
        let rb_store = state.connector_requirement_bindings.clone().unwrap();
        let router = crate::routes::router(state);
        let account_id = setup_account(&router).await;

        let (status, v) = post_json(
            &router,
            "/v1/connectors/mock/import",
            json!({"account_id": account_id, "remote_project_id": "acme/demo"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
        assert_eq!(v["summary"]["created"], 2);
        let binding_id = v["binding"]["id"].as_str().unwrap();
        let project_id = v["project_id"].as_str().unwrap();

        let rows = requirements.list(project_id).await.unwrap();
        assert_eq!(rows.len(), 2);
        let open = rows.iter().find(|r| r.title == "open thing").unwrap();
        assert_eq!(open.status, RequirementStatus::Backlog);
        let closed = rows.iter().find(|r| r.title == "closed thing").unwrap();
        assert_eq!(closed.status, RequirementStatus::Done);

        let bindings = rb_store.list_for_project_binding(binding_id).await.unwrap();
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().all(|b| b.remote_updated_at.is_some()));
    }

    #[tokio::test]
    async fn second_import_of_same_remote_conflicts_and_sync_is_idempotent() {
        let mock = Arc::new(MockConnector::new(vec![issue(
            "1",
            "first title",
            RemoteIssueState::Open,
        )]));
        let state = test_state(mock.clone());
        let requirements = state.requirements.clone().unwrap();
        let router = crate::routes::router(state);
        let account_id = setup_account(&router).await;

        let (status, v) = post_json(
            &router,
            "/v1/connectors/mock/import",
            json!({"account_id": account_id, "remote_project_id": "acme/demo"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let binding_id = v["binding"]["id"].as_str().unwrap().to_string();
        let project_id = v["project_id"].as_str().unwrap().to_string();

        // Re-import of the same remote is refused.
        let (status, _) = post_json(
            &router,
            "/v1/connectors/mock/import",
            json!({"account_id": account_id, "remote_project_id": "acme/demo"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Local-only field survives a re-sync; remote retitle lands.
        let mut row = requirements
            .list(&project_id)
            .await
            .unwrap()
            .pop()
            .unwrap();
        row.status = RequirementStatus::InProgress;
        requirements.upsert(&row).await.unwrap();
        mock.issues.lock().unwrap()[0].title = "renamed title".into();

        let (status, v) = post_json(
            &router,
            &format!("/v1/project-bindings/{binding_id}/sync"),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
        assert_eq!(v["summary"]["created"], 0);
        assert_eq!(v["summary"]["updated"], 1);

        let rows = requirements.list(&project_id).await.unwrap();
        assert_eq!(rows.len(), 1, "sync must not duplicate rows");
        assert_eq!(rows[0].title, "renamed title");
        assert_eq!(
            rows[0].status,
            RequirementStatus::InProgress,
            "pull must never clobber local status"
        );
    }

    #[tokio::test]
    async fn push_close_records_and_stamps_binding_with_conflict_gate() {
        let mock = Arc::new(MockConnector::new(vec![issue(
            "1",
            "thing",
            RemoteIssueState::Open,
        )]));
        let state = test_state(mock.clone());
        let rb_store = state.connector_requirement_bindings.clone().unwrap();
        let activities = state.activities.clone().unwrap();
        let router = crate::routes::router(state);
        let account_id = setup_account(&router).await;

        let (_, v) = post_json(
            &router,
            "/v1/connectors/mock/import",
            json!({"account_id": account_id, "remote_project_id": "acme/demo"}),
        )
        .await;
        let binding_id = v["binding"]["id"].as_str().unwrap();
        let rb = rb_store
            .list_for_project_binding(binding_id)
            .await
            .unwrap()
            .pop()
            .unwrap();

        // Empty push is a 400.
        let (status, _) =
            post_json(&router, &format!("/v1/requirement-bindings/{}/push", rb.id), json!({}))
                .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // Remote moved since the import → 409 without force.
        *mock.remote_updated_at.lock().unwrap() = Some("2026-06-09T09:00:00Z".into());
        let (status, v) = post_json(
            &router,
            &format!("/v1/requirement-bindings/{}/push", rb.id),
            json!({"action": "close", "comment": "done by jarvis"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{v}");
        assert!(mock.pushes.lock().unwrap().is_empty(), "no push on conflict");

        // force=true overrides.
        let (status, v) = post_json(
            &router,
            &format!("/v1/requirement-bindings/{}/push", rb.id),
            json!({"action": "close", "comment": "done by jarvis", "force": true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
        {
            let pushes = mock.pushes.lock().unwrap();
            assert_eq!(pushes.len(), 1);
            assert_eq!(pushes[0].0, "1");
            assert_eq!(pushes[0].1.action, Some(PushAction::Close));
        }

        let saved = rb_store.get(&rb.id).await.unwrap().unwrap();
        assert!(saved.last_pushed_at.is_some());
        assert_eq!(
            saved.remote_updated_at.as_deref(),
            Some("2026-06-10T12:00:00Z"),
            "push result becomes the new conflict baseline"
        );

        let acts = activities.list_for_requirement(&rb.requirement_id).await.unwrap();
        assert!(
            acts.iter().any(|a| a.kind == ActivityKind::ConnectorSync),
            "push must leave an audit row"
        );
    }
}
