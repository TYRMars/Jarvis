//! Integration tests for the HTTP routes, including the persistence
//! endpoints that surface `ConversationStore` to clients.

use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use harness_core::{
    Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider, Message,
    Result as CoreResult,
};
use harness_server::{router, AppState};
use harness_store::MemoryConversationStore;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::util::ServiceExt;

/// Scripted provider: returns each queued reply in order, one per call.
/// When the queue runs out it echoes the last user message.
struct ScriptedProvider {
    replies: std::sync::Mutex<Vec<String>>,
}

impl ScriptedProvider {
    fn new(replies: Vec<&str>) -> Self {
        Self {
            replies: std::sync::Mutex::new(replies.into_iter().map(String::from).collect()),
        }
    }
}

#[async_trait]
impl LlmProvider for ScriptedProvider {
    async fn complete(&self, req: ChatRequest) -> CoreResult<ChatResponse> {
        let text = {
            let mut q = self.replies.lock().unwrap();
            if q.is_empty() {
                "ok".to_string()
            } else {
                q.remove(0)
            }
        };
        let _ = req;
        Ok(ChatResponse {
            message: Message::assistant_text(text),
            finish_reason: FinishReason::Stop,
        })
    }
}

fn app(store: bool, replies: Vec<&str>) -> axum::Router {
    let llm: Arc<dyn LlmProvider> = Arc::new(ScriptedProvider::new(replies));
    let cfg = AgentConfig::new("test-model").with_max_iterations(2);
    let agent = Arc::new(Agent::new(llm, cfg));
    let mut state = AppState::new(agent);
    if store {
        state = state.with_store(Arc::new(MemoryConversationStore::new()));
    }
    router(state)
}

async fn post_json(app: axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn get_json(app: axum::Router, path: &str) -> (StatusCode, Value) {
    let resp = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

async fn delete(app: axum::Router, path: &str) -> StatusCode {
    let resp = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    resp.status()
}

#[tokio::test]
async fn health_ok() {
    let (status, body) = get_json(app(false, vec![]), "/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn chat_completions_without_id_stays_stateless() {
    let (status, body) = post_json(
        app(true, vec!["hi there"]),
        "/v1/chat/completions",
        json!({
            "messages": [{"role": "user", "content": "ping"}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["message"]["role"], "assistant");
    assert_eq!(body["message"]["content"], "hi there");
    assert!(body["conversation_id"].is_null());
}

#[tokio::test]
async fn chat_completions_with_id_persists_and_resumes() {
    let app_inst = app(true, vec!["first-reply", "second-reply"]);

    // First turn — creates the row.
    let (s1, b1) = post_json(
        app_inst.clone(),
        "/v1/chat/completions",
        json!({
            "conversation_id": "sess-1",
            "messages": [{"role": "user", "content": "one"}],
        }),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(b1["conversation_id"], "sess-1");
    assert_eq!(b1["message"]["content"], "first-reply");

    // Second turn — loads prior history and appends.
    let (s2, b2) = post_json(
        app_inst.clone(),
        "/v1/chat/completions",
        json!({
            "conversation_id": "sess-1",
            "messages": [{"role": "user", "content": "two"}],
        }),
    )
    .await;
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(b2["message"]["content"], "second-reply");
    // History should carry both user turns + both assistant replies.
    let history = b2["history"].as_array().unwrap();
    let user_turns = history
        .iter()
        .filter(|m| m["role"] == "user")
        .count();
    let assistant_turns = history
        .iter()
        .filter(|m| m["role"] == "assistant")
        .count();
    assert_eq!(user_turns, 2);
    assert_eq!(assistant_turns, 2);
}

#[tokio::test]
async fn chat_completions_conversation_id_without_store_is_400() {
    let (status, body) = post_json(
        app(false, vec!["hi"]),
        "/v1/chat/completions",
        json!({
            "conversation_id": "sess-1",
            "messages": [{"role": "user", "content": "ping"}],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("persistence"));
}

#[tokio::test]
async fn list_conversations_requires_store() {
    let (status, _) = get_json(app(false, vec![]), "/v1/conversations").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_and_delete_roundtrip() {
    let app_inst = app(true, vec!["reply"]);

    // Seed a conversation via the chat endpoint.
    let _ = post_json(
        app_inst.clone(),
        "/v1/chat/completions",
        json!({
            "conversation_id": "sess-x",
            "messages": [{"role": "user", "content": "hello"}],
        }),
    )
    .await;

    // List it.
    let (s_list, b_list) = get_json(app_inst.clone(), "/v1/conversations").await;
    assert_eq!(s_list, StatusCode::OK);
    let rows = b_list["conversations"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], "sess-x");

    // Fetch it.
    let (s_get, b_get) = get_json(app_inst.clone(), "/v1/conversations/sess-x").await;
    assert_eq!(s_get, StatusCode::OK);
    assert_eq!(b_get["id"], "sess-x");
    assert!(b_get["message_count"].as_u64().unwrap() >= 2);

    // Delete it.
    let s_del = delete(app_inst.clone(), "/v1/conversations/sess-x").await;
    assert_eq!(s_del, StatusCode::NO_CONTENT);

    // Gone.
    let (s_404, _) = get_json(app_inst.clone(), "/v1/conversations/sess-x").await;
    assert_eq!(s_404, StatusCode::NOT_FOUND);
    let s_del_again = delete(app_inst, "/v1/conversations/sess-x").await;
    assert_eq!(s_del_again, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn list_limit_clamps() {
    let app_inst = app(true, vec!["a", "b", "c"]);
    for id in ["c1", "c2", "c3"] {
        let _ = post_json(
            app_inst.clone(),
            "/v1/chat/completions",
            json!({
                "conversation_id": id,
                "messages": [{"role": "user", "content": "ping"}],
            }),
        )
        .await;
    }

    let (status, body) = get_json(app_inst, "/v1/conversations?limit=2").await;
    assert_eq!(status, StatusCode::OK);
    let rows = body["conversations"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
}
