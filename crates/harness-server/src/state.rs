use std::sync::Arc;

use harness_core::{Agent, ConversationStore};

/// Shared application state injected into every handler.
#[derive(Clone)]
pub struct AppState {
    pub agent: Arc<Agent>,
    /// Optional persistence layer. `None` means conversations are in-memory
    /// only (the current default); handlers that want to save history should
    /// no-op when this is absent.
    pub store: Option<Arc<dyn ConversationStore>>,
}

impl AppState {
    pub fn new(agent: Arc<Agent>) -> Self {
        Self { agent, store: None }
    }

    pub fn with_store(mut self, store: Arc<dyn ConversationStore>) -> Self {
        self.store = Some(store);
        self
    }
}
