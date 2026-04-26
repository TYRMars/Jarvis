use std::sync::Arc;

use harness_core::{Agent, AgentConfig, ConversationStore, LlmProvider};

use crate::provider_registry::{ProviderRegistry, RouteError, Routed};

/// Shared application state injected into every handler.
///
/// Holds a `ProviderRegistry` (so requests can pick which LLM to
/// hit) plus an "agent template" that captures the parts of
/// `AgentConfig` that don't depend on the chosen provider — tools,
/// system prompt, max iterations, memory, approver. Each request
/// builds a fresh `Agent` from `template + selected provider`.
///
/// This keeps Agent construction per-request cheap (just an `Arc`
/// shuffle) while letting different turns target different
/// providers within the same process.
#[derive(Clone)]
pub struct AppState {
    pub providers: Arc<ProviderRegistry>,
    pub agent_template: AgentConfig,
    /// Optional persistence layer. `None` means conversations are in-memory
    /// only (the current default); handlers that want to save history should
    /// no-op when this is absent.
    pub store: Option<Arc<dyn ConversationStore>>,
}

impl AppState {
    /// Build state from an explicit registry plus a template
    /// `AgentConfig`. The template's `model` field is ignored —
    /// per-request routing always overrides it.
    pub fn from_registry(providers: ProviderRegistry, template: AgentConfig) -> Self {
        Self {
            providers: Arc::new(providers),
            agent_template: template,
            store: None,
        }
    }

    /// Backwards-compatible single-provider constructor. Wraps the
    /// agent's `LlmProvider` in a one-entry registry keyed by
    /// `"default"`, with the agent's configured `model` as that
    /// entry's default model. Tests and simple deployments that
    /// don't need multi-provider routing use this.
    pub fn new(agent: Arc<Agent>) -> Self {
        let llm: Arc<dyn LlmProvider> = agent.llm.clone();
        let mut registry = ProviderRegistry::new("default");
        registry.insert("default", llm, agent.config.model.clone());
        Self {
            providers: Arc::new(registry),
            agent_template: agent.config.clone(),
            store: None,
        }
    }

    pub fn with_store(mut self, store: Arc<dyn ConversationStore>) -> Self {
        self.store = Some(store);
        self
    }

    /// Build a fresh `Agent` for one request, routed via the
    /// registry. The returned agent shares the template's tools /
    /// memory / approver / system_prompt / max_iterations.
    pub fn build_agent(
        &self,
        explicit_provider: Option<&str>,
        model: Option<&str>,
    ) -> Result<Arc<Agent>, RouteError> {
        let routed = self.providers.pick(explicit_provider, model)?;
        Ok(Arc::new(self.agent_from_routed(routed)))
    }

    /// Like `build_agent` but lets the caller mutate the cloned
    /// `AgentConfig` before constructing — used by the WS handler
    /// to swap in a per-socket `ChannelApprover`.
    pub fn build_agent_with<F>(
        &self,
        explicit_provider: Option<&str>,
        model: Option<&str>,
        customise: F,
    ) -> Result<Arc<Agent>, RouteError>
    where
        F: FnOnce(&mut AgentConfig),
    {
        let routed = self.providers.pick(explicit_provider, model)?;
        let mut cfg = self.agent_template.clone();
        cfg.model = routed.model.clone();
        customise(&mut cfg);
        Ok(Arc::new(Agent::new(routed.entry.provider.clone(), cfg)))
    }

    fn agent_from_routed(&self, routed: Routed<'_>) -> Agent {
        let mut cfg = self.agent_template.clone();
        cfg.model = routed.model;
        Agent::new(routed.entry.provider.clone(), cfg)
    }
}
