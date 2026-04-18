use std::sync::Arc;

use harness_core::Agent;

/// Shared application state injected into every handler.
#[derive(Clone)]
pub struct AppState {
    pub agent: Arc<Agent>,
}

impl AppState {
    pub fn new(agent: Arc<Agent>) -> Self {
        Self { agent }
    }
}
