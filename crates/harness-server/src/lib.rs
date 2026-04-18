//! HTTP facade for the agent harness.
//!
//! Exposes:
//!
//! - `GET  /health` — liveness check.
//! - `POST /v1/chat/completions` — non-streaming: runs the agent loop to
//!   completion and returns `{message, iterations, history}`.
//! - `POST /v1/chat/completions/stream` — SSE stream of `AgentEvent`s.
//! - `GET  /v1/chat/ws` — WebSocket. Client sends
//!   `{"type":"user","content":"..."}` messages; server streams `AgentEvent`s
//!   per turn. Conversation state is preserved for the lifetime of the
//!   connection.

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
