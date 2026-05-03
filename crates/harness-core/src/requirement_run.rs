//! Typed value types and broadcast events for [`Requirement`](crate::Requirement)
//! execution runs.
//!
//! Sibling to [`crate::requirement`]: that module owns the kanban row
//! shape; this one owns the per-run records (status, summary,
//! verification result) plus the [`RequirementRunEvent`] broadcast
//! shape used by the WS bridge.
//!
//! All types are plain serde-serialisable structs / enums with no
//! runtime side-effects. The actual orchestration (mint a fresh
//! conversation, run the agent loop, execute verification commands)
//! lives in `harness-requirement` (manifest builder) and
//! `harness-server` handlers.
//!
//! These types historically lived in the `harness-requirement` crate.
//! They were lifted into `harness-core` so the
//! [`RequirementRunStore`](crate::RequirementRunStore) trait — which
//! belongs in `harness-core::store` next to the other store traits —
//! can name them without `harness-core` taking on a dependency on
//! `harness-requirement`. `harness-requirement` continues to re-export
//! these types so existing import paths keep working.

use serde::{Deserialize, Serialize};

// ---------- RequirementRun ------------------------------------------------

/// One execution attempt against a [`Requirement`](crate::Requirement).
///
/// A Requirement can have many runs (each conversation worked on
/// the requirement counts). The lightweight cross-link in
/// [`Requirement::conversation_ids`](crate::Requirement) gets
/// upgraded into typed records here whenever the system records
/// run-level metadata (start time, summary, error).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementRun {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// The Requirement this run targets.
    pub requirement_id: String,
    /// Conversation that drove the run. The conversation row in
    /// [`ConversationStore`](crate::ConversationStore) is
    /// authoritative for messages; this struct only holds run-level
    /// metadata.
    pub conversation_id: String,
    /// Lifecycle state.
    pub status: RequirementRunStatus,
    /// One-line summary of what was done. Optional until the
    /// run finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Free-form error string if the run failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Optional verification result attached to this run. Present
    /// when a [`VerificationPlan`] was executed; absent when the
    /// run skipped verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationResult>,
    /// Phase 5 — absolute path to the per-run git worktree, if
    /// one was minted at start. `None` means the run uses the
    /// main workspace checkout (worktree mode disabled, or the
    /// workspace isn't a git repo, or worktree creation was
    /// refused). Verification commands and future per-run
    /// shell ops should `cd` here when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// RFC-3339 / ISO-8601 timestamp of run creation.
    pub started_at: String,
    /// RFC-3339 timestamp of completion. `None` while in flight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl RequirementRun {
    /// Mint a new run with a fresh UUID, current timestamp, and
    /// status [`RequirementRunStatus::Pending`].
    pub fn new(requirement_id: impl Into<String>, conversation_id: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            requirement_id: requirement_id.into(),
            conversation_id: conversation_id.into(),
            status: RequirementRunStatus::Pending,
            summary: None,
            error: None,
            verification: None,
            worktree_path: None,
            started_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
        }
    }

    /// Mark the run finished (status + finished_at). Idempotent —
    /// repeated calls bump finished_at but don't change status if
    /// the caller already set a terminal one.
    pub fn finish(&mut self, status: RequirementRunStatus) {
        if !self.status.is_terminal() {
            self.status = status;
        }
        self.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }
}

/// Lifecycle of a [`RequirementRun`]. Serialised snake_case wire
/// strings (`"pending" / "running" / "completed" / "failed" /
/// "cancelled"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementRunStatus {
    /// Created but not yet started.
    Pending,
    /// Agent loop in flight.
    Running,
    /// Run finished cleanly.
    Completed,
    /// Run finished with an error.
    Failed,
    /// User stopped the run before it finished.
    Cancelled,
}

impl RequirementRunStatus {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// Terminal states cannot transition further (no zombie runs
    /// re-entering `Running`).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

// ---------- VerificationPlan / Result --------------------------------------

/// What success looks like for the run, expressed as commands the
/// host should execute and policy gates the user / harness should
/// honour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationPlan {
    /// Shell-style commands to run after the agent finishes. Each
    /// is run via the binary's existing `shell.exec` plumbing
    /// (sandbox-rooted, approval-gated).
    #[serde(default)]
    pub commands: Vec<String>,
    /// Require the run to produce a non-empty `git diff` before
    /// passing? Useful for code-change requirements.
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_diff: bool,
    /// Require the agent to declare which tests it ran (and that
    /// at least one was run)? Free-form text expectation; the
    /// harness only checks that *some* command in `commands` was
    /// recognisable as a test runner.
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_tests: bool,
    /// Hold for human review before flipping the parent
    /// Requirement to `done`?
    #[serde(default, skip_serializing_if = "is_false")]
    pub require_human_review: bool,
}

/// Outcome of executing a [`VerificationPlan`] against a
/// [`RequirementRun`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationResult {
    /// Aggregate outcome — derived from the per-command results
    /// plus the gate flags on the plan.
    pub status: VerificationStatus,
    /// One entry per command in the plan, in the same order.
    #[serde(default)]
    pub command_results: Vec<CommandResult>,
    /// `git diff --stat` output captured at run end, if the run
    /// asked for `require_diff`. `None` when the gate wasn't set
    /// or no diff was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_summary: Option<String>,
    /// Free-form notes (e.g. "test runner timed out at 30s").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Aggregate verification outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    /// All commands passed and gates satisfied.
    Passed,
    /// At least one command failed.
    Failed,
    /// Gates were satisfied but a human still needs to confirm
    /// (mapped to the parent Requirement's `review` column).
    NeedsReview,
    /// Verification was configured but couldn't be executed
    /// (e.g. shell.exec disabled).
    Skipped,
}

impl VerificationStatus {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::NeedsReview => "needs_review",
            Self::Skipped => "skipped",
        }
    }
}

/// One row of the per-command results table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    /// The command string (verbatim from the plan).
    pub command: String,
    /// Process exit code. `None` for commands that didn't reach
    /// a clean exit (timed out, kill on drop, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Truncated stdout (≤ 16 KiB).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stdout: String,
    /// Truncated stderr (≤ 16 KiB).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stderr: String,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
}

fn is_false(b: &bool) -> bool {
    !*b
}

// ---------- RequirementRunEvent --------------------------------------------

/// Per-run lifecycle event.
///
/// Sibling to [`AgentEvent`](crate::AgentEvent): those events describe
/// the agent loop's *internal* progress (tokens, tool calls, approvals).
/// `RequirementRunEvent` is a layer above — it describes the *run's*
/// state transitions (started, finished, verification result) so a
/// UI can render the kanban card animation without reconstructing it
/// from agent events.
///
/// The `harness-server` WS bridge fans these out alongside the
/// existing `requirement_upserted` frames so a connected client sees
/// both shapes (whole-row updates + per-run progress).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequirementRunEvent {
    /// Run started — the conversation has been minted, the manifest
    /// applied, and the agent loop is about to begin.
    Started(RequirementRun),
    /// Run finished — terminal status, possibly with a verification
    /// result attached. The full row is included so a client that
    /// missed `Started` can render the card from a single frame.
    Finished(RequirementRun),
    /// Standalone verification result, when verification was run
    /// after a (possibly external) completion event.
    Verified {
        run_id: String,
        result: VerificationResult,
    },
}

impl RequirementRunEvent {
    /// Run id the event targets — useful for filtering at the WS
    /// layer when a single client cares about a specific run.
    pub fn run_id(&self) -> &str {
        match self {
            Self::Started(r) | Self::Finished(r) => &r.id,
            Self::Verified { run_id, .. } => run_id,
        }
    }
}

// ---------- tests ----------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_round_trips() {
        for s in [
            RequirementRunStatus::Pending,
            RequirementRunStatus::Running,
            RequirementRunStatus::Completed,
            RequirementRunStatus::Failed,
            RequirementRunStatus::Cancelled,
        ] {
            assert_eq!(RequirementRunStatus::from_wire(s.as_wire()), Some(s));
        }
        assert!(RequirementRunStatus::from_wire("nonsense").is_none());
    }

    #[test]
    fn run_status_is_terminal_classifies_correctly() {
        assert!(!RequirementRunStatus::Pending.is_terminal());
        assert!(!RequirementRunStatus::Running.is_terminal());
        assert!(RequirementRunStatus::Completed.is_terminal());
        assert!(RequirementRunStatus::Failed.is_terminal());
        assert!(RequirementRunStatus::Cancelled.is_terminal());
    }

    #[test]
    fn run_new_mints_uuid_and_pending_status() {
        let r = RequirementRun::new("req-1", "conv-1");
        assert_eq!(r.id.len(), 36);
        assert_eq!(r.requirement_id, "req-1");
        assert_eq!(r.conversation_id, "conv-1");
        assert_eq!(r.status, RequirementRunStatus::Pending);
        assert!(r.finished_at.is_none());
    }

    #[test]
    fn finish_sets_terminal_status_and_timestamp() {
        let mut r = RequirementRun::new("req", "conv");
        r.finish(RequirementRunStatus::Completed);
        assert_eq!(r.status, RequirementRunStatus::Completed);
        assert!(r.finished_at.is_some());
    }

    #[test]
    fn finish_does_not_overwrite_existing_terminal_status() {
        // If someone first calls `finish(Failed)` and then
        // `finish(Completed)`, we keep `Failed` — terminal is
        // sticky so a late "actually we cancelled" doesn't
        // overwrite the real failure.
        let mut r = RequirementRun::new("req", "conv");
        r.finish(RequirementRunStatus::Failed);
        let saved = r.status;
        r.finish(RequirementRunStatus::Completed);
        assert_eq!(r.status, saved);
    }

    #[test]
    fn verification_plan_skips_default_flags() {
        let plan = VerificationPlan {
            commands: vec!["cargo test".into()],
            require_diff: false,
            require_tests: false,
            require_human_review: false,
        };
        let json = serde_json::to_string(&plan).unwrap();
        assert!(!json.contains("require_diff"));
        assert!(!json.contains("require_tests"));
        assert!(!json.contains("require_human_review"));
        assert!(json.contains("\"commands\""));
    }

    #[test]
    fn verification_status_wire_form() {
        assert_eq!(VerificationStatus::Passed.as_wire(), "passed");
        assert_eq!(VerificationStatus::NeedsReview.as_wire(), "needs_review");
    }

    #[test]
    fn round_trip_full_run_record() {
        let mut r = RequirementRun::new("req-7", "conv-7");
        r.summary = Some("changed serializer".into());
        r.status = RequirementRunStatus::Completed;
        r.verification = Some(VerificationResult {
            status: VerificationStatus::Passed,
            command_results: vec![CommandResult {
                command: "cargo test".into(),
                exit_code: Some(0),
                stdout: "ok".into(),
                stderr: String::new(),
                duration_ms: 1234,
            }],
            diff_summary: Some(" 1 file changed".into()),
            notes: None,
        });
        r.finished_at = Some("2026-04-30T01:23:45+00:00".into());

        let json = serde_json::to_string(&r).unwrap();
        let back: RequirementRun = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn started_event_round_trips_through_json() {
        let r = RequirementRun::new("req-1", "conv-1");
        let ev = RequirementRunEvent::Started(r.clone());
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"started\""));
        assert!(json.contains(&r.id));
    }

    #[test]
    fn finished_event_carries_terminal_status() {
        let mut r = RequirementRun::new("req-1", "conv-1");
        r.finish(RequirementRunStatus::Completed);
        let ev = RequirementRunEvent::Finished(r.clone());
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"status\":\"completed\""));
    }

    #[test]
    fn verified_event_round_trips() {
        let ev = RequirementRunEvent::Verified {
            run_id: "run-7".into(),
            result: VerificationResult {
                status: VerificationStatus::Passed,
                command_results: vec![],
                diff_summary: None,
                notes: None,
            },
        };
        let json = serde_json::to_string(&ev).unwrap();
        let back: RequirementRunEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.run_id(), "run-7");
    }
}
