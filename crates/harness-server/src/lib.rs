//! HTTP facade for the agent harness.
//!
//! Exposes a minimal OpenAI-compatible surface:
//!
//! - `GET  /health` — liveness check
//! - `POST /v1/chat/completions` — runs the configured `Agent` against the
//!   supplied messages and returns the final assistant message.
//!
//! Streaming, multiple-model dispatch, and auth are intentionally out of
//! scope for this scaffold.

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
