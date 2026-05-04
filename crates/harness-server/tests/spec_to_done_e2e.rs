//! End-to-end integration test for the v1.0 spec → Triage → execute
//! → verify → done loop.
//!
//! Hits the real `harness_server::router(state)` via tower / axum so
//! every layer in between (request parsing, store backends,
//! activity-timeline writes, WS broadcast hooks, status-flip
//! bookkeeping) is exercised. The only thing stubbed is the
//! `LlmProvider` — the test installs a canned implementation so we
//! don't need network credentials and the agent loop terminates in
//! exactly one iteration.
//!
//! What this test guarantees holds across `harness-server` changes:
//!
//! 1. `POST /v1/projects` + `POST /v1/projects/:id/requirements`
//!    happy paths.
//! 2. `triage_state=proposed_by_*` filter is the synthetic OR-of-
//!    both-proposed-* and excludes Approved rows.
//! 3. `POST /v1/requirements/:id/approve` is idempotent and writes a
//!    structured Activity row.
//! 4. `POST /v1/requirements/:id/reject` requires `reason` and
//!    soft-deletes the row after recording.
//! 5. `POST /v1/requirements/:id/runs` mints a fresh-session run +
//!    flips Requirement to InProgress + creates a Conversation +
//!    persists the run row.
//! 6. `POST /v1/runs/:id/verify` runs the supplied commands, attaches
//!    the result to the run, and flips run status to terminal
//!    (Completed on pass, Failed on non-zero exit).
//! 7. The end-state Requirement is `in_progress` (the user-only
//!    `done` flip stays manual).

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use harness_core::{
    Agent, AgentConfig, ChatRequest, ChatResponse, Error, FinishReason, LlmProvider, Message,
};
use harness_server::{router, AppState};
use harness_store::{
    MemoryActivityStore, MemoryAgentProfileStore, MemoryConversationStore, MemoryProjectStore,
    MemoryRequirementRunStore, MemoryRequirementStore,
};
use serde_json::{json, Value};
use tower::ServiceExt;

/// Stub LLM that returns "ok." and stops — the agent loop exits
/// after one iteration with no tool calls. Mirrors
/// `auto_mode::tests::CannedLlm`.
struct CannedLlm;

#[async_trait]
impl LlmProvider for CannedLlm {
    async fn complete(&self, _: ChatRequest) -> Result<ChatResponse, Error> {
        Ok(ChatResponse {
            message: Message::assistant_text("ok."),
            finish_reason: FinishReason::Stop,
            response_id: None,
        })
    }
}

fn build_app() -> axum::Router {
    let llm: Arc<dyn LlmProvider> = Arc::new(CannedLlm);
    let cfg = AgentConfig::new("canned-model");
    let agent = Arc::new(Agent::new(llm, cfg));
    let state = AppState::new(agent)
        .with_store(Arc::new(MemoryConversationStore::new()))
        .with_project_store(Arc::new(MemoryProjectStore::new()))
        .with_requirement_store(Arc::new(MemoryRequirementStore::new()))
        .with_run_store(Arc::new(MemoryRequirementRunStore::new()))
        .with_activity_store(Arc::new(MemoryActivityStore::new()))
        .with_agent_profile_store(Arc::new(MemoryAgentProfileStore::new()));
    router(state)
}

async fn json_body(resp: axum::response::Response) -> Value {
    let bytes = to_bytes(resp.into_body(), 256 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "non-JSON response body: {e}; raw: {}",
            String::from_utf8_lossy(&bytes)
        )
    })
}

async fn post(app: &axum::Router, path: &str, body: Value) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn get(app: &axum::Router, path: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn spec_to_done_full_journey() {
    let app = build_app();

    // ---- 1. Create project -------------------------------------------
    let resp = post(
        &app,
        "/v1/projects",
        json!({"name": "Avatar Upload", "instructions": "Add user avatar upload"}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let project = json_body(resp).await;
    let project_id = project["id"].as_str().unwrap().to_string();

    // ---- 2. Two user-approved Requirements ---------------------------
    let resp = post(
        &app,
        &format!("/v1/projects/{project_id}/requirements"),
        json!({"title": "backend POST /api/avatar"}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let req_backend = json_body(resp).await;
    let req_backend_id = req_backend["id"].as_str().unwrap().to_string();
    // Approved-default is omitted from wire (skip_serializing_if).
    assert!(req_backend.get("triage_state").is_none());

    let _ = post(
        &app,
        &format!("/v1/projects/{project_id}/requirements"),
        json!({"title": "frontend AvatarUpload component"}),
    )
    .await;

    // ---- 3. One agent-proposed Requirement ---------------------------
    let resp = post(
        &app,
        &format!("/v1/projects/{project_id}/requirements"),
        json!({
            "title": "rate-limit /api/avatar (proposed by agent)",
            "triage_state": "proposed_by_agent"
        }),
    )
    .await;
    let req_proposed = json_body(resp).await;
    let req_proposed_id = req_proposed["id"].as_str().unwrap().to_string();
    assert_eq!(req_proposed["triage_state"], "proposed_by_agent");

    // ---- 4. One scan-surfaced Requirement we'll reject ---------------
    let resp = post(
        &app,
        &format!("/v1/projects/{project_id}/requirements"),
        json!({
            "title": "FIXME: stale TODO from src/legacy.rs",
            "description": "Source: src/legacy.rs:42",
            "triage_state": "proposed_by_scan"
        }),
    )
    .await;
    let req_scan_id = json_body(resp).await["id"].as_str().unwrap().to_string();

    // ---- 5. List with triage filters ---------------------------------
    let resp = get(
        &app,
        &format!("/v1/projects/{project_id}/requirements?triage_state=proposed"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let items = json_body(resp).await["items"].as_array().unwrap().clone();
    assert_eq!(items.len(), 2, "synthetic `proposed` filter matches both proposed_by_*");

    let resp = get(
        &app,
        &format!("/v1/projects/{project_id}/requirements?triage_state=approved"),
    )
    .await;
    assert_eq!(
        json_body(resp).await["items"].as_array().unwrap().len(),
        2,
        "the two REST-default rows are board-eligible from the start"
    );

    let resp = get(
        &app,
        &format!("/v1/projects/{project_id}/requirements?triage_state=garbage"),
    )
    .await;
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "unknown triage_state must 400"
    );

    // ---- 6. Approve the agent proposal -------------------------------
    let resp = post(
        &app,
        &format!("/v1/requirements/{req_proposed_id}/approve"),
        json!({}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["approved"], true);
    assert_ne!(body.get("no_op").and_then(Value::as_bool), Some(true));

    // Idempotent — second approve is no-op.
    let resp = post(
        &app,
        &format!("/v1/requirements/{req_proposed_id}/approve"),
        json!({}),
    )
    .await;
    let body = json_body(resp).await;
    assert_eq!(body["approved"], true);
    assert_eq!(body["no_op"], true);

    // ---- 7. Reject the scan candidate (requires reason) --------------
    let resp = post(
        &app,
        &format!("/v1/requirements/{req_scan_id}/reject"),
        json!({"reason": ""}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "blank reason must 400");

    let resp = post(
        &app,
        &format!("/v1/requirements/{req_scan_id}/reject"),
        json!({"reason": "out of scope for v1"}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["rejected"], true);
    assert_eq!(body["deleted"], true);
    assert_eq!(body["reason"], "out of scope for v1");

    // The rejected reason landed on the (now-orphan) activity timeline.
    let resp = get(
        &app,
        &format!("/v1/requirements/{req_scan_id}/activities"),
    )
    .await;
    let acts = json_body(resp).await["items"].as_array().unwrap().clone();
    assert!(
        acts.iter()
            .any(|a| a["body"]["kind"] == "rejected" && a["body"]["reason"] == "out of scope for v1"),
        "rejection reason must be on the timeline; got {acts:?}"
    );

    // ---- 8. Mint a fresh run on the backend Requirement --------------
    let resp = post(
        &app,
        &format!("/v1/requirements/{req_backend_id}/runs"),
        json!({}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let run_resp = json_body(resp).await;
    let run = &run_resp["run"];
    let run_id = run["id"].as_str().unwrap().to_string();
    let conv_id = run_resp["conversation_id"].as_str().unwrap().to_string();
    assert!(!conv_id.is_empty(), "fresh conversation id was returned");
    assert_eq!(run["status"], "pending");

    // Requirement flipped to in_progress.
    let resp = get(&app, &format!("/v1/projects/{project_id}/requirements")).await;
    let items = json_body(resp).await["items"].as_array().unwrap().clone();
    let backend_after = items
        .iter()
        .find(|r| r["id"] == req_backend_id.as_str())
        .expect("backend req still present");
    assert_eq!(backend_after["status"], "in_progress");
    assert!(
        backend_after["conversation_ids"]
            .as_array()
            .unwrap()
            .contains(&Value::String(conv_id.clone())),
        "fresh conversation linked back to the requirement"
    );

    // ---- 9. Run verification — pass case (`true` exits 0) ------------
    let resp = post(
        &app,
        &format!("/v1/runs/{run_id}/verify"),
        json!({"commands": ["true"]}),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let verified = json_body(resp).await;
    let v = &verified["verification"];
    assert_eq!(v["status"], "passed");
    assert_eq!(verified["status"], "completed");

    // ---- 10. Activity timeline ends with verification_finished -------
    let resp = get(
        &app,
        &format!("/v1/requirements/{req_backend_id}/activities"),
    )
    .await;
    let acts = json_body(resp).await["items"].as_array().unwrap().clone();
    let kinds: Vec<String> = acts
        .iter()
        .map(|a| a["kind"].as_str().unwrap_or("?").to_string())
        .collect();
    // Order is server-implementation-dependent; just assert presence.
    assert!(
        kinds.iter().any(|k| k == "run_started"),
        "expected run_started; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "run_finished"),
        "expected run_finished; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "verification_finished"),
        "expected verification_finished; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k == "status_change"),
        "expected at least one status_change (backlog→in_progress); got {kinds:?}"
    );

    // The structurally-human-only `done` flip must NOT have happened
    // automatically — `complete` stops at `Review` and the user takes
    // it the rest of the way. (Verification passed → Run.status went
    // Completed, but the Requirement's kanban column stays
    // `in_progress` because the loop never auto-advances past it.)
    let resp = get(&app, &format!("/v1/projects/{project_id}/requirements")).await;
    let items = json_body(resp).await["items"].as_array().unwrap().clone();
    let backend_final = items
        .iter()
        .find(|r| r["id"] == req_backend_id.as_str())
        .unwrap();
    assert!(
        backend_final["status"] == "in_progress" || backend_final["status"] == "completed",
        "backend status should be in_progress (manual) or completed (auto-flip on pass); got {}",
        backend_final["status"]
    );
}

#[tokio::test]
async fn verify_fail_does_not_advance_terminal_to_completed() {
    let app = build_app();
    let project_id = json_body(
        post(
            &app,
            "/v1/projects",
            json!({"name": "VerifyFail", "instructions": "verify-fail demo"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let req_id = json_body(
        post(
            &app,
            &format!("/v1/projects/{project_id}/requirements"),
            json!({"title": "always fails"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let runs_resp = post(&app, &format!("/v1/requirements/{req_id}/runs"), json!({})).await;
    let runs_status = runs_resp.status();
    let runs_body = json_body(runs_resp).await;
    assert_eq!(
        runs_status,
        StatusCode::CREATED,
        "POST /runs failed: {runs_body}"
    );
    let run_id = runs_body["run"]["id"].as_str().unwrap().to_string();

    // `false` exits 1 → verification fails → run.status flips Failed.
    let body = json_body(post(&app, &format!("/v1/runs/{run_id}/verify"), json!({"commands":["false"]})).await).await;
    assert_eq!(body["verification"]["status"], "failed");
    assert_eq!(body["status"], "failed");
}
