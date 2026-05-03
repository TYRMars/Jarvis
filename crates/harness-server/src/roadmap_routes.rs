//! REST routes for bootstrapping the workspace's roadmap as Work
//! Requirements.
//!
//! One endpoint, intentionally:
//!
//! - `POST /v1/roadmap/import` — scan the workspace for proposal-style
//!   markdown (`docs/proposals/`, `docs/roadmap/`, `roadmap/`, or
//!   `ROADMAP.md`), parse each file's `**Status:**` line, and
//!   create / update one [`Requirement`](harness_core::Requirement)
//!   per proposal under a workspace-derived
//!   [`Project`](harness_core::Project). Returns the
//!   [`ImportSummary`](harness_requirement::ImportSummary) directly
//!   as the JSON body.
//!
//! Body is optional and accepts the same overrides as the LLM tool:
//! `{ slug?, name?, source_subdir?, prune? }`. A `null` body or `{}`
//! takes the workspace-derived defaults.
//!
//! Returns `503 Service Unavailable` when any of `ProjectStore`,
//! `RequirementStore`, or `workspace_root` aren't configured — same
//! convention as `/v1/projects` and `/v1/todos`.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use harness_requirement::ImportOptions;
use serde_json::json;
use tracing::error;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/roadmap/import", post(import))
}

fn unavailable(reason: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": reason })),
    )
        .into_response()
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "roadmap import error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

async fn import(State(state): State<AppState>, body: Option<Json<ImportOptions>>) -> Response {
    let projects = match state.projects.clone() {
        Some(s) => s,
        None => return unavailable("project store not configured; set JARVIS_DB_URL"),
    };
    let requirements = match state.requirements.clone() {
        Some(s) => s,
        None => return unavailable("requirement store not configured; set JARVIS_DB_URL"),
    };
    let workspace = match state.workspace_root.clone() {
        Some(p) => p,
        None => {
            return unavailable(
                "workspace root not pinned; start the server with --workspace <path>",
            )
        }
    };

    let opts = body.map(|Json(o)| o).unwrap_or_default();
    match harness_requirement::import_proposals(&workspace, &projects, &requirements, opts).await {
        Ok(summary) => (StatusCode::OK, Json(summary)).into_response(),
        Err(e) => internal_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult,
    };
    use harness_store::{MemoryProjectStore, MemoryRequirementStore};
    use std::sync::Arc;
    use tempfile::tempdir;
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

    fn base_state() -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        AppState::new(Arc::new(agent))
            .with_project_store(Arc::new(MemoryProjectStore::new()))
            .with_requirement_store(Arc::new(MemoryRequirementStore::new()))
    }

    #[tokio::test]
    async fn returns_503_without_workspace() {
        let app = router().with_state(base_state());
        let resp = app
            .oneshot(
                Request::post("/v1/roadmap/import")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn imports_proposals_returning_summary() {
        let outer = tempdir().unwrap();
        let workspace = outer.path().join("acme");
        let proposals = workspace.join("docs/proposals");
        std::fs::create_dir_all(&proposals).unwrap();
        std::fs::write(
            proposals.join("alpha.md"),
            "# Alpha\n\n**Status:** Adopted\n\nBody.\n",
        )
        .unwrap();

        let state = base_state().with_workspace_root(workspace);
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::post("/v1/roadmap/import")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["slug"], "acme-roadmap");
        assert_eq!(parsed["created"], 1);
    }
}
