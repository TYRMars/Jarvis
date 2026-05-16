//! Layered system-prompt assembly.
//!
//! Historically the composition root (`apps/jarvis::serve`) pushed
//! strings into a single `String` to build the agent's system
//! prompt: pick a base prompt, append project context, append
//! project memory, append skill fences. That worked for the one
//! call site but didn't compose: later subsystems (sub-agents,
//! per-conversation overrides, M3.1 Project Memory writes) need to
//! slot their own contributions in at predictable positions
//! without re-implementing the string-pushing protocol.
//!
//! [`SystemPromptBuilder`] is the typed equivalent. Five ordered
//! slots, each optional, joined by a stable delimiter. Empty slots
//! contribute nothing, so callers that don't use a slot get the
//! same bytes a hand-written push would have produced.
//!
//! Slot order (final prompt is the non-empty slots in this order,
//! delimited by `\n\n`):
//!
//! 1. **base** — the agent's role/identity (general vs. coding
//!    persona). Picked by the composition root from policy.
//! 2. **role** — situational role override. Today unused at the
//!    process level; sub-agent dispatch will set this per call
//!    when wired up.
//! 3. **per_agent_override** — caller-supplied override from a
//!    persistent agent profile / WS frame. Lets a power user
//!    swap in a custom prompt without losing the project context
//!    that lives in `runtime_inject`.
//! 4. **config_append** — operator's `[agent].system_prompt_append`
//!    config value. Appended verbatim; the operator controls the
//!    full text.
//! 5. **runtime_inject** — context the runtime knows but the
//!    operator didn't author: AGENTS.md / CLAUDE.md, project
//!    memory index, active skill fences, etc. Last so the model
//!    sees it freshly each turn.
//!
//! The builder is **immutable per call**: there's no in-place
//! mutator. Callers chain `.with_*(...)` setters and call
//! `.build()` once. The Drop-debug pretty-print enumerates each
//! slot's byte count so a future `--dump-system-prompt` style flag
//! can show the build trace without re-running.

use std::fmt;

/// Stable separator between slots. Matches the original ad-hoc
/// `push_str("\n\n")` pattern so existing prompt-cache fingerprints
/// don't rotate when the assembly moves through this builder.
const SLOT_SEPARATOR: &str = "\n\n";

/// Logical slot identifier. The `usize` repr is the build order
/// (lowest first).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemPromptSlot {
    Base = 0,
    Role = 1,
    PerAgentOverride = 2,
    ConfigAppend = 3,
    RuntimeInject = 4,
}

/// Layered system-prompt assembly. Cheap to clone (vec of small
/// strings) so a composition root can lay down a baseline and let
/// per-request handlers fork it.
#[derive(Debug, Clone, Default)]
pub struct SystemPromptBuilder {
    base: Option<String>,
    role: Option<String>,
    per_agent_override: Option<String>,
    config_append: Option<String>,
    runtime_inject: Option<String>,
}

impl SystemPromptBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace a slot. `None` clears it. Whitespace-only strings are
    /// treated as empty so callers don't have to filter their own
    /// inputs.
    pub fn set(mut self, slot: SystemPromptSlot, value: Option<String>) -> Self {
        let cleaned = value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        match slot {
            SystemPromptSlot::Base => self.base = cleaned,
            SystemPromptSlot::Role => self.role = cleaned,
            SystemPromptSlot::PerAgentOverride => self.per_agent_override = cleaned,
            SystemPromptSlot::ConfigAppend => self.config_append = cleaned,
            SystemPromptSlot::RuntimeInject => self.runtime_inject = cleaned,
        }
        self
    }

    pub fn with_base(self, value: impl Into<String>) -> Self {
        self.set(SystemPromptSlot::Base, Some(value.into()))
    }
    pub fn with_role(self, value: impl Into<String>) -> Self {
        self.set(SystemPromptSlot::Role, Some(value.into()))
    }
    pub fn with_per_agent_override(self, value: impl Into<String>) -> Self {
        self.set(SystemPromptSlot::PerAgentOverride, Some(value.into()))
    }
    pub fn with_config_append(self, value: impl Into<String>) -> Self {
        self.set(SystemPromptSlot::ConfigAppend, Some(value.into()))
    }
    pub fn with_runtime_inject(self, value: impl Into<String>) -> Self {
        self.set(SystemPromptSlot::RuntimeInject, Some(value.into()))
    }

    /// Append text into the `runtime_inject` slot. Multiple calls
    /// across the same builder collect each fragment separated by
    /// `\n\n` so the M3.1 Project Memory injector and the existing
    /// skill-fence injector can both contribute without overwriting
    /// each other.
    pub fn append_runtime_inject(mut self, value: impl Into<String>) -> Self {
        let v = value.into();
        let trimmed = v.trim();
        if trimmed.is_empty() {
            return self;
        }
        self.runtime_inject = Some(match self.runtime_inject.take() {
            Some(existing) => format!("{existing}{SLOT_SEPARATOR}{trimmed}"),
            None => trimmed.to_string(),
        });
        self
    }

    /// Whether a slot has a non-empty value.
    pub fn has(&self, slot: SystemPromptSlot) -> bool {
        match slot {
            SystemPromptSlot::Base => self.base.is_some(),
            SystemPromptSlot::Role => self.role.is_some(),
            SystemPromptSlot::PerAgentOverride => self.per_agent_override.is_some(),
            SystemPromptSlot::ConfigAppend => self.config_append.is_some(),
            SystemPromptSlot::RuntimeInject => self.runtime_inject.is_some(),
        }
    }

    /// Materialise the final prompt string. Non-empty slots are
    /// joined by [`SLOT_SEPARATOR`] in slot order; an empty builder
    /// returns the empty string.
    pub fn build(&self) -> String {
        let slots = [
            self.base.as_deref(),
            self.role.as_deref(),
            self.per_agent_override.as_deref(),
            self.config_append.as_deref(),
            self.runtime_inject.as_deref(),
        ];
        let mut out = String::new();
        let mut first = true;
        for slot in slots.iter().flatten() {
            if !first {
                out.push_str(SLOT_SEPARATOR);
            }
            out.push_str(slot);
            first = false;
        }
        out
    }

    /// Build trace: `[(name, bytes), ...]` for every populated slot.
    /// Lets observability surfaces log a one-line "system prompt
    /// assembled (base=NNN, runtime_inject=NNN)" without exposing
    /// the prompt text itself.
    pub fn trace(&self) -> Vec<(&'static str, usize)> {
        let entries: [(&'static str, Option<&String>); 5] = [
            ("base", self.base.as_ref()),
            ("role", self.role.as_ref()),
            ("per_agent_override", self.per_agent_override.as_ref()),
            ("config_append", self.config_append.as_ref()),
            ("runtime_inject", self.runtime_inject.as_ref()),
        ];
        entries
            .into_iter()
            .filter_map(|(n, s)| s.map(|v| (n, v.len())))
            .collect()
    }
}

impl fmt::Display for SystemPromptBuilder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.build())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_builder_returns_empty_string() {
        assert_eq!(SystemPromptBuilder::new().build(), "");
    }

    #[test]
    fn single_slot_is_verbatim() {
        let s = SystemPromptBuilder::new().with_base("hello").build();
        assert_eq!(s, "hello");
    }

    #[test]
    fn multiple_slots_joined_in_order_with_double_newline() {
        let s = SystemPromptBuilder::new()
            .with_base("BASE")
            .with_runtime_inject("RUNTIME")
            .with_config_append("CFG")
            .build();
        // Order is base → config_append → runtime_inject regardless
        // of caller call order.
        assert_eq!(s, "BASE\n\nCFG\n\nRUNTIME");
    }

    #[test]
    fn whitespace_only_slot_is_treated_as_empty() {
        let s = SystemPromptBuilder::new()
            .with_base("BASE")
            .with_runtime_inject("   ")
            .build();
        assert_eq!(s, "BASE");
        assert!(!SystemPromptBuilder::new()
            .with_runtime_inject("   ")
            .has(SystemPromptSlot::RuntimeInject));
    }

    #[test]
    fn append_runtime_inject_concatenates() {
        let s = SystemPromptBuilder::new()
            .with_base("BASE")
            .append_runtime_inject("=== project context ===\nfoo")
            .append_runtime_inject("=== skill ===\nbar")
            .build();
        assert_eq!(
            s,
            "BASE\n\n=== project context ===\nfoo\n\n=== skill ===\nbar"
        );
    }

    #[test]
    fn trace_lists_only_populated_slots_in_build_order() {
        let b = SystemPromptBuilder::new()
            .with_base("hi")
            .with_runtime_inject("ctx");
        let trace = b.trace();
        assert_eq!(trace.len(), 2);
        assert_eq!(trace[0].0, "base");
        assert_eq!(trace[1].0, "runtime_inject");
    }

    #[test]
    fn clearing_slot_via_set_none() {
        let b = SystemPromptBuilder::new()
            .with_base("BASE")
            .set(SystemPromptSlot::Base, None);
        assert!(!b.has(SystemPromptSlot::Base));
        assert_eq!(b.build(), "");
    }
}
