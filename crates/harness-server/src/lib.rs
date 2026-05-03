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

mod agent_profiles_routes;
mod auto_mode;
mod conversations;
mod diagnostics;
mod diagnostics_routes;
mod docs_routes;
mod mcp_routes;
mod permissions;
mod plugin_routes;
mod project_binder;
mod projects;
mod provider_registry;
mod requirements_routes;
mod roadmap_routes;
mod routes;
mod skill_routes;
mod state;
mod todo_binder;
mod todos_routes;
mod ui;
mod verification;
mod workspace_diff;
mod workspaces_routes;
mod worktree;

pub use skill_routes::default_roots as default_skill_roots;

pub use provider_registry::{ProviderEntry, ProviderInfo, ProviderRegistry, RouteError, Routed};
pub use routes::router;
pub use state::{AppState, ServerInfo};

// Re-export so binaries can construct stores / modes without depending
// on harness-core directly when they only need the permission types.
pub use harness_core::{PermissionMode, PermissionStore};
pub use auto_mode::{spawn as spawn_auto_mode, AutoMode, AutoModeConfig};
pub use worktree::WorktreeMode;

use std::net::SocketAddr;

/// Bind to `addr` and serve the agent harness HTTP API. Blocks until the
/// server stops.
pub async fn serve(addr: SocketAddr, state: AppState) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let app = router(state);
    axum::serve(listener, app).await
}
