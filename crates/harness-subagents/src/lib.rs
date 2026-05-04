//! SubAgent registry — built-in delegated agents the main agent can
//! invoke as tools.
//!
//! See `docs/proposals/subagents.zh-CN.md` for the design rationale.
//! Quick recap:
//!
//! - Each [`SubAgent`] presents itself as a `subagent.<name>` tool to
//!   the main agent. Calling the tool runs the subagent body
//!   (internal Agent loop or external SDK sidecar) and streams its
//!   reasoning + tool calls back via [`harness_core::subagent`].
//! - Two flavours:
//!   - **Internal** — runs a fresh `harness_core::Agent` loop with a
//!     restricted system prompt + toolset + (optionally) cheaper
//!     model. Used by `read_doc` / `review` / `codex`.
//!   - **SDK sidecar** — spawns an external SDK process (Node/Python)
//!     and parses JSON Lines off its stdout into
//!     [`harness_core::SubAgentEvent`]. Used by `claude_code`.
//! - Streaming visibility: every subagent emits frames into the
//!   `harness_core::subagent` task-local channel; the main `Agent`
//!   loop relays them as `AgentEvent::SubAgentEvent`. UIs render
//!   both an inline collapsible card *and* a side-panel of running
//!   subagents from the same stream.
//!
//! v1.0 lands the trait + a test-only [`EchoSubAgent`]; concrete
//! built-ins (claude_code / codex / read_doc / review) are added in
//! follow-up steps so this crate's surface stays reviewable.

use async_trait::async_trait;
use harness_core::BoxError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

pub use harness_core::{
    emit_subagent, subagent_active, with_subagent, SubAgentEvent, SubAgentFrame,
};

/// What the main agent hands a subagent when it invokes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentInput {
    /// Free-form natural-language task. The subagent is responsible
    /// for interpreting it (its system prompt may constrain shape).
    pub task: String,
    /// Sandbox root the subagent may read / write within. Mirrors
    /// the main agent's `JARVIS_FS_ROOT`. Subagents should refuse
    /// paths outside this directory.
    pub workspace_root: PathBuf,
    /// Optional structured context — verification_plan, run id,
    /// previous failure commentary, etc. Schema is per-subagent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
    /// Recursion guard: every nested subagent invocation appends its
    /// `subagent_id`. v1.0 forbids depth ≥ 1 from registering further
    /// `subagent.*` tools, but the chain travels with frames so the
    /// UI can draw nesting later.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caller_chain: Vec<String>,
}

/// What a subagent returns when it finishes. The `message` is what
/// the main agent sees as the tool's textual output (matching the
/// `Done.final_message` frame); `artifacts` are optional structured
/// products specific to the subagent kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentOutput {
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Artifact>,
}

/// A typed product a subagent can attach to its output. Keeps the
/// caller from having to parse `message` text. v1.0 ships just the
/// shapes used by the planned built-ins; renderers should treat
/// unknown variants as "ignore" for forward-compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Artifact {
    /// Set of files the subagent modified, by relative path. Used by
    /// claude_code / codex so the main agent / UI can show a diff.
    FilesChanged { paths: Vec<String> },
    /// Reviewer verdict — `pass | fail` plus commentary + evidence.
    /// Mirrors the wire shape of the (future)
    /// `requirement.review_verdict` tool so the auto loop can parse
    /// it without re-walking the conversation.
    ReviewVerdict {
        pass: bool,
        commentary: String,
        #[serde(default)]
        evidence: Vec<String>,
    },
    /// Doc reader summary. `quotes` carry `path:line: text` triples
    /// the reader cited.
    DocSummary {
        summary: String,
        #[serde(default)]
        quotes: Vec<String>,
    },
}

/// A delegated agent the main `Agent` may invoke through a
/// `subagent.<name>` tool.
#[async_trait]
pub trait SubAgent: Send + Sync {
    /// Registry key. Becomes the `subagent.<name>` tool name.
    fn name(&self) -> &str;
    /// One-line description shown to the main agent in the tool spec.
    /// Should be specific enough that the model knows when to pick
    /// this subagent over another (e.g. "Reads files and summarises;
    /// uses a cheap model. Use for any pure-read-and-explain task.").
    fn description(&self) -> &str;
    /// JSON schema for the tool input. Most subagents accept just
    /// `{ task: string }`; richer subagents may add `{ context }`.
    fn input_schema(&self) -> serde_json::Value;
    /// Whether the wrapping `subagent.<name>` tool should
    /// be approval-gated. Subagents that can mutate the workspace
    /// (claude_code / codex) must return `true`; read-only subagents
    /// (read_doc / review) return `false`.
    fn requires_approval(&self) -> bool {
        false
    }
    /// Run the subagent. Implementations are expected to emit
    /// `Started` early, stream `Delta` / `ToolStart` / `ToolEnd` /
    /// `Status` frames as they work, and exactly one `Done` or
    /// `Error` at the end. The harness wraps the call in a
    /// `with_subagent(...)` scope so [`emit_subagent`] reaches the
    /// main loop.
    async fn invoke(&self, input: SubAgentInput) -> Result<SubAgentOutput, BoxError>;
}

/// Registry of available subagents. Held by the binary's composition
/// root; the `register_as_tools` helper folds each subagent into a
/// `harness_core::ToolRegistry` as a wrapper tool.
#[derive(Default)]
pub struct SubAgentRegistry {
    entries: Vec<Arc<dyn SubAgent>>,
}

impl SubAgentRegistry {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Add a subagent. Later inserts with the same `name()` win — the
    /// composition root is the single source of truth, so collisions
    /// are intentional overrides not silent bugs.
    pub fn register(&mut self, sub: Arc<dyn SubAgent>) {
        let name = sub.name().to_string();
        self.entries.retain(|s| s.name() != name);
        self.entries.push(sub);
    }

    /// All registered subagents, ordered by insertion.
    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn SubAgent>> {
        self.entries.iter()
    }

    /// Look up by name. Returns the most-recently registered entry
    /// because `register` retains last-write-wins semantics.
    pub fn get(&self, name: &str) -> Option<&Arc<dyn SubAgent>> {
        self.entries.iter().rev().find(|s| s.name() == name)
    }

    /// `true` iff at least one subagent is registered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Number of registered subagents.
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

pub mod claude_code;
pub mod codex;
pub mod doc_reader;
pub mod echo;
pub mod internal;
pub mod reviewer;
pub mod tool_adapter;

pub use internal::{InternalSubAgent, InternalSubAgentConfig};
pub use tool_adapter::SubAgentTool;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_dedupes_by_name() {
        let mut reg = SubAgentRegistry::new();
        reg.register(Arc::new(echo::EchoSubAgent::new("a")));
        reg.register(Arc::new(echo::EchoSubAgent::new("a")));
        reg.register(Arc::new(echo::EchoSubAgent::new("b")));
        assert_eq!(reg.len(), 2);
        assert!(reg.get("a").is_some());
        assert!(reg.get("b").is_some());
        assert!(reg.get("c").is_none());
    }
}
