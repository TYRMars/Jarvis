//! Session approval policy table.
//!
//! "Always allow `fs.edit` for this session" is a far better default
//! than "ask every single time" — that's the lesson from
//! Claude-Code-style coding agents. The user types `a` once and
//! every subsequent `fs.edit` in this REPL session goes through
//! without a prompt.
//!
//! Scope: per-process, in-memory. Resetting the conversation
//! (`/reset`, future) keeps the policy; quitting drops it.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// Auto-approve every call to this tool for the rest of the
    /// session.
    AlwaysAllow,
    /// Auto-deny every call to this tool for the rest of the
    /// session. The model still sees the deny and can adapt
    /// (apologise, pick a different tool).
    AlwaysDeny,
}

#[derive(Debug, Default)]
pub struct PolicyTable {
    inner: HashMap<String, Policy>,
}

impl PolicyTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lookup(&self, tool_name: &str) -> Option<Policy> {
        self.inner.get(tool_name).copied()
    }

    pub fn set(&mut self, tool_name: impl Into<String>, policy: Policy) {
        self.inner.insert(tool_name.into(), policy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_returns_set_policy() {
        let mut p = PolicyTable::new();
        p.set("fs.edit", Policy::AlwaysAllow);
        assert_eq!(p.lookup("fs.edit"), Some(Policy::AlwaysAllow));
        assert_eq!(p.lookup("fs.write"), None);
    }
}
