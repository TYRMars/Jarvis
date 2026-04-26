//! Persisted-conversation HTTP routes.
//!
//! These routes are mounted only when `AppState` carries a
//! `ConversationStore`; if the store is `None`, every persisted route
//! returns `503 Service Unavailable` so callers can distinguish "not
//! configured" from "really broken". The ephemeral
//! `/v1/chat/completions` endpoint stays available either way.
//!
//! Endpoints:
//!
//! - `POST   /v1/conversations`              — create empty conversation
//! - `GET    /v1/conversations`              — list newest first
//! - `GET    /v1/conversations/:id`          — load full conversation
//! - `DELETE /v1/conversations/:id`          — delete
//! - `POST   /v1/conversations/:id/messages`        — append + run (blocking)
//! - `POST   /v1/conversations/:id/messages/stream` — append + run (SSE)

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures::{Stream, StreamExt};
use harness_core::{AgentEvent, Conversation, ConversationStore, Message, RunOutcome};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{error, warn};
use uuid::Uuid;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/conversations", post(create).get(list))
        .route(
            "/v1/conversations/:id",
            get(get_one).delete(delete_one),
        )
        .route("/v1/conversations/:id/messages", post(post_message))
        .route(
            "/v1/conversations/:id/messages/stream",
            post(stream_message),
        )
}

/// Pull `state.store` out, or return a 503 response if persistence isn't
/// configured. The cloned `Arc` is cheap. The `Response` Err variant is
/// large but we only build it on the unhappy path, once per request.
#[allow(clippy::result_large_err)]
fn require_store(state: &AppState) -> Result<Arc<dyn ConversationStore>, Response> {
    state.store.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "persistence not configured; set JARVIS_DB_URL"
            })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

/// Ids beginning with `__` are reserved for internal use (today: the
/// content-addressed summary cache used by `SummarizingMemory`). They
/// must not appear in client-facing CRUD responses, and the public
/// endpoints refuse to operate on them — clients who need to clear
/// memory caches should do so through a dedicated admin path, not by
/// guessing internal keys.
pub(crate) fn is_internal_id(id: &str) -> bool {
    id.starts_with("__")
}

// ----------------------- create -----------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CreateRequest {
    /// Optional system prompt. When present, becomes the first message
    /// of the new conversation; when absent, the agent's configured
    /// system prompt is used on the first run instead.
    system: Option<String>,
    /// Optional caller-supplied id. Useful for idempotent clients.
    /// Defaults to a fresh UUID v4.
    id: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateResponse {
    id: String,
}

async fn create(
    State(state): State<AppState>,
    body: Option<Json<CreateRequest>>,
) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let id = req.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if is_internal_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "ids starting with `__` are reserved for internal use"
            })),
        )
            .into_response();
    }

    let mut conv = Conversation::new();
    if let Some(sys) = req.system {
        conv.push(Message::system(sys));
    }
    if let Err(e) = store.save(&id, &conv).await {
        return internal_error(e);
    }
    (StatusCode::CREATED, Json(CreateResponse { id })).into_response()
}

// ----------------------- list -----------------------

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default = "default_limit")]
    limit: u32,
}
fn default_limit() -> u32 {
    20
}

async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.list(q.limit).await {
        Ok(rows) => {
            let visible: Vec<_> = rows.into_iter().filter(|r| !is_internal_id(&r.id)).collect();
            // N+1 title lookup — fine at our scale (default limit=20,
            // max practical ~50). When backends gain a real `summary`
            // method we'll switch this to a single batched call; until
            // then, derive the title from the first user message of
            // each conversation. Failures fall through to `null` so a
            // single broken row doesn't sink the whole list.
            let mut out = Vec::with_capacity(visible.len());
            for r in visible {
                let title = match store.load(&r.id).await {
                    Ok(Some(conv)) => first_user_title(&conv),
                    _ => None,
                };
                out.push(json!({
                    "id": r.id,
                    "created_at": r.created_at,
                    "updated_at": r.updated_at,
                    "message_count": r.message_count,
                    "title": title,
                }));
            }
            Json(out).into_response()
        }
        Err(e) => internal_error(e),
    }
}

/// Best-effort conversation title: the first user message's first
/// line, capped at 60 chars + a trailing ellipsis when truncated.
/// Returns `None` when the conversation has no user message yet
/// (e.g. system-prompt-only persisted seed).
fn first_user_title(conv: &harness_core::Conversation) -> Option<String> {
    const TITLE_MAX_CHARS: usize = 60;
    for m in &conv.messages {
        if let harness_core::Message::User { content } = m {
            let line = content.lines().next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let chars: Vec<char> = line.chars().collect();
            if chars.len() > TITLE_MAX_CHARS {
                let cut: String = chars.iter().take(TITLE_MAX_CHARS).collect();
                return Some(format!("{cut}…"));
            }
            return Some(line.to_string());
        }
    }
    None
}

// ----------------------- get -----------------------

async fn get_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.load(&id).await {
        Ok(Some(conv)) => Json(json!({
            "id": id,
            "messages": conv.messages,
        }))
        .into_response(),
        Ok(None) => not_found(),
        Err(e) => internal_error(e),
    }
}

// ----------------------- delete -----------------------

async fn delete_one(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    match store.delete(&id).await {
        Ok(true) => Json(json!({ "deleted": true })).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "deleted": false })),
        )
            .into_response(),
        Err(e) => internal_error(e),
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "conversation not found" })),
    )
        .into_response()
}

// ----------------------- post message (blocking) -----------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PostMessageRequest {
    content: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

async fn post_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PostMessageRequest>,
) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut conv = match store.load(&id).await {
        Ok(Some(c)) => c,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    conv.push(Message::user(req.content));

    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            error!(error = %e, id = %id, "agent build failed");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    let outcome = match agent.run(&mut conv).await {
        Ok(o) => o,
        Err(e) => {
            error!(error = %e, id = %id, "agent run failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    if let Err(e) = store.save(&id, &conv).await {
        // The conversation was successfully run; surfacing a 5xx now
        // would lose the assistant's reply. Log and continue — the
        // client gets the result, and the next call will pick the
        // canonical state up from whatever did make it to disk.
        warn!(error = %e, id = %id, "post-run save failed");
    }

    let iterations = match outcome {
        RunOutcome::Stopped { iterations } | RunOutcome::LengthLimited { iterations } => {
            iterations
        }
    };
    let final_msg = conv
        .messages
        .iter()
        .rev()
        .find(|m| matches!(m, Message::Assistant { .. }))
        .cloned()
        .unwrap_or_else(|| Message::assistant_text(""));

    Json(json!({
        "id": id,
        "message": final_msg,
        "iterations": iterations,
        "history": conv.messages,
    }))
    .into_response()
}

// ----------------------- stream message (SSE) -----------------------

async fn stream_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PostMessageRequest>,
) -> Response {
    if is_internal_id(&id) {
        return not_found();
    }
    let store = match require_store(&state) {
        Ok(s) => s,
        Err(r) => return r,
    };
    let mut conv = match store.load(&id).await {
        Ok(Some(c)) => c,
        Ok(None) => return not_found(),
        Err(e) => return internal_error(e),
    };
    conv.push(Message::user(req.content));

    let agent = match state.build_agent(req.provider.as_deref(), req.model.as_deref()) {
        Ok(a) => a,
        Err(e) => {
            error!(error = %e, id = %id, "agent build failed");
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    let stream = stream_run(agent.run_stream(conv), store, id);
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

fn stream_run(
    mut agent_stream: harness_core::AgentStream,
    store: Arc<dyn ConversationStore>,
    id: String,
) -> impl Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        while let Some(event) = agent_stream.next().await {
            // Snapshot the canonical conversation off the terminal Done
            // event so we save exactly what the agent committed to.
            if let AgentEvent::Done { conversation, .. } = &event {
                if let Err(e) = store.save(&id, conversation).await {
                    warn!(error = %e, id = %id, "post-run save failed (sse)");
                }
            }
            let payload = serde_json::to_string(&event).unwrap_or_else(|e| {
                format!(r#"{{"type":"error","message":"serialize: {e}"}}"#)
            });
            yield Ok::<_, Infallible>(Event::default().data(payload));
        }
    }
}

// ============================== tests ==============================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router as full_router;
    use async_trait::async_trait;
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use harness_core::{
        Agent, AgentConfig, ChatRequest, ChatResponse, FinishReason, LlmProvider,
        Result as CoreResult,
    };
    use harness_store::MemoryConversationStore;
    use serde_json::Value;
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

    fn make_state(with_store: bool) -> AppState {
        let agent = Agent::new(Arc::new(NoopLlm), AgentConfig::new("test-model"));
        let mut state = AppState::new(Arc::new(agent));
        if with_store {
            state = state.with_store(Arc::new(MemoryConversationStore::new()));
        }
        state
    }

    async fn body_json(resp: Response) -> (StatusCode, Value) {
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let v: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
    }

    fn json_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn create_get_list_delete_roundtrip() {
        let app = full_router(make_state(true));

        // create
        let resp = app
            .clone()
            .oneshot(json_post("/v1/conversations", json!({})))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        // get
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);
        assert!(body["messages"].is_array());

        // list
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 1);

        // delete
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        // delete again → 404
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn create_with_system_prompt_persists_message() {
        let app = full_router(make_state(true));
        let resp = app
            .clone()
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "system": "you are jarvis" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = body["id"].as_str().unwrap().to_string();

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "you are jarvis");
    }

    #[tokio::test]
    async fn create_accepts_caller_supplied_id() {
        let app = full_router(make_state(true));
        let resp = app
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "id": "stable-id-123" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["id"], "stable-id-123");
    }

    #[tokio::test]
    async fn missing_returns_404() {
        let app = full_router(make_state(true));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn internal_ids_hidden_from_crud() {
        let state = make_state(true);
        // Seed an internal-namespace row directly through the store.
        let store = state.store.clone().unwrap();
        let mut conv = Conversation::new();
        conv.push(Message::system("internal cache"));
        store
            .save("__memory__.summary:fakehash", &conv)
            .await
            .unwrap();
        // …and a regular one for contrast.
        store.save("user-conv", &Conversation::new()).await.unwrap();

        let app = full_router(state);

        // list must filter the internal id out.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (_, body) = body_json(resp).await;
        let ids: Vec<String> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["user-conv"]);

        // get must hide it (404).
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations/__memory__.summary:fakehash")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // delete must refuse to touch it.
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/v1/conversations/__memory__.summary:fakehash")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        // create with caller-supplied internal id must be rejected.
        let resp = app
            .oneshot(json_post(
                "/v1/conversations",
                json!({ "id": "__hand_crafted" }),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn no_store_returns_503() {
        let app = full_router(make_state(false));
        let resp = app
            .clone()
            .oneshot(json_post("/v1/conversations", json!({})))
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, _) = body_json(resp).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn post_message_runs_agent_and_persists() {
        let app = full_router(make_state(true));

        // create
        let (_, body) = body_json(
            app.clone()
                .oneshot(json_post("/v1/conversations", json!({})))
                .await
                .unwrap(),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();

        // post a message — NoopLlm replies "ok"
        let resp = app
            .clone()
            .oneshot(json_post(
                &format!("/v1/conversations/{id}/messages"),
                json!({ "content": "hi" }),
            ))
            .await
            .unwrap();
        let (status, body) = body_json(resp).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);
        assert_eq!(body["message"]["role"], "assistant");
        assert_eq!(body["message"]["content"], "ok");
        assert!(body["history"].as_array().unwrap().len() >= 2);

        // re-fetch — store should have the user + assistant message
        let (_, body) = body_json(
            app.oneshot(
                Request::builder()
                    .uri(format!("/v1/conversations/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        let msgs = body["messages"].as_array().unwrap();
        assert!(
            msgs.iter().any(|m| m["role"] == "user" && m["content"] == "hi"),
            "history did not include the user message: {body}"
        );
        assert!(
            msgs.iter().any(|m| m["role"] == "assistant" && m["content"] == "ok"),
            "history did not include the assistant reply: {body}"
        );
    }
}
