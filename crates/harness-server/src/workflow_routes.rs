//! REST surface for declarative workflows.
//!
//! Mirrors `automation_routes.rs`: every handler 503s when
//! `state.workflows` is unset, so tests / specialised binaries that don't
//! wire the store get a clean "not configured" signal instead of a panic.
//!
//! - `GET/POST /v1/workflows` — list / create definitions.
//! - `GET/PATCH/DELETE /v1/workflows/:id` — fetch / update / delete.
//! - `POST /v1/workflows/:id/run` — dispatch a run (optionally bound to a
//!   requirement); returns `202` + the `Running` [`WorkflowRun`].
//! - `GET /v1/workflows/:id/runs` — run history for a definition.
//! - `GET /v1/workflow-runs/:run_id` — one run by id.

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use harness_workflow::{WorkflowDefinition, WorkflowRun, WorkflowStep};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state::AppState;
use crate::workflow_runtime::execute_workflow_run;

/// Wall-clock budget for a single agent step in a manually dispatched
/// run. Matches the auto loop's `JARVIS_WORK_RUN_TIMEOUT_MS` default.
const DEFAULT_RUN_TIMEOUT_MS: u64 = 600_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/workflows", get(list_workflows).post(create_workflow))
        .route(
            "/v1/workflows/:id",
            get(get_workflow)
                .patch(patch_workflow)
                .delete(delete_workflow),
        )
        .route("/v1/workflows/:id/run", post(run_workflow))
        .route("/v1/workflows/:id/runs", get(list_workflow_runs))
        .route("/v1/workflow-runs/:run_id", get(get_workflow_run))
}

#[derive(Debug, Serialize)]
struct WorkflowsResponse {
    items: Vec<WorkflowDefinition>,
}

#[derive(Debug, Serialize)]
struct WorkflowRunsResponse {
    items: Vec<WorkflowRun>,
}

#[derive(Debug, Deserialize)]
struct CreateWorkflowRequest {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    steps: Vec<WorkflowStep>,
}

#[derive(Debug, Default, Deserialize)]
struct PatchWorkflowRequest {
    #[serde(default)]
    name: Option<String>,
    /// `Some("")` clears the description; `None` leaves it as-is.
    #[serde(default)]
    description: Option<String>,
    /// `Some("")` clears the project scope; `None` leaves it as-is.
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    steps: Option<Vec<WorkflowStep>>,
}

#[derive(Debug, Default, Deserialize)]
struct RunWorkflowRequest {
    #[serde(default)]
    requirement_id: Option<String>,
}

async fn list_workflows(State(state): State<AppState>) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    match store.list().await {
        Ok(items) => Json(WorkflowsResponse { items }).into_response(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn create_workflow(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkflowRequest>,
) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    if req.name.trim().is_empty() {
        return bad_request("name is required");
    }
    let mut def = WorkflowDefinition::new(req.name.trim());
    def.description = clean_opt(req.description);
    def.project_id = clean_opt(req.project_id);
    def.steps = normalize_steps(req.steps);
    if let Err(e) = validate_steps(&def) {
        return bad_request(e);
    }
    match store.upsert(&def).await {
        Ok(()) => (axum::http::StatusCode::CREATED, Json(def)).into_response(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn get_workflow(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    match store.get(&id).await {
        Ok(Some(def)) => Json(def).into_response(),
        Ok(None) => not_found(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn patch_workflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PatchWorkflowRequest>,
) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    let mut def = match store.get(&id).await {
        Ok(Some(def)) => def,
        Ok(None) => return not_found(),
        Err(e) => return server_error(e.to_string()),
    };
    if let Some(name) = req.name {
        if name.trim().is_empty() {
            return bad_request("name cannot be empty");
        }
        def.name = name.trim().to_string();
    }
    if let Some(description) = req.description {
        def.description = clean_opt(Some(description));
    }
    if let Some(project_id) = req.project_id {
        def.project_id = clean_opt(Some(project_id));
    }
    if let Some(steps) = req.steps {
        def.steps = normalize_steps(steps);
    }
    if let Err(e) = validate_steps(&def) {
        return bad_request(e);
    }
    def.touch();
    match store.upsert(&def).await {
        Ok(()) => Json(def).into_response(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn delete_workflow(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    match store.delete(&id).await {
        Ok(true) => axum::http::StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn run_workflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RunWorkflowRequest>,
) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    let def = match store.get(&id).await {
        Ok(Some(def)) => def,
        Ok(None) => return not_found(),
        Err(e) => return server_error(e.to_string()),
    };

    // Resolve an optional requirement binding for this run.
    let requirement = match clean_opt(req.requirement_id) {
        Some(req_id) => {
            let Some(req_store) = state.requirements.as_ref() else {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "requirement store not configured" })),
                )
                    .into_response();
            };
            match req_store.get(&req_id).await {
                Ok(Some(r)) => Some(r),
                Ok(None) => {
                    return bad_request(format!("requirement `{req_id}` not found"));
                }
                Err(e) => return server_error(e.to_string()),
            }
        }
        None => None,
    };

    // Mint + persist the Running run synchronously so we can return its
    // id, then execute in the background (à la spawn_automation_run).
    let run = WorkflowRun::new(def.id.clone(), requirement.as_ref().map(|r| r.id.clone()));
    if let Err(e) = store.upsert_run(&run).await {
        return server_error(e.to_string());
    }
    let response_run = run.clone();
    let state2 = state.clone();
    tokio::spawn(async move {
        execute_workflow_run(
            &state2,
            &def,
            requirement.as_ref(),
            run,
            None,
            DEFAULT_RUN_TIMEOUT_MS,
        )
        .await;
    });
    (axum::http::StatusCode::ACCEPTED, Json(response_run)).into_response()
}

async fn list_workflow_runs(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    match store.list_runs(Some(&id), None).await {
        Ok(items) => Json(WorkflowRunsResponse { items }).into_response(),
        Err(e) => server_error(e.to_string()),
    }
}

async fn get_workflow_run(State(state): State<AppState>, Path(run_id): Path<String>) -> Response {
    let Some(store) = state.workflows.as_ref() else {
        return unavailable();
    };
    match store.get_run(&run_id).await {
        Ok(Some(run)) => Json(run).into_response(),
        Ok(None) => not_found(),
        Err(e) => server_error(e.to_string()),
    }
}

/// Assign a fresh UUID to any step (recursively) whose id is blank, so
/// clients can POST step trees without minting ids themselves.
fn normalize_steps(steps: Vec<WorkflowStep>) -> Vec<WorkflowStep> {
    use harness_workflow::WorkflowStepKind;
    steps
        .into_iter()
        .map(|mut s| {
            if s.id.trim().is_empty() {
                s.id = uuid::Uuid::new_v4().to_string();
            }
            s.kind = match s.kind {
                WorkflowStepKind::Pipeline { steps } => WorkflowStepKind::Pipeline {
                    steps: normalize_steps(steps),
                },
                WorkflowStepKind::Phase { title, steps } => WorkflowStepKind::Phase {
                    title,
                    steps: normalize_steps(steps),
                },
                WorkflowStepKind::Parallel { steps, join } => WorkflowStepKind::Parallel {
                    steps: normalize_steps(steps),
                    join,
                },
                agent => agent,
            };
            s
        })
        .collect()
}

fn validate_steps(def: &WorkflowDefinition) -> Result<(), String> {
    if def.agent_step_count() == 0 {
        return Err("workflow must contain at least one agent step".to_string());
    }
    Ok(())
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
        Json(json!({ "error": "workflow store not configured" })),
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
        Json(json!({ "error": "workflow not found" })),
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
    use harness_workflow::WorkflowStepKind;
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
        AppState::new(agent).with_workflows(Arc::new(harness_store::MemoryWorkflowStore::new()))
    }

    fn agent_step(name: &str, prompt: &str) -> WorkflowStep {
        WorkflowStep::new(
            name,
            WorkflowStepKind::Agent {
                prompt: prompt.into(),
                subagent: None,
                model: None,
                output_key: None,
            },
        )
    }

    async fn read_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn list_returns_503_when_store_absent() {
        let cfg = harness_core::AgentConfig::new("stub-model");
        let agent = Arc::new(harness_core::Agent::new(Arc::new(StubLlm) as _, cfg));
        let resp = list_workflows(State(AppState::new(agent))).await;
        assert_eq!(resp.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_then_list_round_trip() {
        let state = mk_state();
        let create = create_workflow(
            State(state.clone()),
            Json(CreateWorkflowRequest {
                name: "ship".into(),
                description: Some("research then build".into()),
                project_id: None,
                steps: vec![agent_step("research", "look around")],
            }),
        )
        .await;
        assert_eq!(create.status(), axum::http::StatusCode::CREATED);
        let created = read_json(create).await;
        assert_eq!(created["name"], "ship");
        // The blank-id step got a server-minted id.
        assert!(!created["steps"][0]["id"].as_str().unwrap().is_empty());

        let list = list_workflows(State(state)).await;
        let body = read_json(list).await;
        assert_eq!(body["items"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_rejects_workflow_with_no_agent_steps() {
        let state = mk_state();
        let resp = create_workflow(
            State(state),
            Json(CreateWorkflowRequest {
                name: "empty".into(),
                description: None,
                project_id: None,
                steps: vec![],
            }),
        )
        .await;
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn run_dispatches_and_persists_running_run() {
        let state = mk_state();
        // Create a definition first.
        let create = create_workflow(
            State(state.clone()),
            Json(CreateWorkflowRequest {
                name: "ship".into(),
                description: None,
                project_id: None,
                steps: vec![agent_step("research", "look around")],
            }),
        )
        .await;
        let def = read_json(create).await;
        let wf_id = def["id"].as_str().unwrap().to_string();

        let run = run_workflow(
            State(state.clone()),
            Path(wf_id.clone()),
            Json(RunWorkflowRequest {
                requirement_id: None,
            }),
        )
        .await;
        assert_eq!(run.status(), axum::http::StatusCode::ACCEPTED);
        let run_body = read_json(run).await;
        let run_id = run_body["id"].as_str().unwrap().to_string();
        assert_eq!(run_body["workflow_id"], wf_id);

        // The Running run was persisted synchronously before the spawn.
        let got = get_workflow_run(State(state), Path(run_id)).await;
        assert_eq!(got.status(), axum::http::StatusCode::OK);
    }
}
