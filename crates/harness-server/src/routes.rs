use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use harness_core::{Conversation, Message};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::error;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/chat/completions", post(chat_completions))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsRequest {
    #[serde(default)]
    #[allow(dead_code)]
    model: Option<String>,
    messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
struct ChatCompletionsResponse {
    /// The final assistant message after the agent finishes its loop.
    message: Message,
    iterations: usize,
    /// Full message history including tool calls and tool results.
    history: Vec<Message>,
}

async fn chat_completions(
    State(state): State<AppState>,
    Json(req): Json<ChatCompletionsRequest>,
) -> impl IntoResponse {
    let mut conv = Conversation { messages: req.messages };

    match state.agent.run(&mut conv).await {
        Ok(outcome) => {
            let iterations = match outcome {
                harness_core::RunOutcome::Stopped { iterations } => iterations,
                harness_core::RunOutcome::LengthLimited { iterations } => iterations,
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
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}
