use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use harness_automation::{
    parse_rfc3339, AutomationStatus, AutomationTask, NewAutomationTask, ScheduleSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::automation_runtime::{is_running, spawn_automation_run, RunTrigger};
use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/automations",
            get(list_automations).post(create_automation),
        )
        .route(
            "/v1/automations/:id",
            get(get_automation)
                .patch(patch_automation)
                .delete(delete_automation),
        )
        .route("/v1/automations/:id/run", post(run_automation_now))
}

#[derive(Debug, Serialize)]
struct AutomationsResponse {
    items: Vec<AutomationTask>,
}

#[derive(Debug, Deserialize)]
struct CreateAutomationRequest {
    title: String,
    prompt: String,
    schedule: ScheduleSpec,
    #[serde(default)]
    status: Option<AutomationStatus>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PatchAutomationRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    schedule: Option<ScheduleSpec>,
    #[serde(default)]
    status: Option<AutomationStatus>,
    #[serde(default)]
    provider: Option<Option<String>>,
    #[serde(default)]
    model: Option<Option<String>>,
    #[serde(default)]
    conversation_id: Option<Option<String>>,
}

async fn list_automations(State(state): State<AppState>) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    match store.list().await {
        Ok(items) => Json(AutomationsResponse { items }).into_response(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn create_automation(
    State(state): State<AppState>,
    Json(req): Json<CreateAutomationRequest>,
) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    if let Err(error) = validate_schedule(&req.schedule) {
        return bad_request(error);
    }
    if req.title.trim().is_empty() || req.prompt.trim().is_empty() {
        return bad_request("title and prompt are required");
    }
    let task = AutomationTask::new(NewAutomationTask {
        title: req.title.trim().to_string(),
        prompt: req.prompt,
        schedule: req.schedule,
        status: req.status,
        provider: clean_opt(req.provider),
        model: clean_opt(req.model),
        conversation_id: clean_opt(req.conversation_id),
    });
    match store.upsert(&task).await {
        Ok(()) => (axum::http::StatusCode::CREATED, Json(task)).into_response(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn get_automation(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    match store.get(&id).await {
        Ok(Some(task)) => Json(task).into_response(),
        Ok(None) => not_found(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn patch_automation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PatchAutomationRequest>,
) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    let mut task = match store.get(&id).await {
        Ok(Some(task)) => task,
        Ok(None) => return not_found(),
        Err(error) => return server_error(error.to_string()),
    };
    if let Some(title) = req.title {
        if title.trim().is_empty() {
            return bad_request("title cannot be empty");
        }
        task.title = title.trim().to_string();
    }
    if let Some(prompt) = req.prompt {
        if prompt.trim().is_empty() {
            return bad_request("prompt cannot be empty");
        }
        task.prompt = prompt;
    }
    if let Some(schedule) = req.schedule {
        if let Err(error) = validate_schedule(&schedule) {
            return bad_request(error);
        }
        task.schedule = schedule;
        if !is_running(&task) {
            task.recompute_next_run(chrono::Utc::now());
        }
    }
    if let Some(status) = req.status {
        task.status = status;
    }
    if let Some(provider) = req.provider {
        task.provider = clean_opt(provider);
    }
    if let Some(model) = req.model {
        task.model = clean_opt(model);
    }
    if let Some(conversation_id) = req.conversation_id {
        task.conversation_id = clean_opt(conversation_id);
    }
    task.updated_at = harness_automation::to_rfc3339(chrono::Utc::now());
    match store.upsert(&task).await {
        Ok(()) => Json(task).into_response(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn delete_automation(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    match store.delete(&id).await {
        Ok(true) => axum::http::StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn run_automation_now(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.automations.as_ref() else {
        return unavailable();
    };
    let task = match store.get(&id).await {
        Ok(Some(task)) => task,
        Ok(None) => return not_found(),
        Err(error) => return server_error(error.to_string()),
    };
    if is_running(&task) {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "error": "automation is already running" })),
        )
            .into_response();
    }
    // Reserve synchronously so a manual trigger can't race a just-spawned
    // scheduled run (whose persisted `Running` flag may not have landed
    // yet). A failed claim means a run is already in flight.
    let Some(claim) = state.automation_claims.try_claim(&task.id) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "error": "automation is already running" })),
        )
            .into_response();
    };
    spawn_automation_run(state, task.clone(), RunTrigger::Manual, claim);
    (axum::http::StatusCode::ACCEPTED, Json(task)).into_response()
}

fn validate_schedule(schedule: &ScheduleSpec) -> Result<(), &'static str> {
    match schedule {
        ScheduleSpec::Once { run_at } => parse_rfc3339(run_at)
            .map(|_| ())
            .ok_or("schedule.once.run_at must be RFC3339"),
        ScheduleSpec::Interval {
            every_seconds,
            start_at,
        } => {
            if *every_seconds == 0 {
                return Err("schedule.interval.every_seconds must be greater than zero");
            }
            // Cap the interval at ~10 years. Beyond a sane upper bound the value is
            // almost certainly a mistake, and very large intervals push the next-run
            // arithmetic toward the edge of chrono's representable range.
            const MAX_EVERY_SECONDS: u64 = 60 * 60 * 24 * 366 * 10;
            if *every_seconds > MAX_EVERY_SECONDS {
                return Err("schedule.interval.every_seconds is too large (max ~10 years)");
            }
            if start_at
                .as_deref()
                .is_some_and(|value| parse_rfc3339(value).is_none())
            {
                return Err("schedule.interval.start_at must be RFC3339");
            }
            Ok(())
        }
    }
}

fn clean_opt(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn unavailable() -> Response {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": "automation store not configured" })),
    )
        .into_response()
}

fn bad_request(message: impl Into<String>) -> Response {
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.into() })),
    )
        .into_response()
}

fn not_found() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(json!({ "error": "automation not found" })),
    )
        .into_response()
}

fn server_error(message: String) -> Response {
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn mk_state() -> AppState {
        let cfg = harness_core::AgentConfig::new("stub-model");
        let agent = Arc::new(harness_core::Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent)
    }

    async fn read_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn list_returns_503_when_store_absent() {
        let resp = list_automations(State(mk_state())).await;
        assert_eq!(resp.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_then_list_round_trip() {
        let state =
            mk_state().with_automation_store(Arc::new(harness_store::MemoryAutomationStore::new()));
        let create = create_automation(
            State(state.clone()),
            Json(CreateAutomationRequest {
                title: "Daily digest".into(),
                prompt: "Summarise the project".into(),
                schedule: ScheduleSpec::Interval {
                    every_seconds: 3600,
                    start_at: None,
                },
                status: None,
                provider: None,
                model: None,
                conversation_id: None,
            }),
        )
        .await;
        assert_eq!(create.status(), axum::http::StatusCode::CREATED);
        let created = read_json(create).await;
        assert_eq!(created["title"], "Daily digest");

        let list = list_automations(State(state)).await;
        let body = read_json(list).await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["prompt"], "Summarise the project");
    }

    #[tokio::test]
    async fn create_rejects_invalid_schedule() {
        let state =
            mk_state().with_automation_store(Arc::new(harness_store::MemoryAutomationStore::new()));
        let resp = create_automation(
            State(state),
            Json(CreateAutomationRequest {
                title: "Bad".into(),
                prompt: "Run".into(),
                schedule: ScheduleSpec::Once {
                    run_at: "not-a-date".into(),
                },
                status: None,
                provider: None,
                model: None,
                conversation_id: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn create_rejects_oversized_interval() {
        let state =
            mk_state().with_automation_store(Arc::new(harness_store::MemoryAutomationStore::new()));
        let resp = create_automation(
            State(state),
            Json(CreateAutomationRequest {
                title: "Huge".into(),
                prompt: "Run".into(),
                schedule: ScheduleSpec::Interval {
                    every_seconds: u64::MAX,
                    start_at: None,
                },
                status: None,
                provider: None,
                model: None,
                conversation_id: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
