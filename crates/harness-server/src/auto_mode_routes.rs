//! v1.0 — REST surface for the runtime auto-mode toggle.
//!
//! - `GET  /v1/auto-mode` → `{enabled, configured}` (`configured`
//!   reports whether the binary even wired up an
//!   [`AutoModeRuntime`]; tests / mcp-serve return `configured:
//!   false` and `enabled: false`).
//! - `POST /v1/auto-mode` body `{enabled: bool}` flips the flag.
//!   503 when the binary didn't wire one up.
//!
//! Tick-cadence latency: at most one `JARVIS_WORK_TICK_SECONDS`
//! interval — the loop polls the flag at the top of each tick. The
//! flip itself is atomic + immediate.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/auto-mode", get(get_auto_mode).post(set_auto_mode))
}

async fn get_auto_mode(State(state): State<AppState>) -> Response {
    let runtime = state.auto_mode_runtime.as_ref();
    Json(json!({
        "configured": runtime.is_some(),
        "enabled": runtime.map(|r| r.is_enabled()).unwrap_or(false),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct SetBody {
    enabled: bool,
}

async fn set_auto_mode(State(state): State<AppState>, Json(body): Json<SetBody>) -> Response {
    let Some(runtime) = state.auto_mode_runtime.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "auto-mode runtime not configured" })),
        )
            .into_response();
    };
    runtime.set_enabled(body.enabled);
    Json(json!({
        "configured": true,
        "enabled": body.enabled,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auto_mode::{AutoMode, AutoModeRuntime};
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use harness_core::{Agent, AgentConfig, ChatRequest, ChatResponse, Error};
    use std::sync::Arc;
    use tower::ServiceExt;

    struct StubLlm;
    #[async_trait::async_trait]
    impl harness_core::LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Err(Error::Provider("stub".into()))
        }
    }

    fn base_state(runtime: Option<AutoModeRuntime>) -> AppState {
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        let mut s = AppState::new(agent);
        if let Some(r) = runtime {
            s = s.with_auto_mode_runtime(r);
        }
        s
    }

    fn app(state: AppState) -> axum::Router {
        super::router().with_state(state)
    }

    async fn read_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn get_returns_configured_false_when_no_runtime() {
        let resp = app(base_state(None))
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["configured"], false);
        assert_eq!(v["enabled"], false);
    }

    #[tokio::test]
    async fn post_returns_503_when_no_runtime() {
        let resp = app(base_state(None))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/auto-mode")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn round_trip_get_post_get() {
        let runtime = AutoModeRuntime::new(AutoMode::Off);
        let state = base_state(Some(runtime.clone()));
        // initially disabled
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_json(resp).await["enabled"], false);
        // flip on
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/auto-mode")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_json(resp).await["enabled"], true);
        assert!(runtime.is_enabled(), "shared runtime flag flipped on");
        // read back
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read_json(resp).await["enabled"], true);
    }
}
