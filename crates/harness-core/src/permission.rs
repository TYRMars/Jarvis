//! Permission modes + rule engine.
//!
//! Maps onto Claude Code's modern permission surface. Five modes set
//! the *default* decision for each gated tool call; on top of that, a
//! three-tier rule table (deny > ask > allow) lets the user pin
//! specific tools or argument-patterns to a fixed decision. Rules
//! persist across sessions; the mode is per-socket.
//!
//! ## Mode semantics
//!
//! | Mode | Default decision |
//! |------|------------------|
//! | [`PermissionMode::Ask`] | every gated tool prompts via the fallback `Approver` (typically `ChannelApprover`) |
//! | [`PermissionMode::AcceptEdits`] | auto-allow `fs.edit` / `fs.patch` / `fs.write`; ask for everything else gated |
//! | [`PermissionMode::Plan`] | read-only — the LLM tool catalogue is filtered to `ToolCategory::Read` plus a synthetic `exit_plan` tool. Approver never sees write/exec/network tools. |
//! | [`PermissionMode::Auto`] | auto-allow everything gated |
//! | [`PermissionMode::Bypass`] | auto-allow everything; UI shows a persistent warning. Activation guarded by CLI flags in the binary. |
//!
//! Plan Mode is implemented by the binary via
//! [`crate::AgentConfig::tool_filter`] — the rule engine itself just
//! treats Plan Mode like Ask for whatever does call it, but the model
//! never sees write tools to call.
//!
//! ## Rule shape
//!
//! ```json
//! {
//!   "default_mode": "ask",
//!   "deny":  [ { "tool": "shell.exec", "matchers": { "/command": "rm -rf *" } } ],
//!   "ask":   [],
//!   "allow": [
//!     { "tool": "fs.edit" },
//!     { "tool": "shell.exec", "matchers": { "/command": "npm test" } }
//!   ]
//! }
//! ```
//!
//! Eval order: every rule in `deny` (first match wins) → every rule
//! in `ask` → every rule in `allow` → fall through to mode default.
//!
//! `matchers` keys are JSON Pointers (RFC 6901) into the tool's
//! arguments object. Empty-matchers means "match every invocation of
//! this tool". A rule with `tool: "*"` matches every tool name.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

use crate::approval::{ApprovalDecision, ApprovalRequest, Approver};
use crate::error::BoxError;
use crate::tool::ToolCategory;

/// What permission mode the session is currently in. Drives the
/// fall-through "no rule matched" decision plus the Plan Mode tool
/// filter that the binary installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    Ask,
    AcceptEdits,
    Plan,
    Auto,
    Bypass,
}

impl PermissionMode {
    /// Human-readable name for status badges / log lines.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AcceptEdits => "accept-edits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::Bypass => "bypass",
        }
    }

    /// Parse from a string (CLI flag, env var, settings file).
    /// Returns `None` for unknown values so callers can format their
    /// own error message with the list of accepted values.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ask" => Some(Self::Ask),
            "accept-edits" | "accept_edits" | "acceptEdits" => Some(Self::AcceptEdits),
            "plan" => Some(Self::Plan),
            "auto" => Some(Self::Auto),
            "bypass" | "bypass-permissions" | "bypassPermissions" => Some(Self::Bypass),
            _ => None,
        }
    }
}

/// Outcome of evaluating a tool call against the rule table + mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
    Ask,
}

/// One persisted rule. `tool` is either a literal tool name
/// (`"shell.exec"`) or `"*"` (every tool). `matchers` are JSON
/// pointers into the tool's argument object → glob pattern. Empty
/// matchers ≡ "match every invocation of this tool".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRule {
    pub tool: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub matchers: BTreeMap<String, String>,
}

impl PermissionRule {
    /// Convenience: rule that matches every call to `tool`, no
    /// argument constraints.
    pub fn whole_tool(tool: impl Into<String>) -> Self {
        Self {
            tool: tool.into(),
            matchers: BTreeMap::new(),
        }
    }

    /// Add or replace one matcher. Returns `self` for builder use.
    pub fn with_matcher(mut self, pointer: impl Into<String>, glob: impl Into<String>) -> Self {
        self.matchers.insert(pointer.into(), glob.into());
        self
    }

    /// Test whether this rule matches `(tool, args)`. Tool name must
    /// equal `self.tool` (or `self.tool == "*"`); each matcher's
    /// pointer must resolve to a string in `args` and that string
    /// must satisfy the glob.
    pub fn matches(&self, tool: &str, args: &Value) -> bool {
        if self.tool != "*" && self.tool != tool {
            return false;
        }
        for (pointer, pat) in &self.matchers {
            let target = match args.pointer(pointer).and_then(|v| v.as_str()) {
                Some(s) => s,
                None => return false,
            };
            if !glob_match(pat, target) {
                return false;
            }
        }
        true
    }
}

/// Where a stored rule came from / where the user wants a new rule
/// written. Higher entries override lower entries during evaluation:
/// `User > Project > Session`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// In-memory only, dies with the process.
    Session,
    /// `<workspace_root>/.jarvis/permissions.json`. Committed; team
    /// shares the rule set.
    Project,
    /// `~/.config/jarvis/permissions.json`. Personal across projects.
    User,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::User => "user",
        }
    }
}

/// Where the final decision came from. Surfaced in
/// [`crate::AgentEvent::ApprovalDecision`] so the UI / audit log can
/// show "auto-allowed by user-scope rule fs.edit" instead of silently
/// running the tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HitSource {
    /// A specific rule fired. `index` is the rule's position within
    /// the (deny|ask|allow) bucket, useful for citing it in audit
    /// without sending the whole rule body.
    Rule {
        scope: Scope,
        bucket: Decision,
        index: usize,
    },
    /// No rule matched; fell through to the mode default.
    ModeDefault { mode: PermissionMode },
    /// Decision came from the fallback `Approver` (interactive
    /// prompt). Source is the user, not a rule.
    UserPrompt,
}

/// Result of [`PermissionTable::evaluate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleHit {
    pub decision: Decision,
    pub source: HitSource,
}

/// Persisted permission state — modes + rule buckets. Backends in
/// `harness-store` flatten this to a single JSON file per scope and
/// merge user/project/session at load time before constructing the
/// in-memory table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PermissionTable {
    #[serde(default)]
    pub default_mode: PermissionMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<ScopedRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<ScopedRule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<ScopedRule>,
}

/// A rule with its origin scope attached. The merged in-memory table
/// uses these so `RuleHit` can cite which scope a rule came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopedRule {
    pub scope: Scope,
    #[serde(flatten)]
    pub rule: PermissionRule,
}

impl PermissionTable {
    /// Walk `deny → ask → allow → mode-default` against `(tool, args)`
    /// and return the first match. Mode default is computed from
    /// [`PermissionMode`] semantics for the given tool category /
    /// `requires_approval` flag — the caller passes those in via
    /// `mode_default_for_tool` so `harness-core` doesn't need to know
    /// per-tool tags here.
    pub fn evaluate(
        &self,
        tool: &str,
        args: &Value,
        mode_default: Decision,
        active_mode: PermissionMode,
    ) -> RuleHit {
        for (idx, sr) in self.deny.iter().enumerate() {
            if sr.rule.matches(tool, args) {
                return RuleHit {
                    decision: Decision::Deny,
                    source: HitSource::Rule {
                        scope: sr.scope,
                        bucket: Decision::Deny,
                        index: idx,
                    },
                };
            }
        }
        for (idx, sr) in self.ask.iter().enumerate() {
            if sr.rule.matches(tool, args) {
                return RuleHit {
                    decision: Decision::Ask,
                    source: HitSource::Rule {
                        scope: sr.scope,
                        bucket: Decision::Ask,
                        index: idx,
                    },
                };
            }
        }
        for (idx, sr) in self.allow.iter().enumerate() {
            if sr.rule.matches(tool, args) {
                return RuleHit {
                    decision: Decision::Allow,
                    source: HitSource::Rule {
                        scope: sr.scope,
                        bucket: Decision::Allow,
                        index: idx,
                    },
                };
            }
        }
        RuleHit {
            decision: mode_default,
            source: HitSource::ModeDefault { mode: active_mode },
        }
    }
}

// ----------------------------------------------------------------------
// Glob matching
// ----------------------------------------------------------------------

/// Token-aware glob match. Splits both pattern and target on
/// whitespace; matches token-by-token; `*` inside a token matches any
/// sequence of non-whitespace characters.
///
/// **Why not just `fnmatch`?** Because shell-string greedy matching
/// is a known footgun: an `allow shell.exec(npm test*)` rule
/// shouldn't match `npm test; rm -rf ~`. Tokenising forces the user
/// to think about token boundaries, which is what they actually want
/// for command lines.
///
/// For path patterns the caller should canonicalise both sides first
/// (relative-to-workspace-root), then call this with whitespace-free
/// strings — the per-token rule degenerates to a per-string rule.
/// `**` is a convenience alias for `*` in path mode.
pub fn glob_match(pattern: &str, target: &str) -> bool {
    let pat_tokens: Vec<&str> = pattern.split_whitespace().collect();
    let tgt_tokens: Vec<&str> = target.split_whitespace().collect();
    if pat_tokens.len() != tgt_tokens.len() {
        // Allow trailing `*` token to absorb the rest, e.g. `git diff *`
        // matches `git diff src/foo`. The trailing-`*` rule applies
        // when the pattern's last token is exactly `*` and the target
        // has at least as many tokens as the pattern minus one.
        if let Some(&"*") = pat_tokens.last() {
            if tgt_tokens.len() >= pat_tokens.len() - 1 {
                for (p, t) in pat_tokens.iter().zip(tgt_tokens.iter()) {
                    if !token_match(p, t) {
                        return false;
                    }
                }
                return true;
            }
        }
        return false;
    }
    pat_tokens
        .iter()
        .zip(tgt_tokens.iter())
        .all(|(p, t)| token_match(p, t))
}

fn token_match(pattern: &str, target: &str) -> bool {
    // `*` and `**` in a single-token context just mean "match anything
    // here" — equivalent for our purposes.
    if pattern == "*" || pattern == "**" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == target;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut cursor = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !target[cursor..].starts_with(part) {
                return false;
            }
            cursor += part.len();
        } else if i == parts.len() - 1 {
            return target[cursor..].ends_with(part);
        } else if let Some(pos) = target[cursor..].find(part) {
            cursor += pos + part.len();
        } else {
            return false;
        }
    }
    // Pattern ended in `*` → the rest of target is fine.
    parts.last().map(|p| p.is_empty()).unwrap_or(true)
}

// ----------------------------------------------------------------------
// Mode → default-decision mapping
// ----------------------------------------------------------------------

/// Compute the fall-through decision for a tool when no rule matched.
/// Drives mode-default behaviour:
///
/// - **Ask** → always prompt
/// - **AcceptEdits** → auto-allow `Write` tools, prompt for everything else
/// - **Plan** → would prompt, but Plan Mode hides write/exec/network
///   tools from the LLM via `tool_filter` so the approver rarely sees them
/// - **Auto** → auto-allow everything
/// - **Bypass** → auto-allow everything (the binary still gates entry into
///   this mode behind `--dangerously-skip-permissions`)
pub fn mode_default(mode: PermissionMode, category: ToolCategory) -> Decision {
    match mode {
        PermissionMode::Ask => Decision::Ask,
        PermissionMode::AcceptEdits => match category {
            ToolCategory::Write => Decision::Allow,
            _ => Decision::Ask,
        },
        PermissionMode::Plan => Decision::Ask,
        PermissionMode::Auto | PermissionMode::Bypass => Decision::Allow,
    }
}

// ----------------------------------------------------------------------
// RuleApprover
// ----------------------------------------------------------------------

/// `Approver` impl that consults a [`PermissionStore`] before falling
/// through to a wrapped approver (typically a `ChannelApprover` for
/// the WS UI or the CLI's TTY prompt).
///
/// Decision flow:
///
/// 1. Snapshot the table from the store.
/// 2. Compute `mode_default(active_mode, request.category)`.
/// 3. `table.evaluate(...)` → `RuleHit`.
/// 4. If hit is `Allow` → return Approve, source = the rule.
/// 5. If hit is `Deny` → return Deny, source = the rule.
/// 6. If hit is `Ask` → call the wrapped approver, source = `UserPrompt`.
///
/// The active mode is held behind an `Arc<RwLock<PermissionMode>>` so
/// the transport (WS handler) can flip it mid-session via
/// `set_mode`. Multiple sockets may share the same store but each
/// holds its own mode handle (per-socket mode, process-wide rules).
pub struct RuleApprover {
    store: Arc<dyn PermissionStore>,
    fallback: Arc<dyn Approver>,
    mode: Arc<RwLock<PermissionMode>>,
}

impl RuleApprover {
    pub fn new(
        store: Arc<dyn PermissionStore>,
        fallback: Arc<dyn Approver>,
        mode: Arc<RwLock<PermissionMode>>,
    ) -> Self {
        Self {
            store,
            fallback,
            mode,
        }
    }

    /// Read the currently-active mode. Cheap RwLock read.
    pub async fn current_mode(&self) -> PermissionMode {
        *self.mode.read().await
    }
}

#[async_trait]
impl Approver for RuleApprover {
    async fn approve(&self, request: ApprovalRequest) -> Result<ApprovalDecision, BoxError> {
        let (decision, _source) = self.approve_with_source(request).await?;
        Ok(decision)
    }

    async fn approve_with_source(
        &self,
        request: ApprovalRequest,
    ) -> Result<(ApprovalDecision, HitSource), BoxError> {
        let active_mode = *self.mode.read().await;
        let table = self.store.snapshot().await;
        let default = mode_default(active_mode, request.category);
        let hit = table.evaluate(&request.tool_name, &request.arguments, default, active_mode);
        match hit.decision {
            Decision::Allow => Ok((ApprovalDecision::Approve, hit.source)),
            Decision::Deny => Ok((
                ApprovalDecision::deny(format!(
                    "denied by {} rule",
                    match &hit.source {
                        HitSource::Rule { scope, .. } => scope.as_str(),
                        HitSource::ModeDefault { mode } => mode.as_str(),
                        HitSource::UserPrompt => "user",
                    }
                )),
                hit.source,
            )),
            Decision::Ask => {
                // Fall through to interactive prompt.
                let decision = self.fallback.approve(request).await?;
                Ok((decision, HitSource::UserPrompt))
            }
        }
    }
}

// ----------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------

/// Persistence layer for permission rules. Concrete impls live in
/// `harness-store`.
///
/// **Concurrency model**: implementations must be safe to call from
/// many tasks concurrently. The expected backing is one JSON file
/// per scope (`~/.config/jarvis/permissions.json` for `User`,
/// `<workspace>/.jarvis/permissions.json` for `Project`, in-memory
/// for `Session`); writers serialise on a single mutex / actor so
/// two simultaneous "Always allow" clicks can't lose each other's
/// rules.
///
/// Readers should call [`PermissionStore::snapshot`] for a cheap
/// clone of the current merged table — the agent's hot path
/// (per-tool-call evaluation) hits this on every gated invocation,
/// so impls back it with an `Arc<RwLock<PermissionTable>>` cache
/// rather than re-reading disk each time.
#[async_trait]
pub trait PermissionStore: Send + Sync {
    /// Return the current merged table (user ∪ project ∪ session).
    /// Cheap — should not hit disk for typical impls.
    async fn snapshot(&self) -> PermissionTable;

    /// Append a rule into the named scope's bucket. Returns
    /// `Err(...)` only on IO / serialisation failure; duplicates are
    /// allowed (the rule engine just first-match-wins).
    async fn append_rule(
        &self,
        scope: Scope,
        bucket: Decision,
        rule: PermissionRule,
    ) -> Result<(), BoxError>;

    /// Remove the rule at `index` of the named (scope, bucket).
    /// Returns `Err` if the index is out of bounds. The user-facing
    /// transport (REST `/v1/permissions`) is responsible for fetching
    /// a fresh snapshot before computing the index.
    async fn delete_rule(
        &self,
        scope: Scope,
        bucket: Decision,
        index: usize,
    ) -> Result<(), BoxError>;

    /// Update the `default_mode` recorded in the named scope. The
    /// table's `default_mode` always reflects the highest-priority
    /// scope that has it set (User > Project > Session); see your
    /// store impl for the exact merge.
    async fn set_default_mode(
        &self,
        scope: Scope,
        mode: PermissionMode,
    ) -> Result<(), BoxError>;

    /// Broadcast channel that fires once whenever the table changes
    /// (mutation through this store, or external file edit detected
    /// by an optional watcher). Live WebSocket sessions subscribe to
    /// trigger UI refresh.
    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mode_round_trips_through_strings() {
        for m in [
            PermissionMode::Ask,
            PermissionMode::AcceptEdits,
            PermissionMode::Plan,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            assert_eq!(PermissionMode::parse(m.as_str()), Some(m));
        }
        // Aliases
        assert_eq!(
            PermissionMode::parse("acceptEdits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            PermissionMode::parse("accept_edits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            PermissionMode::parse("bypassPermissions"),
            Some(PermissionMode::Bypass)
        );
        assert!(PermissionMode::parse("nonsense").is_none());
    }

    #[test]
    fn whole_tool_rule_matches_any_args() {
        let r = PermissionRule::whole_tool("fs.edit");
        assert!(r.matches("fs.edit", &json!({"path": "anything"})));
        assert!(r.matches("fs.edit", &json!({})));
        assert!(!r.matches("fs.write", &json!({})));
    }

    #[test]
    fn star_tool_matches_any_name() {
        let r = PermissionRule::whole_tool("*");
        assert!(r.matches("fs.edit", &json!({})));
        assert!(r.matches("anything.at.all", &json!({})));
    }

    #[test]
    fn matcher_pointer_resolves_into_args() {
        let r = PermissionRule::whole_tool("shell.exec")
            .with_matcher("/command", "npm test");
        assert!(r.matches("shell.exec", &json!({"command": "npm test"})));
        assert!(!r.matches("shell.exec", &json!({"command": "rm -rf /"})));
        assert!(!r.matches("shell.exec", &json!({"cmd": "npm test"})));
    }

    #[test]
    fn token_aware_glob_doesnt_eat_chained_commands() {
        // The Claude Code footgun we explicitly avoid.
        assert!(glob_match("npm test", "npm test"));
        assert!(!glob_match("npm test", "npm test; rm -rf ~"));
        // But `*` as a trailing token does absorb the rest.
        assert!(glob_match("npm test *", "npm test src/"));
        assert!(glob_match("npm test *", "npm test"));
    }

    #[test]
    fn token_internal_star_matches_within_token() {
        assert!(glob_match("v*", "v1.2.3"));
        assert!(glob_match("git-*", "git-status"));
        assert!(!glob_match("git-*", "git status")); // token boundary
    }

    #[test]
    fn evaluate_orders_deny_over_ask_over_allow() {
        let table = PermissionTable {
            default_mode: PermissionMode::Ask,
            deny: vec![ScopedRule {
                scope: Scope::User,
                rule: PermissionRule::whole_tool("shell.exec")
                    .with_matcher("/command", "rm *"),
            }],
            ask: vec![],
            allow: vec![ScopedRule {
                scope: Scope::User,
                rule: PermissionRule::whole_tool("shell.exec"),
            }],
        };
        // Even though `allow` has a whole-tool match, deny wins.
        let hit = table.evaluate(
            "shell.exec",
            &json!({"command": "rm -rf foo"}),
            Decision::Allow,
            PermissionMode::Auto,
        );
        assert_eq!(hit.decision, Decision::Deny);
        assert!(matches!(hit.source, HitSource::Rule { bucket: Decision::Deny, .. }));

        // Same command without matching deny → allow rule wins.
        let hit = table.evaluate(
            "shell.exec",
            &json!({"command": "ls"}),
            Decision::Ask,
            PermissionMode::Ask,
        );
        assert_eq!(hit.decision, Decision::Allow);
    }

    #[test]
    fn evaluate_falls_through_to_mode_default() {
        let table = PermissionTable::default();
        let hit = table.evaluate("fs.edit", &json!({}), Decision::Ask, PermissionMode::Ask);
        assert_eq!(hit.decision, Decision::Ask);
        assert!(matches!(hit.source, HitSource::ModeDefault { mode: PermissionMode::Ask }));
    }

    #[test]
    fn rule_serialises_with_skip_empty_matchers() {
        let r = PermissionRule::whole_tool("fs.edit");
        let s = serde_json::to_string(&r).unwrap();
        assert!(!s.contains("matchers"), "got: {s}");

        let r = PermissionRule::whole_tool("shell.exec").with_matcher("/command", "ls");
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("matchers"), "got: {s}");
    }

    #[test]
    fn table_round_trips_through_json() {
        let mut table = PermissionTable {
            default_mode: PermissionMode::AcceptEdits,
            ..Default::default()
        };
        table.allow.push(ScopedRule {
            scope: Scope::Project,
            rule: PermissionRule::whole_tool("git.diff"),
        });
        let s = serde_json::to_string(&table).unwrap();
        let back: PermissionTable = serde_json::from_str(&s).unwrap();
        assert_eq!(back.default_mode, PermissionMode::AcceptEdits);
        assert_eq!(back.allow.len(), 1);
        assert_eq!(back.allow[0].scope, Scope::Project);
        assert_eq!(back.allow[0].rule.tool, "git.diff");
    }
}
