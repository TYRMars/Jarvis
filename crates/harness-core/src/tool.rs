use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{BoxError, Result};

/// What "shape" of side effect a tool has. Used by Plan Mode to filter
/// the LLM-visible tool catalogue: in `plan` mode only `Read` tools
/// (plus `ExitPlanTool`) reach the model, which makes "agent can only
/// look, not touch" structural rather than approver-policed.
///
/// **Not** a substitute for [`Tool::requires_approval`] — those two
/// concerns will diverge over time. `http.fetch` is `Network`
/// (Plan Mode hides it) but doesn't need an approval prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    /// Pure observation. `fs.read`, `fs.list`, `code.grep`,
    /// `git.{status,diff,log,show}`, `workspace.context`, etc.
    Read,
    /// Mutates the local filesystem. `fs.write`, `fs.edit`,
    /// `fs.patch`, `git.{add,commit,merge}`.
    Write,
    /// Spawns a subprocess. `shell.exec`.
    Exec,
    /// Talks to the network. `http.fetch`. MCP remote tools default
    /// here too (we can't introspect their semantics, so the safe
    /// default is "treat as outside-touching").
    Network,
}

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

    /// Side-effect category. Drives [Plan Mode][crate::permission]
    /// filtering — the LLM only sees `ToolCategory::Read` tools while
    /// in `plan` mode. Defaults to `Write` (conservative — anything
    /// that doesn't explicitly identify itself as read-only stays out
    /// of plan-mode tool catalogues).
    fn category(&self) -> ToolCategory {
        ToolCategory::Write
    }

    /// One-line "what would this tool do" string for the audit /
    /// approval-card UI. Also consumed by the permission rule engine
    /// as a fallback target string when a rule's `matchers` JSON
    /// pointer doesn't resolve. Returns `None` if the tool has nothing
    /// useful to say beyond its name (typical: read-only tools).
    ///
    /// Examples:
    /// - `shell.exec` → `Some("npm test")`
    /// - `fs.edit`    → `Some("src/foo.rs")`
    /// - `git.commit` → `Some("feat: add foo")` (first line of message)
    fn summary_for_audit(&self, _args: &Value) -> Option<String> {
        None
    }

    /// Marker for tools whose call ends the agent's current turn even
    /// if the model emitted more tool calls in the same response.
    /// Today only [`crate::permission::ExitPlanTool`] uses this — the
    /// orchestrator emits a typed event when it sees a terminal-tool
    /// call and stops processing the batch.
    ///
    /// Default `false`. Tools that override to `true` should still
    /// produce a meaningful `invoke` return value because the
    /// transport may surface it before the terminal event.
    fn is_terminal(&self) -> bool {
        false
    }
}

/// Provider-agnostic description of a tool, suitable for serialising into a
/// chat-completions `tools` array.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
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
    /// Names the operator has explicitly muted at runtime. Muted
    /// tools stay registered (so unmuting is fast and doesn't lose
    /// the underlying `Arc<dyn Tool>`) but are excluded from
    /// [`specs`](Self::specs) / [`specs_filtered`](Self::specs_filtered)
    /// — which means the LLM never sees them — and
    /// [`resolve`](Self::resolve) returns `None` so any in-flight
    /// call against a freshly-muted tool fails cleanly with
    /// `ToolNotFound`.
    ///
    /// Lives next to `tools` rather than as a separate type so the
    /// existing `RwLock<ToolRegistry>` lock contract still covers
    /// it without a second lock.
    muted: std::collections::HashSet<String>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            muted: std::collections::HashSet::new(),
        }
    }

    pub fn register<T: Tool + 'static>(&mut self, tool: T) -> &mut Self {
        self.tools.insert(tool.name().to_string(), Arc::new(tool));
        self
    }

    pub fn register_arc(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.insert(tool.name().to_string(), tool);
        self
    }

    /// Remove a single tool by name. Returns `true` if it was present.
    /// Used by the MCP / plugin manager when a server or plugin is
    /// dropped at runtime.
    pub fn unregister(&mut self, name: &str) -> bool {
        self.muted.remove(name);
        self.tools.remove(name).is_some()
    }

    /// Remove every tool whose name starts with `<prefix>.` (the
    /// namespace separator used by the MCP bridge). Returns the
    /// removed tool names so callers can log / report.
    pub fn unregister_prefix(&mut self, prefix: &str) -> Vec<String> {
        let needle = format!("{prefix}.");
        let drop: Vec<String> = self
            .tools
            .keys()
            .filter(|k| k.starts_with(&needle))
            .cloned()
            .collect();
        for name in &drop {
            self.tools.remove(name);
            self.muted.remove(name);
        }
        drop
    }

    /// True iff a tool with this name is currently registered.
    /// Mute state does not affect this — `contains` reports
    /// presence in the registry, not visibility to the LLM. The
    /// admin / settings UI uses this to render the tool catalog
    /// regardless of mute state.
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Mark a tool as muted. Returns `true` when the tool exists
    /// in the registry (whether or not it was already muted) and
    /// `false` when the name doesn't match a registered tool.
    /// Idempotent: muting an already-muted tool is a no-op success.
    pub fn mute(&mut self, name: &str) -> bool {
        if !self.tools.contains_key(name) {
            return false;
        }
        self.muted.insert(name.to_string());
        true
    }

    /// Clear the mute state for a tool. Returns `true` when the
    /// tool was previously muted; `false` for unknown / already-
    /// active tools.
    pub fn unmute(&mut self, name: &str) -> bool {
        self.muted.remove(name)
    }

    pub fn is_muted(&self, name: &str) -> bool {
        self.muted.contains(name)
    }

    /// Snapshot of every currently-muted tool name, sorted for
    /// stable wire output.
    pub fn muted_names(&self) -> Vec<String> {
        let mut out: Vec<String> = self.muted.iter().cloned().collect();
        out.sort();
        out
    }

    /// Resolve a tool by name. Muted tools return `None` so the
    /// agent loop's `invoke_tool` reports `ToolNotFound` — same
    /// surface the model sees when it asks for a tool that doesn't
    /// exist. The settings UI looks up tools via the parallel
    /// [`contains`](Self::contains) / [`is_muted`](Self::is_muted)
    /// pair and skips this call entirely.
    pub fn resolve(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if self.muted.contains(name) {
            return None;
        }
        self.tools.get(name).cloned()
    }

    /// Admin-side resolve that returns the underlying `Arc` even
    /// when the tool is muted. Used by `GET /v1/tools` to render
    /// the catalog UI — muted tools must still appear (greyed out
    /// with a disabled toggle) so the operator can flip them back
    /// on. Never use this from the agent loop; the path that
    /// actually invokes the tool must respect mute state.
    pub fn resolve_unchecked(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// Every registered tool name, sorted, regardless of mute
    /// state. Counterpart to [`specs`](Self::specs) for the
    /// settings UI.
    pub fn all_names(&self) -> Vec<String> {
        let mut out: Vec<String> = self.tools.keys().cloned().collect();
        out.sort();
        out
    }

    /// Provider-agnostic descriptions of every registered tool, sorted
    /// by name. The sort matters: every iteration of every turn ships
    /// these to the LLM, and `HashMap` iteration order isn't stable
    /// across processes (or even runs of the same process). A stable
    /// order means the prefix bytes that go into a request stay
    /// identical turn-to-turn, which is what every provider's prompt
    /// cache keys on. Free win.
    ///
    /// Muted tools are filtered out so the LLM never sees a tool
    /// the operator has disabled.
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.specs_filtered(|_| true)
    }

    /// Like [`Self::specs`] but only includes tools for which `pred`
    /// returns `true`. Used by the agent's Plan-Mode `tool_filter`
    /// to hide write/exec/network tools from the LLM catalogue while
    /// keeping them resolvable for in-flight calls. Muted tools are
    /// excluded regardless of the predicate (mute is the stronger
    /// signal — operator intent always wins).
    pub fn specs_filtered<F>(&self, pred: F) -> Vec<ToolSpec>
    where
        F: Fn(&dyn Tool) -> bool,
    {
        let mut specs: Vec<ToolSpec> = self
            .tools
            .iter()
            .filter(|(name, _)| !self.muted.contains(*name))
            .map(|(_, t)| t)
            .filter(|t| pred(t.as_ref()))
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

pub async fn invoke_tool(registry: &ToolRegistry, name: &str, args: Value) -> Result<String> {
    let tool = registry
        .resolve(name)
        .ok_or_else(|| crate::Error::ToolNotFound(name.to_string()))?;
    tool.invoke(args)
        .await
        .map_err(|source| crate::Error::ToolFailed {
            name: name.to_string(),
            source,
        })
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
    fn unregister_removes_named_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        registry.register(NamedTool("beta"));
        assert!(registry.contains("alpha"));
        assert!(registry.unregister("alpha"));
        assert!(!registry.contains("alpha"));
        assert!(registry.contains("beta"));
        assert!(!registry.unregister("alpha"));
    }

    #[test]
    fn unregister_prefix_removes_namespaced_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("git.status"));
        registry.register(NamedTool("git.diff"));
        registry.register(NamedTool("fs.read"));
        let mut removed = registry.unregister_prefix("git");
        removed.sort();
        assert_eq!(
            removed,
            vec!["git.diff".to_string(), "git.status".to_string()]
        );
        assert!(!registry.contains("git.status"));
        assert!(registry.contains("fs.read"));
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
    fn mute_hides_tool_from_specs_and_resolve() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        registry.register(NamedTool("beta"));
        assert!(registry.mute("alpha"));
        // specs() omits muted; resolve() returns None.
        let specs = registry.specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["beta"]);
        assert!(registry.resolve("alpha").is_none());
        assert!(registry.resolve("beta").is_some());
        // contains() reports presence regardless (settings UI uses this).
        assert!(registry.contains("alpha"));
        assert!(registry.is_muted("alpha"));
    }

    #[test]
    fn unmute_restores_visibility() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        assert!(registry.mute("alpha"));
        assert!(registry.unmute("alpha"));
        assert!(!registry.is_muted("alpha"));
        let specs = registry.specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha"]);
        assert!(registry.resolve("alpha").is_some());
    }

    #[test]
    fn mute_unknown_tool_returns_false() {
        let mut registry = ToolRegistry::new();
        assert!(!registry.mute("nope"));
        assert!(!registry.is_muted("nope"));
    }

    #[test]
    fn unregister_clears_mute_state() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        assert!(registry.mute("alpha"));
        assert!(registry.unregister("alpha"));
        // Re-register and confirm we don't carry stale mute state.
        registry.register(NamedTool("alpha"));
        assert!(!registry.is_muted("alpha"));
        assert!(registry.resolve("alpha").is_some());
    }

    #[test]
    fn muted_names_is_sorted() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        registry.register(NamedTool("beta"));
        registry.register(NamedTool("gamma"));
        registry.mute("gamma");
        registry.mute("alpha");
        assert_eq!(registry.muted_names(), vec!["alpha", "gamma"]);
    }

    #[test]
    fn specs_filtered_still_excludes_muted() {
        // The Plan-Mode predicate filters by category, but mute
        // wins regardless — operator intent is the stronger signal.
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("alpha"));
        registry.register(NamedTool("beta"));
        registry.mute("beta");
        // Predicate accepts everything; mute still hides "beta".
        let specs = registry.specs_filtered(|_| true);
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha"]);
    }

    #[test]
    fn cacheable_propagates_into_specs() {
        let mut registry = ToolRegistry::new();
        registry.register(NamedTool("plain"));
        registry.register(CacheableTool);
        let specs = registry.specs();
        let by_name: std::collections::HashMap<&str, bool> = specs
            .iter()
            .map(|s| (s.name.as_str(), s.cacheable))
            .collect();
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
        assert!(
            v.get("cacheable").is_none(),
            "cacheable=false must be omitted"
        );
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
