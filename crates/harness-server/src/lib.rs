//! HTTP facade for the agent harness.
//!
//! Ephemeral chat (no persistence required):
//!
//! - `GET  /health` — liveness check.
//! - `POST /v1/chat/completions` — non-streaming: runs the agent loop to
//!   completion and returns `{message, iterations, history}`.
//! - `POST /v1/chat/completions/stream` — SSE stream of `AgentEvent`s.
//! - `GET  /v1/chat/ws` — WebSocket. Client sends
//!   `{"type":"user","content":"..."}` / `{"type":"reset"}` /
//!   `{"type":"resume","id":"..."}` / `{"type":"new","id":"<optional>"}`;
//!   server streams `AgentEvent`s per turn. In persisted mode (`resume`
//!   or `new`) the server auto-saves after every turn.
//!
//! Persisted conversation CRUD (require a configured `ConversationStore`,
//! return `503` when absent):
//!
//! - `POST   /v1/conversations`              — create (optional `system`, `id`)
//! - `GET    /v1/conversations`              — list newest-first
//! - `GET    /v1/conversations/:id`          — load full conversation
//! - `DELETE /v1/conversations/:id`          — delete
//! - `POST   /v1/conversations/:id/messages` — append + run (blocking)
//! - `POST   /v1/conversations/:id/messages/stream` — append + run (SSE)

mod conversations;
mod provider_registry;
mod routes;
mod state;
mod ui;

pub use provider_registry::{ProviderEntry, ProviderInfo, ProviderRegistry, RouteError, Routed};
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
