//! In-process ledger of recent SubAgent invocations.
//!
//! Companion to [`crate::chat_runs::ChatRunRegistry`] but scoped to
//! children spawned by the main agent's `subagent.batch` (or any
//! single `subagent.<name>` call). Surfaces a parallel-runs rail in
//! the WorkOverview UI without forcing the operator to scrape WS
//! frames from an active session.
//!
//! Population is observational: at every `AgentEvent::SubAgentEvent`
//! relay (the WS handler / SSE handler / WorkOverview observer) the
//! registry's [`record_frame`] is called with the frame plus an
//! optional parent run id (the conversation that owns the run).
//! The registry keys on `subagent_id` (a per-invocation uuid), maps
//! lifecycle frames to status transitions, and trims to a bounded
//! ring of recent runs so the registry doesn't grow unbounded over
//! a long server lifetime.
//!
//! Cancellation is **cooperative**: a cancel mark on a run flips
//! the status to `Cancelled` and the registry signals the matching
//! [`tokio_util::sync::CancellationToken`] (when registered).
//! SubAgent implementations participate by checking the token
//! between iterations / SDK round trips. Pure LLM-loop subagents
//! that don't observe the token finish naturally — the cancel mark
//! is the audit signal.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use harness_core::{SubAgentEvent, SubAgentFrame};
use serde::Serialize;

/// Cap on the number of run records kept in memory. Old runs are
/// evicted FIFO on insertion past the cap. 200 is generous for a
/// single operator's session and bounded enough that even a
/// runaway batch can't OOM the ledger.
const MAX_RUNS: usize = 200;

/// One run's lifecycle status. Wire shape uses snake_case so the
/// JSON the UI consumes mirrors the Rust enum names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubAgentRunStatus {
    /// Frames received but no terminal `Done` / `Error` yet.
    Running,
    /// Subagent emitted `SubAgentEvent::Done`.
    Completed,
    /// Subagent emitted `SubAgentEvent::Error`.
    Failed,
    /// Operator cancelled the run via the REST endpoint.
    Cancelled,
}

/// Snapshot of one SubAgent run. Returned by `GET /v1/subagents/runs`
/// (list) and `GET /v1/subagents/runs/:id` (detail). `events` is only
/// populated on the detail endpoint to keep the list response small.
#[derive(Debug, Clone, Serialize)]
pub struct SubAgentRunRecord {
    /// Per-invocation uuid from the producing
    /// [`SubAgentFrame::subagent_id`].
    pub id: String,
    /// Registry name (e.g. `claude_code`, `review`).
    pub name: String,
    /// Free-form task string from the first `Started` frame, when
    /// available. `None` if the registry only saw later frames.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    /// Model the subagent reported on its `Started` frame, when
    /// known. SDK-sidecar subagents (claude_code) often leave this
    /// blank.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Conversation id that owns this run (the WS / SSE handler
    /// passes it through `record_frame`). Empty when the run came
    /// from a non-conversation invocation (e.g. CLI batch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub status: SubAgentRunStatus,
    pub started_at: u64,
    pub updated_at: u64,
    /// Wall-clock duration in milliseconds when terminal, else the
    /// elapsed since `started_at`. Computed at read time so a
    /// running row's value reflects the moment the snapshot is
    /// taken.
    pub duration_ms: u64,
    /// Count of `ToolStart` events seen for this run. Used by the
    /// UI's "[3 tool calls]" badge.
    pub tool_call_count: u32,
    /// Last error message when `status == Failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Final assistant message when `status == Completed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_message: Option<String>,
}

/// Stored alongside the record so the cancel endpoint has something
/// to signal. Optional because pure LLM-loop subagents (no SDK
/// sidecar) don't take a token today.
#[derive(Default)]
struct RunInternals {
    record: SubAgentRunRecord,
    /// Detail-endpoint events. Capped at 1k entries per run to
    /// match `chat_runs::MAX_EVENTS_PER_RUN` semantics.
    events: Vec<SubAgentEventRecord>,
    cancel: Option<tokio_util::sync::CancellationToken>,
}

const MAX_EVENTS_PER_RUN: usize = 1_000;

#[derive(Debug, Clone, Serialize)]
pub struct SubAgentEventRecord {
    pub timestamp: u64,
    pub frame: SubAgentFrame,
}

/// In-memory ledger. Cheap to clone the `Arc` — reads are the hot
/// path.
#[derive(Default)]
pub struct SubAgentRunRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    runs: HashMap<String, RunInternals>,
    /// Insertion order so we can evict FIFO.
    order: Vec<String>,
}

impl SubAgentRunRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Observe one frame. Idempotent for non-terminal frames; the
    /// terminal `Done` / `Error` frame freezes status.
    pub fn record_frame(&self, conversation_id: Option<&str>, frame: &SubAgentFrame) {
        let now = now_ms();
        let mut g = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let id = frame.subagent_id.clone();
        let entry = g.runs.entry(id.clone()).or_insert_with(|| {
            RunInternals {
                record: SubAgentRunRecord {
                    id: id.clone(),
                    name: frame.subagent_name.clone(),
                    task: None,
                    model: None,
                    conversation_id: conversation_id.map(str::to_string),
                    status: SubAgentRunStatus::Running,
                    started_at: now,
                    updated_at: now,
                    duration_ms: 0,
                    tool_call_count: 0,
                    error: None,
                    final_message: None,
                },
                events: Vec::new(),
                cancel: None,
            }
        });
        let is_new = entry.record.updated_at == entry.record.started_at
            && entry.record.tool_call_count == 0
            && matches!(entry.record.status, SubAgentRunStatus::Running)
            && entry.events.is_empty();
        entry.record.updated_at = now;
        match &frame.event {
            SubAgentEvent::Started { task, model } => {
                if entry.record.task.is_none() {
                    entry.record.task = Some(task.clone());
                }
                if entry.record.model.is_none() {
                    entry.record.model = model.clone();
                }
            }
            SubAgentEvent::ToolStart { .. } => {
                entry.record.tool_call_count =
                    entry.record.tool_call_count.saturating_add(1);
            }
            SubAgentEvent::Done { final_message } => {
                // Don't overwrite a prior cancel mark — a manual
                // cancel is the operator's truth and arrives before
                // the subagent's natural Done in the typical case.
                if !matches!(entry.record.status, SubAgentRunStatus::Cancelled) {
                    entry.record.status = SubAgentRunStatus::Completed;
                }
                entry.record.final_message = Some(final_message.clone());
                entry.record.duration_ms = now.saturating_sub(entry.record.started_at);
            }
            SubAgentEvent::Error { message } => {
                if !matches!(entry.record.status, SubAgentRunStatus::Cancelled) {
                    entry.record.status = SubAgentRunStatus::Failed;
                }
                entry.record.error = Some(message.clone());
                entry.record.duration_ms = now.saturating_sub(entry.record.started_at);
            }
            _ => {}
        }
        if entry.events.len() < MAX_EVENTS_PER_RUN {
            entry.events.push(SubAgentEventRecord {
                timestamp: now,
                frame: frame.clone(),
            });
        }
        if is_new {
            g.order.push(id);
            // Evict FIFO when over the cap.
            while g.order.len() > MAX_RUNS {
                let oldest = g.order.remove(0);
                g.runs.remove(&oldest);
            }
        }
    }

    /// Register a cancellation token for `id`. Subsequent
    /// [`cancel`] calls signal it. Idempotent — replaces any
    /// previously-registered token (the new one wins).
    pub fn attach_cancel(
        &self,
        id: &str,
        token: tokio_util::sync::CancellationToken,
    ) {
        let mut g = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(entry) = g.runs.get_mut(id) {
            entry.cancel = Some(token);
        }
    }

    /// Mark the run as cancelled and signal its token (when one is
    /// attached). Returns `true` when the run existed and was not
    /// already terminal; `false` for "no such run" or "already
    /// completed/failed".
    pub fn cancel(&self, id: &str) -> bool {
        let mut g = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let Some(entry) = g.runs.get_mut(id) else {
            return false;
        };
        if !matches!(entry.record.status, SubAgentRunStatus::Running) {
            return false;
        }
        entry.record.status = SubAgentRunStatus::Cancelled;
        entry.record.updated_at = now_ms();
        entry.record.duration_ms = entry.record.updated_at.saturating_sub(entry.record.started_at);
        if let Some(token) = entry.cancel.as_ref() {
            token.cancel();
        }
        true
    }

    /// Snapshot every known run, newest-first by `started_at`.
    pub fn list(&self) -> Vec<SubAgentRunRecord> {
        let g = match self.inner.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let now = now_ms();
        let mut out: Vec<SubAgentRunRecord> = g
            .runs
            .values()
            .map(|e| {
                let mut r = e.record.clone();
                if matches!(r.status, SubAgentRunStatus::Running) {
                    r.duration_ms = now.saturating_sub(r.started_at);
                }
                r
            })
            .collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.started_at));
        out
    }

    pub fn get(&self, id: &str) -> Option<SubAgentRunRecord> {
        let g = match self.inner.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.runs.get(id).map(|e| {
            let mut r = e.record.clone();
            if matches!(r.status, SubAgentRunStatus::Running) {
                r.duration_ms = now_ms().saturating_sub(r.started_at);
            }
            r
        })
    }

    pub fn events(&self, id: &str) -> Option<Vec<SubAgentEventRecord>> {
        let g = match self.inner.read() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.runs.get(id).map(|e| e.events.clone())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Default for SubAgentRunRecord {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            task: None,
            model: None,
            conversation_id: None,
            status: SubAgentRunStatus::Running,
            started_at: 0,
            updated_at: 0,
            duration_ms: 0,
            tool_call_count: 0,
            error: None,
            final_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::SubAgentEvent;

    fn frame(id: &str, name: &str, ev: SubAgentEvent) -> SubAgentFrame {
        SubAgentFrame {
            subagent_id: id.into(),
            subagent_name: name.into(),
            event: ev,
        }
    }

    #[test]
    fn started_then_done_transitions_to_completed() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            Some("conv-1"),
            &frame(
                "s1",
                "review",
                SubAgentEvent::Started {
                    task: "verify".into(),
                    model: Some("claude-3-5".into()),
                },
            ),
        );
        r.record_frame(
            Some("conv-1"),
            &frame(
                "s1",
                "review",
                SubAgentEvent::Done {
                    final_message: "pass".into(),
                },
            ),
        );
        let list = r.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "review");
        assert_eq!(list[0].task.as_deref(), Some("verify"));
        assert_eq!(list[0].model.as_deref(), Some("claude-3-5"));
        assert_eq!(list[0].status, SubAgentRunStatus::Completed);
        assert_eq!(list[0].final_message.as_deref(), Some("pass"));
        assert_eq!(list[0].conversation_id.as_deref(), Some("conv-1"));
    }

    #[test]
    fn error_terminal_marks_failed_and_sets_error() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "s2",
                "doc_reader",
                SubAgentEvent::Error {
                    message: "boom".into(),
                },
            ),
        );
        let rec = r.get("s2").unwrap();
        assert_eq!(rec.status, SubAgentRunStatus::Failed);
        assert_eq!(rec.error.as_deref(), Some("boom"));
    }

    #[test]
    fn tool_start_increments_count() {
        let r = SubAgentRunRegistry::default();
        for _ in 0..3 {
            r.record_frame(
                None,
                &frame(
                    "s3",
                    "codex",
                    SubAgentEvent::ToolStart {
                        name: "fs.read".into(),
                        arguments: serde_json::json!({}),
                    },
                ),
            );
        }
        assert_eq!(r.get("s3").unwrap().tool_call_count, 3);
    }

    #[test]
    fn cancel_running_run_marks_cancelled_and_signals_token() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "s4",
                "codex",
                SubAgentEvent::Started {
                    task: "x".into(),
                    model: None,
                },
            ),
        );
        let token = tokio_util::sync::CancellationToken::new();
        r.attach_cancel("s4", token.clone());
        assert!(!token.is_cancelled());
        let ok = r.cancel("s4");
        assert!(ok);
        assert!(token.is_cancelled());
        assert_eq!(r.get("s4").unwrap().status, SubAgentRunStatus::Cancelled);
    }

    #[test]
    fn cancel_unknown_run_returns_false() {
        let r = SubAgentRunRegistry::default();
        assert!(!r.cancel("nope"));
    }

    #[test]
    fn cancel_already_completed_run_is_noop() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "s5",
                "codex",
                SubAgentEvent::Done {
                    final_message: "ok".into(),
                },
            ),
        );
        assert!(!r.cancel("s5"));
        assert_eq!(r.get("s5").unwrap().status, SubAgentRunStatus::Completed);
    }

    #[test]
    fn done_after_cancel_keeps_cancelled_status() {
        // Race: the operator clicks cancel just before the
        // subagent emits its natural Done. The cancel mark is the
        // operator's truth and must not be overwritten.
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "s6",
                "codex",
                SubAgentEvent::Started {
                    task: "x".into(),
                    model: None,
                },
            ),
        );
        assert!(r.cancel("s6"));
        r.record_frame(
            None,
            &frame(
                "s6",
                "codex",
                SubAgentEvent::Done {
                    final_message: "lol".into(),
                },
            ),
        );
        assert_eq!(r.get("s6").unwrap().status, SubAgentRunStatus::Cancelled);
    }

    #[test]
    fn list_returns_runs_newest_first() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "old",
                "x",
                SubAgentEvent::Started {
                    task: "a".into(),
                    model: None,
                },
            ),
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
        r.record_frame(
            None,
            &frame(
                "new",
                "x",
                SubAgentEvent::Started {
                    task: "b".into(),
                    model: None,
                },
            ),
        );
        let list = r.list();
        assert_eq!(list[0].id, "new");
        assert_eq!(list[1].id, "old");
    }

    #[test]
    fn ring_evicts_oldest_past_cap() {
        // Drive past MAX_RUNS by writing a tiny stub; verify the
        // oldest entry was evicted and the newest is still there.
        let r = SubAgentRunRegistry::default();
        for i in 0..(MAX_RUNS + 5) {
            r.record_frame(
                None,
                &frame(
                    &format!("id-{i}"),
                    "x",
                    SubAgentEvent::Started {
                        task: format!("t{i}"),
                        model: None,
                    },
                ),
            );
        }
        assert!(r.get("id-0").is_none(), "oldest should be evicted");
        assert!(r.get(&format!("id-{}", MAX_RUNS + 4)).is_some());
    }

    #[test]
    fn events_endpoint_returns_recorded_frames() {
        let r = SubAgentRunRegistry::default();
        r.record_frame(
            None,
            &frame(
                "s7",
                "x",
                SubAgentEvent::Started {
                    task: "x".into(),
                    model: None,
                },
            ),
        );
        r.record_frame(
            None,
            &frame(
                "s7",
                "x",
                SubAgentEvent::Status {
                    message: "thinking".into(),
                },
            ),
        );
        let evs = r.events("s7").unwrap();
        assert_eq!(evs.len(), 2);
    }
}
