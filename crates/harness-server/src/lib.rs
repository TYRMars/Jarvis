//! HTTP facade for the agent harness.
//!
//! Exposes:
//!
//! - `GET  /health` — liveness check.
//! - `POST /v1/chat/completions` — non-streaming: runs the agent loop to
//!   completion and returns `{message, iterations, history}`. Accepts an
//!   optional `conversation_id` that, when the server is configured with
//!   a `ConversationStore`, loads prior turns and saves the result.
//! - `POST /v1/chat/completions/stream` — SSE stream of `AgentEvent`s.
//!   Same `conversation_id` semantics as the blocking variant.
//! - `GET  /v1/chat/ws` — WebSocket. Client sends
//!   `{"type":"user","content":"..."}`, `{"type":"reset"}`, or
//!   `{"type":"resume","id":"..."}` messages; server streams
//!   `AgentEvent`s per turn. Conversation state is preserved for the
//!   lifetime of the connection; `resume` + `user` turns save to the
//!   store after each turn.
//! - `GET    /v1/conversations` — list persisted conversations
//!   (newest first). Requires a store.
//! - `GET    /v1/conversations/:id` — fetch a conversation's messages.
//! - `DELETE /v1/conversations/:id` — delete a conversation.

mod routes;
mod state;

pub use routes::router;
pub use state::AppState;

use std::net::SocketAddr;

/// Bind to `addr` and serve the agent harness HTTP API. Blocks until the
/// server stops.
pub async fn serve(addr: SocketAddr, state: AppState) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let app = router(state);
    axum::serve(listener, app).await
}
