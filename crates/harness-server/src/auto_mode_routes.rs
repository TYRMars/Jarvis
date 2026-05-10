//! v1.0 — REST surface for the runtime auto-mode toggle.
//!
//! - `GET  /v1/auto-mode` → status snapshot. Always 200 — when the
//!   binary didn't wire a runtime, `configured: false` is returned
//!   and the config / permits fields are omitted. When configured,
//!   the response carries the resolved `AutoModeConfig` numbers
//!   (cadence, caps, retries, run timeout) plus live runtime state
//!   (`available_permits`, `last_tick_at`) so the dashboard can
//!   render the scheduler header strip without separate calls.
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
use serde_json::{json, Map, Value};

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/auto-mode", get(get_auto_mode).post(set_auto_mode))
}

async fn get_auto_mode(State(state): State<AppState>) -> Response {
    let runtime = state.auto_mode_runtime.as_ref();
    let mut body = Map::new();
    let configured = runtime.is_some();
    let enabled = runtime.map(|r| r.is_enabled()).unwrap_or(false);
    body.insert("configured".into(), Value::Bool(configured));
    body.insert("enabled".into(), Value::Bool(enabled));
    // `effective_mode` is what the loop *is doing right now* — the
    // ANDed view of "runtime configured" and "operator-toggled
    // enabled". Yesterday's `mode` field reports the startup config
    // verbatim, which diverges from runtime as soon as someone hits
    // POST /v1/auto-mode. Clients that just want to know "is the
    // scheduler picking work?" should read this field; the original
    // `mode` is kept for back-compat.
    body.insert(
        "effective_mode".into(),
        Value::from(if configured && enabled {
            "auto"
        } else {
            "off"
        }),
    );
    if let Some(rt) = runtime {
        body.insert(
            "available_permits".into(),
            Value::from(rt.available_permits()),
        );
        body.insert(
            "last_tick_at".into(),
            rt.last_tick_at().map(Value::from).unwrap_or(Value::Null),
        );
    }
    if let Some(cfg) = state.auto_mode_config.as_ref() {
        body.insert("mode".into(), Value::from(cfg.mode.as_wire()));
        body.insert("tick_seconds".into(), Value::from(cfg.tick_seconds));
        body.insert(
            "max_units_per_tick".into(),
            Value::from(cfg.max_units_per_tick),
        );
        body.insert(
            "max_concurrent_units".into(),
            Value::from(cfg.max_concurrent_units),
        );
        // Surface both the static config value and the live override
        // (when set), so dashboards can show "configured X, currently
        // Y" without a separate call.
        body.insert("max_retries".into(), Value::from(cfg.max_retries));
        let effective_max_retries = match runtime {
            Some(rt) => rt.effective_max_retries(cfg),
            None => cfg.max_retries,
        };
        body.insert(
            "effective_max_retries".into(),
            Value::from(effective_max_retries),
        );
        if let Some(rt) = runtime {
            if let Some(override_value) = rt.max_retries_override() {
                body.insert(
                    "max_retries_override".into(),
                    Value::from(override_value),
                );
            }
        }
        body.insert("run_timeout_ms".into(), Value::from(cfg.run_timeout_ms));
    }
    Json(Value::Object(body)).into_response()
}

#[derive(Debug, Deserialize)]
struct SetBody {
    /// Optional in v1.2 (was required). Omit to leave the flag as-is
    /// when callers only want to bump retry budget.
    #[serde(default)]
    enabled: Option<bool>,
    /// Optional v1.2 hot-reload of `max_retries`. `Some(0)` clears
    /// the override; `Some(n)` for n > 0 sets it; `None` leaves it
    /// untouched. The picker reads
    /// `runtime.effective_max_retries(config)` so the change takes
    /// effect on the next tick (≤ `tick_seconds` later).
    #[serde(default)]
    max_retries: Option<usize>,
}

async fn set_auto_mode(State(state): State<AppState>, Json(body): Json<SetBody>) -> Response {
    let Some(runtime) = state.auto_mode_runtime.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "auto-mode runtime not configured" })),
        )
            .into_response();
    };
    if let Some(flag) = body.enabled {
        runtime.set_enabled(flag);
    }
    if let Some(value) = body.max_retries {
        // 0 is the "clear override" sentinel; anything else is the
        // new ceiling. The picker hard-skips at `consecutive_failed
        // >= max_retries`, so a value of 0 there would refuse all
        // retries — operators who genuinely want that should change
        // the static config instead.
        runtime.set_max_retries_override(if value == 0 { None } else { Some(value) });
    }
    let mut response = serde_json::Map::new();
    response.insert("configured".into(), Value::Bool(true));
    response.insert("enabled".into(), Value::Bool(runtime.is_enabled()));
    if let Some(cfg) = state.auto_mode_config.as_ref() {
        response.insert(
            "effective_max_retries".into(),
            Value::from(runtime.effective_max_retries(cfg)),
        );
    }
    if let Some(override_value) = runtime.max_retries_override() {
        response.insert(
            "max_retries_override".into(),
            Value::from(override_value),
        );
    }
    Json(Value::Object(response)).into_response()
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

    /// v1.2 — `effective_mode` is the runtime ANDed view of
    /// "configured && enabled". The static `mode` field reflects
    /// startup config and diverges from runtime as soon as the
    /// operator hits POST. Dashboards reading `effective_mode`
    /// should always match what the loop is actually doing.
    #[tokio::test]
    async fn get_reports_effective_mode() {
        // No runtime: configured=false, enabled=false, effective_mode=off.
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
        assert_eq!(v["effective_mode"], "off");

        // Runtime present + disabled by default.
        let runtime = AutoModeRuntime::new(AutoMode::Off);
        let state = base_state(Some(runtime.clone()));
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["configured"], true);
        assert_eq!(v["enabled"], false);
        assert_eq!(v["effective_mode"], "off");

        // Flip on.
        runtime.set_enabled(true);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["enabled"], true);
        assert_eq!(v["effective_mode"], "auto");
    }

    /// v1.2 — POST accepts an optional `max_retries` to hot-reload
    /// the picker's retry cap without a restart. Sentinel `0`
    /// clears the override; positive values set it. The `enabled`
    /// field is now optional (omit to leave alone).
    #[tokio::test]
    async fn post_max_retries_round_trips() {
        let runtime = AutoModeRuntime::new(AutoMode::Auto);
        let cfg = Arc::new(crate::auto_mode::AutoModeConfig {
            mode: AutoMode::Auto,
            tick_seconds: 30,
            max_units_per_tick: 1,
            max_concurrent_units: 2,
            max_retries: 1, // static — what the picker would otherwise see
            run_timeout_ms: 60_000,
            allow_unassigned: true,
            default_assignee: None,
            workflow_prompt: None,
            reviewer_auto_accept: false,
        });
        let state = base_state(Some(runtime.clone())).with_auto_mode_config(cfg);

        // Initially no override; effective == static.
        assert!(runtime.max_retries_override().is_none());

        // POST with max_retries=5 sets the override.
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/auto-mode")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"max_retries":5}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["max_retries_override"], 5);
        assert_eq!(v["effective_max_retries"], 5);
        // `enabled` was not in the body — runtime keeps prior value.
        assert!(runtime.is_enabled(), "enabled left untouched when omitted");

        // GET reflects the same.
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["max_retries"], 1, "static config remains visible");
        assert_eq!(v["max_retries_override"], 5);
        assert_eq!(v["effective_max_retries"], 5);

        // POST with max_retries=0 clears the override.
        let resp = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/auto-mode")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"max_retries":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert!(v.get("max_retries_override").is_none());
        assert_eq!(v["effective_max_retries"], 1);
        assert!(runtime.max_retries_override().is_none());
    }

    #[tokio::test]
    async fn get_returns_config_snapshot_when_configured() {
        let runtime = AutoModeRuntime::with_capacity(AutoMode::Auto, 3);
        runtime.record_tick();
        let cfg = Arc::new(crate::auto_mode::AutoModeConfig {
            mode: AutoMode::Auto,
            tick_seconds: 7,
            max_units_per_tick: 4,
            max_concurrent_units: 3,
            max_retries: 2,
            run_timeout_ms: 60_000,
            allow_unassigned: false,
            default_assignee: Some("alice".into()),
            workflow_prompt: None,
            reviewer_auto_accept: false,
        });
        let state = base_state(Some(runtime.clone())).with_auto_mode_config(cfg);
        let resp = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/auto-mode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = read_json(resp).await;
        assert_eq!(v["configured"], true);
        assert_eq!(v["enabled"], true);
        assert_eq!(v["mode"], "auto");
        assert_eq!(v["tick_seconds"], 7);
        assert_eq!(v["max_units_per_tick"], 4);
        assert_eq!(v["max_concurrent_units"], 3);
        assert_eq!(v["max_retries"], 2);
        assert_eq!(v["run_timeout_ms"], 60_000);
        assert!(v.get("allow_unassigned").is_none());
        assert!(v.get("default_assignee").is_none());
        assert_eq!(v["available_permits"], 3);
        assert!(v["last_tick_at"].is_string());
    }
}
