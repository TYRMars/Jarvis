//! REST routes for the self-improving-agent surface — Phase 0.
//!
//! Phase 0 of `docs/proposals/self-improving-agent.zh-CN.md` ("可观测但不自动写"):
//! everything is read-only telemetry + a write endpoint for tools to record
//! events. No mutation of skills, no memory writes, no review fork — those
//! land in later phases under separate trait surfaces.
//!
//! Endpoints:
//!
//! | Method | Path                                  | Body / Query                     | Returns                              |
//! |--------|---------------------------------------|----------------------------------|--------------------------------------|
//! | GET    | `/v1/learning/skill-usage`            | `?skill=…&action=…&limit=…`      | `{events: SkillUsageEvent[]}`        |
//! | GET    | `/v1/learning/skill-usage/report`     | same filters                     | `{rows: SkillUsageRow[]}`            |
//! | POST   | `/v1/learning/skill-usage`            | `SkillUsageEvent` (id/ts auto)   | `{event: SkillUsageEvent}` (201)     |
//!
//! Returns `503 Service Unavailable` when `AppState::learning_skill_usage`
//! is `None` so callers can distinguish "not configured" from "really broken".

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use harness_learning::{
    SkillScope, SkillUsageAction, SkillUsageEvent, SkillUsageFilter, SkillUsageStore,
};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;
use crate::state_layers::LearningLayer;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/learning/skill-usage",
            get(list_skill_usage).post(record_skill_usage),
        )
        .route("/v1/learning/skill-usage/report", get(report_skill_usage))
}

#[derive(Debug, Deserialize)]
struct SkillUsageQuery {
    skill: Option<String>,
    action: Option<SkillUsageAction>,
    /// `user` | `project` | `workspace`. When set, `scope_value` must
    /// be set for `project` / `workspace` (the project id / workspace
    /// path). `scope_value` is ignored for `user`.
    scope: Option<String>,
    scope_value: Option<String>,
    conversation_id: Option<String>,
    limit: Option<u32>,
}

impl SkillUsageQuery {
    #[allow(clippy::result_large_err)]
    fn into_filter(self) -> Result<SkillUsageFilter, Response> {
        let scope = match (self.scope.as_deref(), self.scope_value) {
            (None, _) => None,
            (Some("user"), _) => Some(SkillScope::User),
            (Some("project"), Some(v)) => Some(SkillScope::project(v)),
            (Some("workspace"), Some(v)) => Some(SkillScope::workspace(v)),
            (Some("project"), None) | (Some("workspace"), None) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "scope_value required for scope=project|workspace"})),
                )
                    .into_response());
            }
            (Some(other), _) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": format!("unknown scope: {other}")})),
                )
                    .into_response());
            }
        };
        Ok(SkillUsageFilter {
            skill_name: self.skill,
            action: self.action,
            scope,
            conversation_id: self.conversation_id,
            limit: self.limit,
        })
    }
}

#[allow(clippy::result_large_err)]
fn store(layer: &LearningLayer) -> Result<Arc<dyn SkillUsageStore>, Response> {
    layer.skill_usage.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "learning store not configured"})),
        )
            .into_response()
    })
}

async fn list_skill_usage(
    State(layer): State<LearningLayer>,
    Query(query): Query<SkillUsageQuery>,
) -> Response {
    let store = match store(&layer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let filter = match query.into_filter() {
        Ok(f) => f,
        Err(r) => return r,
    };
    // Cap default page size — without a `limit` the JSON-file backend
    // walks the whole events directory.
    let mut filter = filter;
    if filter.limit.is_none() {
        filter.limit = Some(200);
    }
    match store.list_events(filter).await {
        Ok(events) => Json(json!({"events": events})).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

async fn report_skill_usage(
    State(layer): State<LearningLayer>,
    Query(query): Query<SkillUsageQuery>,
) -> Response {
    let store = match store(&layer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let filter = match query.into_filter() {
        Ok(f) => f,
        Err(r) => return r,
    };
    match store.report(filter).await {
        Ok(rows) => Json(json!({"rows": rows})).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

async fn record_skill_usage(
    State(layer): State<LearningLayer>,
    Json(body): Json<SkillUsageEvent>,
) -> Response {
    let store = match store(&layer) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.record_event(body).await {
        Ok(event) => (StatusCode::CREATED, Json(json!({"event": event}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::body::Body;
    use axum::http::Request;
    use harness_core::{Agent, AgentConfig, ChatRequest, ChatResponse, Error, LlmProvider};
    use harness_store::MemorySkillUsageStore;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// Stub LLM — `AppState::new` needs one. Learning routes don't
    /// touch the agent.
    struct StubLlm;
    #[async_trait::async_trait]
    impl LlmProvider for StubLlm {
        async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
            Err(Error::Provider("stub".into()))
        }
    }

    fn base_agent() -> Arc<Agent> {
        Arc::new(Agent::new(
            Arc::new(StubLlm) as Arc<dyn LlmProvider>,
            AgentConfig::new("stub-model"),
        ))
    }

    fn test_state() -> AppState {
        AppState::new(base_agent())
            .with_skill_usage_store(Arc::new(MemorySkillUsageStore::new()))
    }

    #[tokio::test]
    async fn list_returns_recorded_events_newest_first() {
        let state = test_state();
        let router = crate::routes::router(state);

        // Record two events.
        for action in ["viewed", "used"] {
            let body = serde_json::json!({
                "id": "",
                "skill_name": "rust",
                "source": "user",
                "action": action,
                "scope": {"kind": "user"},
                "created_at": "",
                "attributes": null,
            });
            let req = Request::builder()
                .method("POST")
                .uri("/v1/learning/skill-usage")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            let resp = router.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::CREATED);
        }

        // List them back.
        let req = Request::builder()
            .uri("/v1/learning/skill-usage?skill=rust")
            .body(Body::empty())
            .unwrap();
        let resp = router.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let events = v["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn returns_503_when_no_store() {
        let state = AppState::new(base_agent());
        let router = crate::routes::router(state);
        let req = Request::builder()
            .uri("/v1/learning/skill-usage")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn report_aggregates_view_and_use_counts() {
        let state = test_state();
        let router = crate::routes::router(state);
        for action in ["viewed", "used", "used"] {
            let body = serde_json::json!({
                "id": "",
                "skill_name": "rust",
                "source": "user",
                "action": action,
                "scope": {"kind": "user"},
                "created_at": "",
                "attributes": null,
            });
            let req = Request::builder()
                .method("POST")
                .uri("/v1/learning/skill-usage")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            router.clone().oneshot(req).await.unwrap();
        }
        let req = Request::builder()
            .uri("/v1/learning/skill-usage/report")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let rows = v["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["skill_name"], "rust");
        assert_eq!(rows[0]["view_count"], 1);
        assert_eq!(rows[0]["use_count"], 2);
    }
}
