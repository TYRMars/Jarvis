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

    /// Whether this tool's invocations should pass through an
    /// [`crate::Approver`] before running. Defaults to `false`; tools
    /// that mutate the host (write files, run commands, …) should
    /// override to `true` so a configured approver gates them.
    fn requires_approval(&self) -> bool {
        false
    }

    /// Hint that this tool's spec is stable enough to belong inside a
    /// cached prefix. Default `false`. Providers that support
    /// explicit cache breakpoints (Anthropic) attach `cache_control`
    /// to the **last** entry of the tools array when any registered
    /// tool returns `true` — caching the whole catalog. OpenAI's
    /// prefix cache is automatic and ignores the flag.
    fn cacheable(&self) -> bool {
        false
    }
}

/// Provider-agnostic description of a tool, suitable for serialising into a
/// chat-completions `tools` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    /// Mirrors [`Tool::cacheable`]; populated by [`ToolRegistry::specs`].
    /// Skipped on the wire when `false` so existing JSON consumers
    /// see the previous shape.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cacheable: bool,
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

    /// Provider-agnostic descriptions of every registered tool, sorted
    /// by name. The sort matters: every iteration of every turn ships
    /// these to the LLM, and `HashMap` iteration order isn't stable
    /// across processes (or even runs of the same process). A stable
    /// order means the prefix bytes that go into a request stay
    /// identical turn-to-turn, which is what every provider's prompt
    /// cache keys on. Free win.
    pub fn specs(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self
            .tools
            .values()
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
                cacheable: t.cacheable(),
            })
            .collect();
        specs.sort_by(|a, b| a.name.cmp(&b.name));
        specs
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::BoxError;
    use serde_json::json;

    struct NamedTool(&'static str);

    #[async_trait]
    impl Tool for NamedTool {
        fn name(&self) -> &str {
            self.0
        }
        fn description(&self) -> &str {
            "test"
        }
        fn parameters(&self) -> Value {
            json!({"type":"object"})
        }
        async fn invoke(&self, _args: Value) -> std::result::Result<String, BoxError> {
            Ok(self.0.to_string())
        }
    }

    #[test]
    fn specs_are_sorted_by_name() {
        let mut registry = ToolRegistry::new();
        // Insert in a non-alphabetical order on purpose.
        registry.register(NamedTool("zebra"));
        registry.register(NamedTool("alpha"));
        registry.register(NamedTool("mango"));

        let specs = registry.specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "mango", "zebra"]);

        // Calling twice gives the exact same order — stable across calls.
        let again = registry.specs();
        let again_names: Vec<&str> = again.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, again_names);
    }

    struct CacheableTool;
    #[async_trait]
    impl Tool for CacheableTool {
        fn name(&self) -> &str {
            "cached"
        }
        fn description(&self) -> &str {
            "stable schema"
        }
        fn parameters(&self) -> Value {
            json!({"type":"object"})
        }
        fn cacheable(&self) -> bool {
            true
        }
        async fn invoke(&self, _args: Value) -> std::result::Result<String, BoxError> {
            Ok(String::new())
        }
    }

    #[test]
    fn cacheable_default_is_false() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("plain"));
        let specs = registry.specs();
        assert!(!specs[0].cacheable);
    }

    #[test]
    fn cacheable_propagates_into_specs() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("plain"));
        registry.register(CacheableTool);
        let specs = registry.specs();
        let by_name: std::collections::HashMap<&str, bool> =
            specs.iter().map(|s| (s.name.as_str(), s.cacheable)).collect();
        assert!(!by_name["plain"]);
        assert!(by_name["cached"]);
    }

    #[test]
    fn toolspec_serialises_without_cacheable_when_false() {
        let s = ToolSpec {
            name: "foo".into(),
            description: "d".into(),
            parameters: json!({}),
            cacheable: false,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("cacheable").is_none(), "cacheable=false must be omitted");
    }

    #[test]
    fn toolspec_serialises_cacheable_true() {
        let s = ToolSpec {
            name: "foo".into(),
            description: "d".into(),
            parameters: json!({}),
            cacheable: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["cacheable"], json!(true));
    }
}
