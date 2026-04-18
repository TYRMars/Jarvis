use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{BoxError, Result};

/// A tool the agent can call. Implementors describe themselves with a JSON
/// schema and execute against parsed arguments.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON-schema describing the `arguments` object passed to `invoke`.
    fn parameters(&self) -> Value;

    async fn invoke(&self, args: Value) -> std::result::Result<String, BoxError>;
}

/// Provider-agnostic description of a tool, suitable for serialising into a
/// chat-completions `tools` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new() }
    }

    pub fn register<T: Tool + 'static>(&mut self, tool: T) -> &mut Self {
        self.tools.insert(tool.name().to_string(), Arc::new(tool));
        self
    }

    pub fn register_arc(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.insert(tool.name().to_string(), tool);
        self
    }

    pub fn resolve(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools
            .values()
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }
}

pub async fn invoke_tool(
    registry: &ToolRegistry,
    name: &str,
    args: Value,
) -> Result<String> {
    let tool = registry
        .resolve(name)
        .ok_or_else(|| crate::Error::ToolNotFound(name.to_string()))?;
    tool.invoke(args)
        .await
        .map_err(|source| crate::Error::ToolFailed { name: name.to_string(), source })
}
