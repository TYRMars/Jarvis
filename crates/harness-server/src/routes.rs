use std::convert::Infallible;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        State,
    },
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures::{Stream, StreamExt};
use harness_core::{AgentEvent, Conversation, Message, RunOutcome};
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
}

#[derive(Debug, Serialize)]
struct ChatCompletionsResponse {
    message: Message,
    iterations: usize,
    history: Vec<Message>,
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> Response {
    let mut conv = Conversation { messages: req.messages };

    match state.agent.run(&mut conv).await {
        Ok(outcome) => {
            let iterations = match outcome {
                RunOutcome::Stopped { iterations } => iterations,
                RunOutcome::LengthLimited { iterations } => iterations,
            };
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
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let conv = Conversation { messages: req.messages };
    let agent = state.agent.clone();
    let stream = agent.run_stream(conv).map(|event| {
        let payload = serde_json::to_string(&event)
            .unwrap_or_else(|e| format!(r#"{{"type":"error","message":"serialize: {e}"}}"#));
        Ok::<_, Infallible>(Event::default().data(payload))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// --------------------------- /v1/chat/ws (WS) ------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsClientMessage {
    /// Append a user turn and run the agent loop to completion, streaming
    /// events back.
    User { content: String },
    /// Reset the conversation, dropping all prior turns.
    Reset,
}

async fn chat_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: AppState) {
    let mut conv = Conversation::new();

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
                let _ = socket
                    .send(WsMessage::Text(json!({ "type": "reset" }).to_string()))
                    .await;
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
                }
            }
        }
    }
}
