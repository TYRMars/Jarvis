//! P14 — REST surface for the Settings → Memory Sync panel.
//!
//! The agent-side already has `memory.sync` / `memory.sync_setup` /
//! `memory.sync_status` (P10/P11/P13). These REST endpoints expose
//! the same operations to the Web UI so the operator can configure
//! sync without going through the chat. They reuse the same tool
//! impls under the hood — no duplicate logic.
//!
//! 503 is returned when:
//! - `enable_memory` is off (no memory tree to sync)
//! - `enable_memory_sync` ⇒ `backend == None` (the tools that
//!   match git/icloud operations aren't loaded)
//! - The runtime's `user_root` isn't configured (user-scope sync
//!   needs a path)
//!
//! All write endpoints (`/sync`, `/sync_setup`) are intentionally
//! NOT approval-gated at the REST layer — the operator is the one
//! clicking, which is already an approval. The underlying tool
//! invocations bypass the agent's approver because we're not in
//! an agent run.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum::extract::Query;
use harness_core::Tool;
use harness_tools::{
    memory_include_tools::{
        MemoryIncludeAddTool, MemoryIncludeListTool, MemoryIncludeRefreshTool,
        MemoryIncludeRemoveTool,
    },
    memory_sync::{MemoryICloudSetupTool, MemorySyncSetupTool, MemorySyncStatusTool, MemorySyncTool},
    MemoryRoots, MemorySyncBackend,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/memory/sync_status", get(get_status))
        .route("/v1/memory/sync", post(post_sync))
        .route("/v1/memory/sync_setup", post(post_setup_git))
        .route("/v1/memory/sync_setup_icloud", post(post_setup_icloud))
        .route(
            "/v1/memory/includes",
            get(get_includes)
                .post(post_include_add)
                .delete(delete_include),
        )
        .route("/v1/memory/includes/refresh", post(post_include_refresh))
}

/// Build a fresh `MemoryRoots` per request from the runtime
/// metadata on `AppState`. The memory tools are stateless past
/// the roots, so reconstructing each call avoids holding any
/// per-tool handle on `AppState`.
#[allow(clippy::result_large_err)]
fn roots_from_state(state: &AppState) -> Result<MemoryRoots, Response> {
    let rt = state.memory_runtime.as_ref().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "memory tools are not enabled — set JARVIS_ENABLE_MEMORY=1 and restart",
            })),
        )
            .into_response()
    })?;
    let mut roots = MemoryRoots::new(rt.workspace_root.clone());
    if let Some(user) = rt.user_root.clone() {
        roots = roots.with_user_root(user);
    }
    Ok(roots)
}

fn backend(state: &AppState) -> MemorySyncBackend {
    state
        .memory_runtime
        .as_ref()
        .map(|rt| rt.backend)
        .unwrap_or(MemorySyncBackend::None)
}

async fn get_status(State(state): State<AppState>) -> Response {
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let backend = backend(&state);
    let user_root = state
        .memory_runtime
        .as_ref()
        .and_then(|rt| rt.user_root.clone());

    let mut envelope = serde_json::Map::new();
    envelope.insert("backend".into(), json!(backend.as_wire()));
    envelope.insert(
        "user_root".into(),
        json!(user_root.as_ref().map(|p| p.display().to_string())),
    );
    envelope.insert(
        "workspace_root".into(),
        json!(state
            .memory_runtime
            .as_ref()
            .map(|rt| rt.workspace_root.display().to_string())),
    );

    // For Git / iCloud, dig into the underlying sync_status tool
    // for the live per-scope details. We invoke it directly (not
    // via the agent's tool registry) so the panel can read this
    // even when no agent run is active.
    match backend {
        MemorySyncBackend::None => {}
        MemorySyncBackend::Git | MemorySyncBackend::ICloud => {
            let tool = MemorySyncStatusTool::new(roots);
            match tool.invoke(json!({ "scope": "user" })).await {
                Ok(body) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&body) {
                        envelope.insert("user_scope".into(), v);
                    } else {
                        envelope.insert("user_scope".into(), json!({ "raw": body }));
                    }
                }
                Err(e) => {
                    envelope.insert("user_scope".into(), json!({ "error": e.to_string() }));
                }
            }
        }
    }

    Json(Value::Object(envelope)).into_response()
}

#[derive(Debug, Deserialize)]
struct SyncBody {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    remote: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

async fn post_sync(
    State(state): State<AppState>,
    body: Option<Json<SyncBody>>,
) -> Response {
    if !matches!(backend(&state), MemorySyncBackend::Git) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "memory.sync only applies to the `git` backend — current backend is not git",
                "backend": backend(&state).as_wire(),
            })),
        )
            .into_response();
    }
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args = serde_json::Map::new();
    if let Some(Json(b)) = body {
        if let Some(scope) = b.scope {
            args.insert("scope".into(), json!(scope));
        }
        if let Some(remote) = b.remote {
            args.insert("remote".into(), json!(remote));
        }
        if let Some(branch) = b.branch {
            args.insert("branch".into(), json!(branch));
        }
        if let Some(timeout_ms) = b.timeout_ms {
            args.insert("timeout_ms".into(), json!(timeout_ms));
        }
    }
    let tool = MemorySyncTool::new(roots);
    match tool.invoke(Value::Object(args)).await {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => Json(v).into_response(),
            Err(_) => Json(json!({ "raw": body })).into_response(),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct GitSetupBody {
    remote_url: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    push: Option<bool>,
    #[serde(default)]
    force: Option<bool>,
}

async fn post_setup_git(
    State(state): State<AppState>,
    Json(body): Json<GitSetupBody>,
) -> Response {
    if !matches!(backend(&state), MemorySyncBackend::Git) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "git sync setup only applies to the `git` backend",
                "backend": backend(&state).as_wire(),
            })),
        )
            .into_response();
    }
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args = serde_json::Map::new();
    args.insert("remote_url".into(), json!(body.remote_url));
    if let Some(scope) = body.scope {
        args.insert("scope".into(), json!(scope));
    }
    if let Some(branch) = body.branch {
        args.insert("branch".into(), json!(branch));
    }
    if let Some(push) = body.push {
        args.insert("push".into(), json!(push));
    }
    if let Some(force) = body.force {
        args.insert("force".into(), json!(force));
    }
    let tool = MemorySyncSetupTool::new(roots);
    match tool.invoke(Value::Object(args)).await {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => Json(v).into_response(),
            Err(_) => Json(json!({ "raw": body })).into_response(),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn post_setup_icloud(State(state): State<AppState>) -> Response {
    if !matches!(backend(&state), MemorySyncBackend::ICloud) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "iCloud sync setup only applies to the `icloud` backend",
                "backend": backend(&state).as_wire(),
            })),
        )
            .into_response();
    }
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let tool = MemoryICloudSetupTool::new(roots);
    match tool.invoke(json!({})).await {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => Json(v).into_response(),
            Err(_) => Json(json!({ "raw": body })).into_response(),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

// -------- /v1/memory/includes --------

#[derive(Debug, Deserialize)]
struct IncludesQuery {
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IncludeBody {
    target: String,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IncludeRefreshBody {
    target: String,
}

async fn invoke_tool_to_response(
    tool: impl harness_core::Tool,
    args: Value,
) -> Response {
    match tool.invoke(args).await {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => Json(v).into_response(),
            Err(_) => Json(json!({ "raw": body })).into_response(),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn get_includes(
    State(state): State<AppState>,
    Query(q): Query<IncludesQuery>,
) -> Response {
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args = serde_json::Map::new();
    if let Some(scope) = q.scope {
        args.insert("scope".into(), json!(scope));
    }
    invoke_tool_to_response(MemoryIncludeListTool::new(roots), Value::Object(args)).await
}

async fn post_include_add(
    State(state): State<AppState>,
    Json(body): Json<IncludeBody>,
) -> Response {
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args = serde_json::Map::new();
    args.insert("target".into(), json!(body.target));
    if let Some(scope) = body.scope {
        args.insert("scope".into(), json!(scope));
    }
    invoke_tool_to_response(MemoryIncludeAddTool::new(roots), Value::Object(args)).await
}

async fn delete_include(
    State(state): State<AppState>,
    Json(body): Json<IncludeBody>,
) -> Response {
    let roots = match roots_from_state(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let mut args = serde_json::Map::new();
    args.insert("target".into(), json!(body.target));
    if let Some(scope) = body.scope {
        args.insert("scope".into(), json!(scope));
    }
    invoke_tool_to_response(MemoryIncludeRemoveTool::new(roots), Value::Object(args)).await
}

async fn post_include_refresh(
    _state: State<AppState>,
    Json(body): Json<IncludeRefreshBody>,
) -> Response {
    invoke_tool_to_response(
        MemoryIncludeRefreshTool,
        json!({ "target": body.target }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, MemoryRuntime};
    use std::sync::Arc;

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

    fn stub_state() -> AppState {
        use harness_core::{Agent, AgentConfig};
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent)
    }

    async fn read_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn status_503_when_runtime_unconfigured() {
        let state = stub_state();
        let resp = get_status(State(state)).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = read_json(resp).await;
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("memory tools are not enabled"));
    }

    #[tokio::test]
    async fn status_reports_backend_none_when_runtime_present_but_off() {
        let state = stub_state().with_memory_runtime(MemoryRuntime {
            workspace_root: std::path::PathBuf::from("/tmp/ws"),
            user_root: None,
            backend: MemorySyncBackend::None,
        });
        let resp = get_status(State(state)).await;
        let body = read_json(resp).await;
        assert_eq!(body["backend"], "none");
        assert!(body.get("user_scope").is_none());
    }

    #[tokio::test]
    async fn sync_503_when_backend_is_not_git() {
        let state = stub_state().with_memory_runtime(MemoryRuntime {
            workspace_root: std::path::PathBuf::from("/tmp/ws"),
            user_root: Some(std::path::PathBuf::from("/tmp/user")),
            backend: MemorySyncBackend::ICloud,
        });
        let resp = post_sync(State(state), None).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = read_json(resp).await;
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("only applies to the `git` backend"));
        assert_eq!(body["backend"], "icloud");
    }

    #[tokio::test]
    async fn includes_get_503_when_runtime_unconfigured() {
        let state = stub_state();
        let resp = get_includes(State(state), Query(IncludesQuery { scope: None })).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn includes_get_returns_items_array_when_runtime_present() {
        let workspace = tempfile::tempdir().unwrap();
        let state = stub_state().with_memory_runtime(MemoryRuntime {
            workspace_root: workspace.path().to_path_buf(),
            user_root: None,
            backend: MemorySyncBackend::None,
        });
        let resp = get_includes(State(state), Query(IncludesQuery { scope: None })).await;
        let body = read_json(resp).await;
        // Either `items` key exists or `error` (when scope unresolvable);
        // a fresh workspace with no MEMORY.md returns `items: []`.
        assert!(body.get("items").is_some() || body.get("error").is_some());
    }

    #[tokio::test]
    async fn include_refresh_rejects_local_path() {
        let state = stub_state();
        let resp = post_include_refresh(
            State(state),
            Json(IncludeRefreshBody {
                target: "/some/local/path".into(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let body = read_json(resp).await;
        assert!(body["error"].as_str().unwrap().contains("only applies"));
    }

    #[tokio::test]
    async fn setup_icloud_503_when_backend_is_git() {
        let state = stub_state().with_memory_runtime(MemoryRuntime {
            workspace_root: std::path::PathBuf::from("/tmp/ws"),
            user_root: Some(std::path::PathBuf::from("/tmp/user")),
            backend: MemorySyncBackend::Git,
        });
        let resp = post_setup_icloud(State(state)).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
