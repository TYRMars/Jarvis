//! REST endpoints for the [`SubAgentRunRegistry`].
//!
//! - `GET /v1/subagents/runs` — list active + recent runs, newest
//!   first.
//! - `GET /v1/subagents/runs/:id` — detail with the recorded
//!   event log.
//! - `POST /v1/subagents/runs/:id/cancel` — cooperative cancel.
//!
//! Returns `503 Service Unavailable` when the binary didn't wire a
//! registry (`AppState.subagent_runs == None`) — matches the
//! convention used by other optional facets (conversation store,
//! requirements store, etc.).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;

use crate::state::AppState;
use crate::state_layers::SubAgentRunsLayer;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/subagents/runs", get(list_runs))
        .route("/v1/subagents/runs/:id", get(get_run))
        .route("/v1/subagents/runs/:id/cancel", post(cancel_run))
}

async fn list_runs(State(runs): State<SubAgentRunsLayer>) -> Response {
    let Some(reg) = runs.registry.as_ref() else {
        return service_unavailable();
    };
    let items = reg.list();
    Json(json!({ "items": items })).into_response()
}

async fn get_run(State(runs): State<SubAgentRunsLayer>, Path(id): Path<String>) -> Response {
    let Some(reg) = runs.registry.as_ref() else {
        return service_unavailable();
    };
    match reg.get(&id) {
        Some(r) => {
            let events = reg.events(&id).unwrap_or_default();
            Json(json!({ "run": r, "events": events })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("subagent run `{id}` not found") })),
        )
            .into_response(),
    }
}

async fn cancel_run(State(runs): State<SubAgentRunsLayer>, Path(id): Path<String>) -> Response {
    let Some(reg) = runs.registry.as_ref() else {
        return service_unavailable();
    };
    let ok = reg.cancel(&id);
    if ok {
        Json(json!({ "cancelled": true })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({
                "cancelled": false,
                "error": "no such running subagent run"
            })),
        )
            .into_response()
    }
}

fn service_unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "subagent runs registry not configured" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::subagent_runs::SubAgentRunRegistry;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
        Result as CoreResult, SubAgentEvent, SubAgentFrame,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    use crate::provider_registry::ProviderRegistry;
    use async_trait::async_trait;

    struct StubLlm;
    #[async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> CoreResult<ChatResponse> {
            Ok(ChatResponse {
                message: Message::assistant_text("ok"),
                finish_reason: FinishReason::Stop,
                response_id: None,
                usage: None,
            })
        }
    }

    fn make_state(reg: Option<Arc<SubAgentRunRegistry>>) -> AppState {
        let mut registry = ProviderRegistry::new("stub");
        registry.insert("stub", Arc::new(StubLlm), "stub-1");
        let agent = Agent::new(Arc::new(StubLlm), AgentConfig::new("stub-1"));
        let mut s = AppState::from_registry(registry, agent.config.clone());
        s.subagent_runs = reg;
        s
    }

    fn frame(id: &str, name: &str, ev: SubAgentEvent) -> SubAgentFrame {
        SubAgentFrame {
            subagent_id: id.into(),
            subagent_name: name.into(),
            event: ev,
        }
    }

    #[tokio::test]
    async fn list_runs_returns_503_when_registry_absent() {
        let state = make_state(None);
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/subagents/runs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn list_runs_returns_recorded_runs() {
        let reg = SubAgentRunRegistry::new();
        reg.record_frame(
            None,
            &frame(
                "run-1",
                "review",
                SubAgentEvent::Started {
                    task: "verify".into(),
                    model: Some("claude-3-5".into()),
                },
            ),
        );
        let state = make_state(Some(reg));
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/subagents/runs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let arr = v["items"].as_array().expect("items");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], "run-1");
        assert_eq!(arr[0]["task"], "verify");
    }

    #[tokio::test]
    async fn get_run_404_when_unknown() {
        let reg = SubAgentRunRegistry::new();
        let state = make_state(Some(reg));
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/subagents/runs/nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cancel_marks_run_cancelled() {
        let reg = SubAgentRunRegistry::new();
        reg.record_frame(
            None,
            &frame(
                "run-2",
                "codex",
                SubAgentEvent::Started {
                    task: "x".into(),
                    model: None,
                },
            ),
        );
        let state = make_state(Some(reg.clone()));
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/subagents/runs/run-2/cancel")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            reg.get("run-2").unwrap().status,
            crate::subagent_runs::SubAgentRunStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn cancel_unknown_run_404() {
        let reg = SubAgentRunRegistry::new();
        let state = make_state(Some(reg));
        let app = router().with_state(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/subagents/runs/missing/cancel")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
