//! Run-level broadcast events for transports (WS / SSE) to consume.
//!
//! Sibling to `harness_core::AgentEvent`: those events describe the
//! agent loop's *internal* progress (tokens, tool calls, approvals).
//! `RequirementRunEvent` is a layer above — it describes the *run's*
//! state transitions (started, finished, verification result) so a
//! UI can render the kanban card animation without reconstructing it
//! from agent events.
//!
//! The harness server's WS bridge fans these out alongside the
//! existing `requirement_upserted` frames so a connected client sees
//! both shapes (whole-row updates + per-run progress).

use serde::{Deserialize, Serialize};

use crate::model::{RequirementRun, VerificationResult};

/// Per-run lifecycle event.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RequirementRunStatus, VerificationStatus};

    #[test]
    fn started_round_trips_through_json() {
        let r = RequirementRun::new("req-1", "conv-1");
        let ev = RequirementRunEvent::Started(r.clone());
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"started\""));
        assert!(json.contains(&r.id));
    }

    #[test]
    fn finished_carries_terminal_status() {
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
