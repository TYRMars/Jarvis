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
mod auto_mode_routes;
mod automation_routes;
mod automation_runtime;
mod channel_adapter;
mod channels_dingtalk;
mod channels_feishu;
mod channels_inbound_routes;
mod channels_oauth_routes;
mod channels_routes;
mod channels_wecom;
mod channels_wecom_app;
mod chat_runs;
mod comments_routes;
mod connectors_routes;
mod conversations;
mod diagnostics;
mod diagnostics_routes;
mod docs_routes;
mod labels_routes;
mod learning_emit;
mod learning_routes;
mod market_routes;
mod memory_routes;
mod mcp_routes;
mod observability_routes;
mod openapi;
mod permissions;
mod plugin_routes;
mod project_binder;
mod project_memory;
mod projects;
mod provider_registry;
mod requirements_routes;
mod roadmap_routes;
mod route_policy;
mod routes;
mod skill_routes;
mod state;
pub mod state_layers;
mod subagent_runs;
mod subagent_runs_routes;
mod memory_sync_routes;
mod subagents_routes;
mod tasks_routes;
mod todo_binder;
mod todos_routes;
mod ui;
mod verification;
mod work_overview_routes;
mod workflow_concurrency;
mod workflow_routes;
mod workflow_runtime;
mod workspace_diff;
mod workspace_files;
mod workspace_find;
mod workspace_terminal;
mod workspaces_routes;
mod worktree;

pub use channel_adapter::{ChannelAdapter, ChannelAdapterRegistry, ChannelDispatcherImpl};
pub use skill_routes::default_roots as default_skill_roots;

pub use automation_runtime::spawn_automation_scheduler;
pub use workflow_concurrency::{WorkflowRunGate, DEFAULT_WORKFLOW_MAX_CONCURRENT};
pub use workflow_runtime::{spawn_workflow_reaper, DEFAULT_WORKFLOW_REAP_SECONDS};
pub use project_memory::{spawn_project_memory_sync, ProjectMemoryConfig};
pub use provider_registry::{ProviderEntry, ProviderInfo, ProviderRegistry, RouteError, Routed};
pub use requirements_routes::sweep_orphan_requirements_on_startup;
pub use route_policy::{ModelRoutePolicy, ModelTarget, RouteSlot};
pub use routes::router;
pub use subagent_runs::{SubAgentRunRecord, SubAgentRunRegistry, SubAgentRunStatus};
pub use state::{AppState, MemoryRuntime, ServerInfo, TelemetryStatus};

// Re-export so binaries can construct stores / modes without depending
// on harness-core directly when they only need the permission types.
pub use auto_mode::{
    spawn as spawn_auto_mode, AutoMode, AutoModeConfig, AutoModeRuntime, AutoWorkflow,
};
pub use harness_core::{PermissionMode, PermissionStore};
pub use worktree::WorktreeMode;

use std::net::SocketAddr;

/// Bind to `addr` and serve the agent harness HTTP API. Blocks until the
/// server stops.
pub async fn serve(addr: SocketAddr, state: AppState) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let app = router(state);
    axum::serve(listener, app).await
}
