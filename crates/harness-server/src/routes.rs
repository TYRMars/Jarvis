use std::convert::Infallible;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures::StreamExt;
use harness_core::{AgentEvent, Conversation, ConversationRecord, Message, RunOutcome};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{error, warn};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/chat/completions/stream", post(chat_completions_stream))
        .route("/v1/chat/ws", get(chat_ws))
        .route("/v1/conversations", get(list_conversations))
        .route("/v1/conversations/:id", get(get_conversation).delete(delete_conversation))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

// ----------------------- /v1/chat/completions (JSON) -----------------------

#[derive(Debug, Deserialize)]
struct ChatCompletionsRequest {
    #[serde(default)]
    #[allow(dead_code)]
    model: Option<String>,
    messages: Vec<Message>,
    /// When set, load any existing conversation at this id, append the
    /// incoming `messages`, and save the result after the agent finishes.
    /// Requires `JARVIS_DB_URL` to be configured; otherwise the request
    /// fails with 400.
    #[serde(default)]
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionsResponse {
    message: Message,
    iterations: usize,
    history: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let mut conv = match load_or_init(&state, req.conversation_id.as_deref(), req.messages).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };

    match state.agent.run(&mut conv).await {
        Ok(outcome) => {
            let iterations = match outcome {
                RunOutcome::Stopped { iterations } => iterations,
                RunOutcome::LengthLimited { iterations } => iterations,
            };
            if let Some(id) = req.conversation_id.as_deref() {
                if let Err(resp) = persist(&state, id, &conv).await {
                    return resp;
                }
            }
            let final_msg = conv
                .messages
                .iter()
                .rev()
                .find(|m| matches!(m, Message::Assistant { .. }))
                .cloned()
                .unwrap_or_else(|| Message::assistant_text(""));
            (
                StatusCode::OK,
                Json(ChatCompletionsResponse {
                    message: final_msg,
                    iterations,
                    history: conv.messages,
                    conversation_id: req.conversation_id,
                }),
            )
                .into_response()
        }
        Err(e) => {
            error!(error = %e, "agent run failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    }
}

// -------------------- /v1/chat/completions/stream (SSE) --------------------

async fn chat_completions_stream(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let conv = match load_or_init(&state, req.conversation_id.as_deref(), req.messages).await {
        Ok(c) => c,
        Err(resp) => return resp,
    };
    let agent = state.agent.clone();
    let store = state.store.clone();
    let conv_id = req.conversation_id;

    let stream = async_stream::stream! {
        let mut upstream = agent.run_stream(conv);
        while let Some(event) = upstream.next().await {
            // Persist the final conversation when it arrives, before forwarding
            // the Done event on. Errors here are logged but don't abort the
            // stream — the caller already has the response.
            if let (Some(id), Some(store), AgentEvent::Done { conversation, .. }) =
                (conv_id.as_deref(), store.as_ref(), &event)
            {
                if let Err(e) = store.save(id, conversation).await {
                    error!(error = %e, conversation_id = id, "store.save failed");
                }
            }
            let payload = serde_json::to_string(&event)
                .unwrap_or_else(|e| format!(r#"{{"type":"error","message":"serialize: {e}"}}"#));
            yield Ok::<_, Infallible>(Event::default().data(payload));
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

// --------------------------- /v1/chat/ws (WS) ------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsClientMessage {
    /// Append a user turn and run the agent loop to completion, streaming
    /// events back.
    User { content: String },
    /// Reset the conversation, dropping all prior turns. Does not delete
    /// the persisted row (use DELETE /v1/conversations/:id for that).
    Reset,
    /// Load an existing conversation by id and continue it. Requires
    /// `JARVIS_DB_URL`. Subsequent `user` turns save under the same id.
    Resume { id: String },
}

async fn chat_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: AppState) {
    let mut conv = Conversation::new();
    // Active conversation id — set by `Resume` and reused on subsequent
    // user turns to persist the latest state.
    let mut active_id: Option<String> = None;

    while let Some(incoming) = socket.recv().await {
        let msg = match incoming {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, "ws recv error");
                return;
            }
        };

        let text = match msg {
            WsMessage::Text(t) => t,
            WsMessage::Close(_) => return,
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            WsMessage::Binary(_) => {
                let _ = socket
                    .send(WsMessage::Text(
                        r#"{"type":"error","message":"binary frames not supported"}"#.into(),
                    ))
                    .await;
                continue;
            }
        };

        let client_msg: WsClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                let _ = socket
                    .send(WsMessage::Text(
                        json!({ "type": "error", "message": format!("bad client message: {e}") })
                            .to_string(),
                    ))
                    .await;
                continue;
            }
        };

        match client_msg {
            WsClientMessage::Reset => {
                conv = Conversation::new();
                active_id = None;
                let _ = socket
                    .send(WsMessage::Text(json!({ "type": "reset" }).to_string()))
                    .await;
                continue;
            }
            WsClientMessage::Resume { id } => {
                let Some(store) = state.store.as_ref() else {
                    let _ = socket
                        .send(WsMessage::Text(
                            json!({
                                "type": "error",
                                "message": "persistence not configured; set JARVIS_DB_URL"
                            })
                            .to_string(),
                        ))
                        .await;
                    continue;
                };
                match store.load(&id).await {
                    Ok(Some(loaded)) => {
                        conv = loaded;
                        active_id = Some(id.clone());
                        let _ = socket
                            .send(WsMessage::Text(
                                json!({
                                    "type": "resumed",
                                    "id": id,
                                    "message_count": conv.messages.len(),
                                })
                                .to_string(),
                            ))
                            .await;
                    }
                    Ok(None) => {
                        conv = Conversation::new();
                        active_id = Some(id.clone());
                        let _ = socket
                            .send(WsMessage::Text(
                                json!({
                                    "type": "resumed",
                                    "id": id,
                                    "message_count": 0,
                                })
                                .to_string(),
                            ))
                            .await;
                    }
                    Err(e) => {
                        error!(error = %e, conversation_id = %id, "store.load failed");
                        let _ = socket
                            .send(WsMessage::Text(
                                json!({
                                    "type": "error",
                                    "message": format!("load failed: {e}"),
                                })
                                .to_string(),
                            ))
                            .await;
                    }
                }
                continue;
            }
            WsClientMessage::User { content } => {
                conv.push(Message::user(content));
                let agent = state.agent.clone();
                let mut stream = agent.run_stream(conv.clone());
                let mut final_conv: Option<Conversation> = None;

                while let Some(event) = stream.next().await {
                    // Capture the final conversation so we can carry state
                    // to the next turn without relying on the client.
                    if let AgentEvent::Done { conversation, .. } = &event {
                        final_conv = Some(conversation.clone());
                    }
                    let payload = serde_json::to_string(&event).unwrap_or_else(|e| {
                        json!({ "type": "error", "message": format!("serialize: {e}") })
                            .to_string()
                    });
                    if socket.send(WsMessage::Text(payload)).await.is_err() {
                        return;
                    }
                }

                if let Some(updated) = final_conv {
                    conv = updated;
                    if let (Some(id), Some(store)) = (active_id.as_deref(), state.store.as_ref()) {
                        if let Err(e) = store.save(id, &conv).await {
                            error!(error = %e, conversation_id = id, "store.save failed");
                        }
                    }
                }
            }
        }
    }
}

// -------------------------- /v1/conversations/* ----------------------------

#[derive(Debug, Deserialize)]
struct ListConversationsQuery {
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
struct ConversationRecordView {
    id: String,
    created_at: String,
    updated_at: String,
    message_count: usize,
}

impl From<ConversationRecord> for ConversationRecordView {
    fn from(r: ConversationRecord) -> Self {
        Self {
            id: r.id,
            created_at: r.created_at,
            updated_at: r.updated_at,
            message_count: r.message_count,
        }
    }
}

async fn list_conversations(
    State(state): State<AppState>,
    Query(q): Query<ListConversationsQuery>,
) -> Response {
    let Some(store) = state.store.as_ref() else {
        return persistence_disabled();
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    match store.list(limit).await {
        Ok(records) => {
            let view: Vec<ConversationRecordView> =
                records.into_iter().map(Into::into).collect();
            (StatusCode::OK, Json(json!({ "conversations": view }))).into_response()
        }
        Err(e) => {
            error!(error = %e, "store.list failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    }
}

async fn get_conversation(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.store.as_ref() else {
        return persistence_disabled();
    };
    match store.load(&id).await {
        Ok(Some(conv)) => (
            StatusCode::OK,
            Json(json!({
                "id": id,
                "message_count": conv.messages.len(),
                "messages": conv.messages,
            })),
        )
            .into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
        Err(e) => {
            error!(error = %e, conversation_id = %id, "store.load failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    }
}

async fn delete_conversation(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(store) = state.store.as_ref() else {
        return persistence_disabled();
    };
    match store.delete(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response(),
        Err(e) => {
            error!(error = %e, conversation_id = %id, "store.delete failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
                .into_response()
        }
    }
}

// ------------------------------- helpers ----------------------------------

/// If a `conversation_id` is supplied, load any existing conversation and
/// append `incoming` to it; otherwise return a fresh `Conversation` seeded
/// with `incoming`. If an id is supplied without a configured store, the
/// caller gets a 400 response in the `Err` arm.
async fn load_or_init(
    state: &AppState,
    conversation_id: Option<&str>,
    incoming: Vec<Message>,
) -> Result<Conversation, Response> {
    let Some(id) = conversation_id else {
        return Ok(Conversation { messages: incoming });
    };
    let Some(store) = state.store.as_ref() else {
        return Err(persistence_disabled());
    };
    match store.load(id).await {
        Ok(Some(mut existing)) => {
            existing.messages.extend(incoming);
            Ok(existing)
        }
        Ok(None) => Ok(Conversation { messages: incoming }),
        Err(e) => {
            error!(error = %e, conversation_id = id, "store.load failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response())
        }
    }
}

async fn persist(state: &AppState, id: &str, conv: &Conversation) -> Result<(), Response> {
    let Some(store) = state.store.as_ref() else {
        // Unreachable in practice — `load_or_init` already checks — but
        // keep the guard so callers don't panic if the rules change.
        return Err(persistence_disabled());
    };
    store.save(id, conv).await.map_err(|e| {
        error!(error = %e, conversation_id = id, "store.save failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response()
    })
}

fn persistence_disabled() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": "persistence not configured; set JARVIS_DB_URL to enable"
        })),
    )
        .into_response()
}
