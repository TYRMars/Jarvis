//! Per-concern slices of [`AppState`].
//!
//! `AppState` carries ~35 fields. Most handlers only need 2-3 of
//! them, but typing `State<AppState>` forces tests to construct the
//! whole tree to call a single handler. This module defines
//! `*Layer` structs that group related fields by concern and gives
//! each an `axum::extract::FromRef<AppState>` impl, so handlers can
//! write `State<ChannelLayer>` and tests can build a tiny layer
//! directly.
//!
//! The migration is incremental: new handlers should use a `*Layer`;
//! old handlers can stay on `State<AppState>` until touched. Both
//! shapes coexist because `FromRef<AppState>` for `AppState` is
//! identity (axum derives it automatically when state is `Clone`).
//!
//! When a handler needs fields from multiple domains, take multiple
//! `State<…>` extractors — axum threads each one through its own
//! `FromRef` impl:
//!
//! ```ignore
//! async fn handler(
//!     State(channels): State<ChannelLayer>,
//!     State(conv): State<ConversationLayer>,
//! ) -> Response { … }
//! ```
//!
//! Don't create a layer-per-handler-bundle — that just re-creates
//! `AppState` with extra steps. Keep layers grouped by **domain**
//! (channels / projects / observability …), not by route module.
//!
//! ### When a handler legitimately spans 3+ domains
//!
//! Some handlers genuinely touch many parts of the state — the
//! inbound channel flow, for example, loads/saves conversations
//! (ConversationLayer), runs the agent loop (needs `build_agent`
//! which itself reads providers + template + tools + memory…),
//! looks up bindings (ChannelLayer), and pushes the reply back via
//! the adapter (ChannelLayer again). Taking 4 separate
//! `State<…>` extractors plus a path to `AppState::build_agent`
//! would just be `State<AppState>` with extra steps.
//!
//! For those, stay on `State<AppState>` and leave a comment naming
//! the layers involved. The point of slicing is to make narrow
//! handlers test-friendly, not to force every handler through a
//! per-domain straitjacket.

use axum::extract::FromRef;
use std::sync::Arc;

use harness_channel::{ChannelBindingStore, ChannelInstanceStore};
use harness_core::{AgentProfileStore, ConversationStore, PermissionMode, PermissionStore, TodoStore};
use harness_observability::{EvalStore, ObservabilityStore};
use harness_project::{
    ActivityStore, CommentStore, DocStore, LabelStore, ProjectMemoryStore, ProjectStore,
    RequirementRunStore, RequirementStore,
};

use crate::channel_adapter::ChannelAdapterRegistry;
use crate::state::AppState;

/// Messaging-channel slice: instance + binding stores plus the
/// per-kind adapter registry. Consumed by every handler under
/// `channels_routes.rs`, `channels_inbound_routes.rs`, and
/// `channels_oauth_routes.rs`.
///
/// `instances` and `bindings` are `Option` because operators with no
/// persistence URL run without them — handlers must 503 cleanly
/// when they're absent. `adapters` is always present (the registry
/// is built unconditionally at startup, even when no instance is
/// configured).
#[derive(Clone)]
pub struct ChannelLayer {
    pub instances: Option<Arc<dyn ChannelInstanceStore>>,
    pub bindings: Option<Arc<dyn ChannelBindingStore>>,
    pub adapters: Arc<ChannelAdapterRegistry>,
}

impl FromRef<AppState> for ChannelLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            instances: s.channel_instances.clone(),
            bindings: s.channel_bindings.clone(),
            adapters: s.channel_adapters.clone(),
        }
    }
}

/// Conversation persistence slice. The base `ConversationStore` is
/// what every persistent-chat handler reads/writes; the auxiliary
/// `workspaces` and `chat_runs` registries live near it. Consumed
/// by `conversations.rs`, `routes.rs`, and the inbound channel flow
/// (which loads / saves the conversation after the agent loop).
#[derive(Clone)]
pub struct ConversationLayer {
    pub store: Option<Arc<dyn ConversationStore>>,
    pub workspaces: Option<Arc<harness_store::WorkspaceStore>>,
    pub chat_runs: Arc<crate::chat_runs::ChatRunRegistry>,
}

impl FromRef<AppState> for ConversationLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            store: s.store.clone(),
            workspaces: s.workspaces.clone(),
            chat_runs: s.chat_runs.clone(),
        }
    }
}

/// Project-domain slice. Every handler under `projects.rs`,
/// `requirements_routes.rs`, `comments_routes.rs`, `labels_routes.rs`,
/// `docs_routes.rs`, and `roadmap_routes.rs` lives off this slice.
/// Includes the agent-profile store because it's primarily consumed
/// by the kanban (assignee picker) rather than the agent loop
/// itself.
#[derive(Clone)]
pub struct ProjectLayer {
    pub projects: Option<Arc<dyn ProjectStore>>,
    pub requirements: Option<Arc<dyn RequirementStore>>,
    pub requirement_runs: Option<Arc<dyn RequirementRunStore>>,
    pub activities: Option<Arc<dyn ActivityStore>>,
    pub comments: Option<Arc<dyn CommentStore>>,
    pub labels: Option<Arc<dyn LabelStore>>,
    pub docs: Option<Arc<dyn DocStore>>,
    pub project_memories: Option<Arc<dyn ProjectMemoryStore>>,
    pub agent_profiles: Option<Arc<dyn AgentProfileStore>>,
}

impl FromRef<AppState> for ProjectLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            projects: s.projects.clone(),
            requirements: s.requirements.clone(),
            requirement_runs: s.requirement_runs.clone(),
            activities: s.activities.clone(),
            comments: s.comments.clone(),
            labels: s.labels.clone(),
            docs: s.docs.clone(),
            project_memories: s.project_memories.clone(),
            agent_profiles: s.agent_profiles.clone(),
        }
    }
}

/// Quality / telemetry slice. Two stores plus the OTLP exporter
/// status snapshot:
/// - `observability` — ingested run + span facts (`/v1/observability/*`).
/// - `evals` — grader-driven eval runs.
/// - `telemetry` — boot-time snapshot of which OTLP exporter (if
///   any) was installed, surfaced by `GET /v1/observability/exporter`.
///
/// Both stores are optional — operators without a persistence URL
/// run without them and the corresponding REST endpoints 503.
#[derive(Clone)]
pub struct ObservabilityLayer {
    pub observability: Option<Arc<dyn ObservabilityStore>>,
    pub evals: Option<Arc<dyn EvalStore>>,
    pub telemetry: Option<crate::state::TelemetryStatus>,
}

impl FromRef<AppState> for ObservabilityLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            observability: s.observability.clone(),
            evals: s.evals.clone(),
            telemetry: s.telemetry.clone(),
        }
    }
}

/// Permission slice — the rule store + the WS-session default mode.
/// Read by the WS handler (`routes.rs::ws_chat`) when it builds the
/// per-socket `ChannelApprover`. Few handlers touch this directly;
/// the slice exists because the two fields belong together
/// semantically.
#[derive(Clone)]
pub struct PermissionLayer {
    pub store: Option<Arc<dyn PermissionStore>>,
    pub default_mode: PermissionMode,
}

impl FromRef<AppState> for PermissionLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            store: s.permission_store.clone(),
            default_mode: s.default_permission_mode,
        }
    }
}

/// Workspace metadata — the resolved filesystem root every `fs.*`
/// / `git.*` / `code.grep` / `shell.exec` tool is scoped to, plus
/// the user's writable skill root for skill-market installs, plus
/// the recent-workspaces registry that powers the chat header's
/// "Recent" dropdown. Read by handlers that need to render
/// "you're working in X" or resolve a relative path against the
/// active workspace.
#[derive(Clone)]
pub struct WorkspaceLayer {
    pub root: Option<std::path::PathBuf>,
    pub user_skills_dir: Option<std::path::PathBuf>,
    pub registry: Option<Arc<harness_store::WorkspaceStore>>,
}

impl FromRef<AppState> for WorkspaceLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            root: s.workspace_root.clone(),
            user_skills_dir: s.user_skills_dir.clone(),
            registry: s.workspaces.clone(),
        }
    }
}

/// TODO-board slice. Tiny — the store plus the "prepend recent
/// TODOs to the agent's system prompt?" flag the agent loop reads
/// at build time. Consumed by `todos_routes.rs` plus the agent
/// loop's `build_agent_with` callsite.
#[derive(Clone)]
pub struct TodosLayer {
    pub store: Option<Arc<dyn TodoStore>>,
    pub in_prompt: bool,
}

impl FromRef<AppState> for TodosLayer {
    fn from_ref(s: &AppState) -> Self {
        Self {
            store: s.todos.clone(),
            in_prompt: s.todos_in_prompt,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_registry::ProviderRegistry;
    use harness_core::AgentConfig;

    /// Sanity: `FromRef<AppState>` for `ChannelLayer` snapshots the
    /// expected fields. Future layers should grow a similar
    /// projection test so a refactor that drops a field from
    /// AppState doesn't silently break the slice.
    #[test]
    fn channel_layer_projects_three_fields() {
        let providers = ProviderRegistry::new("test");
        let cfg = AgentConfig::new("model");
        let state = AppState::from_registry(providers, cfg);
        // Default: stores absent, adapters present.
        let layer = ChannelLayer::from_ref(&state);
        assert!(layer.instances.is_none());
        assert!(layer.bindings.is_none());
        // Adapter registry is built at construction time (with_defaults),
        // so the layer always has one — there's no None branch to test.
        assert!(layer.adapters.iter().count() > 0);
    }

    #[test]
    fn project_layer_starts_all_none() {
        // Default test-shaped AppState has no persistence wired in,
        // so every project-domain store should project to None.
        let providers = ProviderRegistry::new("test");
        let cfg = AgentConfig::new("model");
        let state = AppState::from_registry(providers, cfg);
        let layer = ProjectLayer::from_ref(&state);
        assert!(layer.projects.is_none());
        assert!(layer.requirements.is_none());
        assert!(layer.requirement_runs.is_none());
        assert!(layer.activities.is_none());
        assert!(layer.comments.is_none());
        assert!(layer.labels.is_none());
        assert!(layer.docs.is_none());
        assert!(layer.project_memories.is_none());
        assert!(layer.agent_profiles.is_none());
    }

    #[test]
    fn observability_layer_starts_all_none() {
        let providers = ProviderRegistry::new("test");
        let cfg = AgentConfig::new("model");
        let state = AppState::from_registry(providers, cfg);
        let layer = ObservabilityLayer::from_ref(&state);
        assert!(layer.observability.is_none());
        assert!(layer.evals.is_none());
    }
}
