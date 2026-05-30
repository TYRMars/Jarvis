use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use harness_core::AgentEvent;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

const MAX_EVENTS_PER_RUN: usize = 1_000;
/// Broadcast capacity per active conversation. Sized for "WS reconnect
/// catches up while the original turn is still streaming" — a slow
/// subscriber that lags more than this many events gets a `Lagged`
/// signal and is expected to refetch via the snapshot path. Picked to
/// be larger than typical token-delta bursts during a single turn so
/// transient backpressure doesn't kick a healthy client off.
const BROADCAST_CAPACITY: usize = 256;
/// How long a terminal (completed/failed/cancelled) run lingers in the
/// registry after it finishes. Long enough that a late WS reconnect can
/// still replay the final frames and observe channel closure, short
/// enough that memory doesn't grow with the lifetime number of
/// conversations served. Eviction is lazy (swept on the next
/// `try_start` / terminal transition) so there's no background task.
const TERMINAL_RETENTION_MS: u64 = 5 * 60 * 1_000;
/// Hard backstop on retained terminal runs, independent of the TTL.
/// Guards against a burst of conversations all completing inside the
/// retention window: once we exceed this, the oldest terminal runs are
/// dropped LRU-style by terminal timestamp. Active runs are never
/// counted against this cap or evicted.
const MAX_RETAINED_TERMINAL: usize = 256;

/// In-process status ledger for Web chat turns.
///
/// This deliberately starts small: it records the server-side truth
/// for "which persisted conversations have an active turn right now"
/// without moving execution out of the existing WebSocket loop yet.
/// The next increment can hang broadcast/event replay and detachable
/// task ownership off the same registry.
#[derive(Default)]
pub struct ChatRunRegistry {
    inner: RwLock<HashMap<String, ChatRunState>>,
    aborts: RwLock<HashMap<String, tokio::task::AbortHandle>>,
}

struct ChatRunState {
    record: ChatRunRecord,
    events: Vec<ChatRunEventRecord>,
    next_seq: u64,
    /// Live fan-out for re-attaching subscribers (WS reconnects, future
    /// IM gateway adapters). The Sender stays alive across terminal
    /// events so a late subscriber on a freshly-completed run still
    /// receives `Lagged`/closure semantics rather than a missing
    /// channel. New runs on the same `conversation_id` (i.e. after a
    /// terminal event) replace the whole state, including this Sender,
    /// so old subscribers naturally see channel closure.
    broadcast: broadcast::Sender<ChatRunEventRecord>,
    /// `now_ms()` at which this run first reached a terminal status, or
    /// `None` while it's still active. Drives TTL + LRU eviction so the
    /// `inner` map doesn't grow with the lifetime number of
    /// conversations.
    terminated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRunRecord {
    pub conversation_id: String,
    pub status: ChatRunStatus,
    pub started_at: u64,
    pub updated_at: u64,
    pub latest_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRunEventRecord {
    pub conversation_id: String,
    pub seq: u64,
    pub timestamp: u64,
    pub frame: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRunStatus {
    Running,
    WaitingApproval,
    WaitingHitl,
    Completed,
    Failed,
    Cancelled,
}

impl ChatRunRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn start(&self, conversation_id: &str) {
        let _ = self.try_start(conversation_id);
    }

    pub fn try_start(&self, conversation_id: &str) -> bool {
        let now = now_ms();
        let record = ChatRunRecord {
            conversation_id: conversation_id.to_string(),
            status: ChatRunStatus::Running,
            started_at: now,
            updated_at: now,
            latest_seq: 0,
            current_tool: None,
            last_error: None,
        };
        if let Ok(mut guard) = self.inner.write() {
            prune_terminal_locked(&mut guard, now);
            if guard
                .get(conversation_id)
                .is_some_and(|state| state.record.status.is_active())
            {
                return false;
            }
            let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
            guard.insert(
                conversation_id.to_string(),
                ChatRunState {
                    record,
                    events: Vec::new(),
                    next_seq: 1,
                    broadcast: tx,
                    terminated_at: None,
                },
            );
            true
        } else {
            false
        }
    }

    /// Atomically: subscribe to the live broadcast for `conversation_id`,
    /// snapshot all buffered events with `seq > after`, return both.
    /// Returns `None` if the conversation has no run state (never
    /// started, or already evicted — terminal runs are dropped after
    /// `TERMINAL_RETENTION_MS`, so a reconnect that arrives long after
    /// completion sees `None` and falls back to the persisted history).
    ///
    /// The snapshot + subscription pair is consistent: any event
    /// pushed after the lock is released arrives via the receiver,
    /// any event pushed before lands in the snapshot. Callers should
    /// replay the snapshot first, then drain the receiver.
    pub fn subscribe(
        &self,
        conversation_id: &str,
        after: u64,
    ) -> Option<(
        Vec<ChatRunEventRecord>,
        broadcast::Receiver<ChatRunEventRecord>,
    )> {
        let guard = self.inner.read().ok()?;
        let state = guard.get(conversation_id)?;
        let rx = state.broadcast.subscribe();
        let snapshot: Vec<ChatRunEventRecord> = state
            .events
            .iter()
            .filter(|e| e.seq > after)
            .cloned()
            .collect();
        Some((snapshot, rx))
    }

    pub fn is_active(&self, conversation_id: &str) -> bool {
        self.inner
            .read()
            .ok()
            .and_then(|guard| {
                guard
                    .get(conversation_id)
                    .map(|state| state.record.status.is_active())
            })
            .unwrap_or(false)
    }

    pub fn attach_abort_handle(
        &self,
        conversation_id: Option<&str>,
        handle: tokio::task::AbortHandle,
    ) {
        if let Some(id) = conversation_id {
            if let Ok(mut guard) = self.aborts.write() {
                guard.insert(id.to_string(), handle);
            }
        }
    }

    pub fn interrupt(&self, conversation_id: &str) -> bool {
        let handle = self
            .aborts
            .write()
            .ok()
            .and_then(|mut guard| guard.remove(conversation_id));
        let Some(handle) = handle else {
            return false;
        };
        handle.abort();
        self.frame(
            Some(conversation_id),
            Some(ChatRunStatus::Cancelled),
            serde_json::json!({ "type": "interrupted" }),
        );
        true
    }

    pub fn event(&self, conversation_id: Option<&str>, event: &AgentEvent) {
        let Some(id) = conversation_id else {
            return;
        };
        let status = match event {
            AgentEvent::ApprovalRequest { .. } => {
                Some((ChatRunStatus::WaitingApproval, None, None))
            }
            AgentEvent::ApprovalDecision { .. } => Some((ChatRunStatus::Running, None, None)),
            AgentEvent::ToolStart { name, .. } => {
                Some((ChatRunStatus::Running, Some(Some(name.clone())), None))
            }
            AgentEvent::ToolEnd { .. } => Some((ChatRunStatus::Running, Some(None), None)),
            AgentEvent::Done { .. } => Some((ChatRunStatus::Completed, Some(None), Some(None))),
            AgentEvent::Error { message } => Some((
                ChatRunStatus::Failed,
                Some(None),
                Some(Some(message.clone())),
            )),
            _ => None,
        };
        let frame = serde_json::to_value(event).unwrap_or_else(
            |e| serde_json::json!({ "type": "error", "message": format!("serialize: {e}") }),
        );
        self.push_frame(id, status, frame);
    }

    pub fn frame(
        &self,
        conversation_id: Option<&str>,
        status: Option<ChatRunStatus>,
        frame: Value,
    ) {
        if let Some(id) = conversation_id {
            self.push_frame(id, status.map(|s| (s, None, None)), frame);
        }
    }

    pub fn waiting_hitl(&self, conversation_id: Option<&str>) {
        if let Some(id) = conversation_id {
            self.update(id, ChatRunStatus::WaitingHitl, None, None);
        }
    }

    pub fn running(&self, conversation_id: Option<&str>) {
        if let Some(id) = conversation_id {
            self.update(id, ChatRunStatus::Running, None, None);
        }
    }

    pub fn cancelled(&self, conversation_id: Option<&str>) {
        if let Some(id) = conversation_id {
            self.update(id, ChatRunStatus::Cancelled, Some(None), Some(None));
        }
    }

    pub fn list(&self, active_only: bool) -> Vec<ChatRunRecord> {
        let Ok(guard) = self.inner.read() else {
            return Vec::new();
        };
        let mut rows: Vec<_> = guard
            .values()
            .map(|s| &s.record)
            .filter(|r| !active_only || r.status.is_active())
            .cloned()
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
        rows
    }

    pub fn events(&self, conversation_id: &str, after: u64) -> Vec<ChatRunEventRecord> {
        let Ok(guard) = self.inner.read() else {
            return Vec::new();
        };
        guard
            .get(conversation_id)
            .map(|s| s.events.iter().filter(|e| e.seq > after).cloned().collect())
            .unwrap_or_default()
    }

    fn update(
        &self,
        conversation_id: &str,
        status: ChatRunStatus,
        current_tool: Option<Option<String>>,
        last_error: Option<Option<String>>,
    ) {
        let now = now_ms();
        if let Ok(mut guard) = self.inner.write() {
            let became_terminal;
            {
                let state = guard
                    .entry(conversation_id.to_string())
                    .or_insert_with(|| make_state(conversation_id, status, now));
                state.record.status = status;
                state.record.updated_at = now;
                if let Some(tool) = current_tool {
                    state.record.current_tool = tool;
                }
                if let Some(err) = last_error {
                    state.record.last_error = err;
                }
                became_terminal = status.is_terminal() && state.mark_terminal(now);
            }
            if became_terminal {
                prune_terminal_locked(&mut guard, now);
            }
        }
    }

    #[allow(clippy::type_complexity)]
    fn push_frame(
        &self,
        conversation_id: &str,
        status: Option<(
            ChatRunStatus,
            Option<Option<String>>,
            Option<Option<String>>,
        )>,
        frame: Value,
    ) {
        let now = now_ms();
        if let Ok(mut guard) = self.inner.write() {
            let became_terminal;
            {
                let state = guard.entry(conversation_id.to_string()).or_insert_with(|| {
                    make_state(
                        conversation_id,
                        status
                            .as_ref()
                            .map(|(s, _, _)| *s)
                            .unwrap_or(ChatRunStatus::Running),
                        now,
                    )
                });

                if let Some((next_status, current_tool, last_error)) = status {
                    state.record.status = next_status;
                    if let Some(tool) = current_tool {
                        state.record.current_tool = tool;
                    }
                    if let Some(err) = last_error {
                        state.record.last_error = err;
                    }
                }

                let seq = state.next_seq;
                state.next_seq += 1;
                state.record.updated_at = now;
                state.record.latest_seq = seq;
                let record = ChatRunEventRecord {
                    conversation_id: conversation_id.to_string(),
                    seq,
                    timestamp: now,
                    frame,
                };
                state.events.push(record.clone());
                if state.events.len() > MAX_EVENTS_PER_RUN {
                    let excess = state.events.len() - MAX_EVENTS_PER_RUN;
                    state.events.drain(0..excess);
                }
                // Fan out to live subscribers. `send` errors when there
                // are zero receivers — expected (no one is tailing) and
                // not worth logging. Lagged subscribers see `Lagged` on
                // their next recv() and we leave that handling to the
                // caller (the WS handler treats it as "drop the tail and
                // ask the client to refetch").
                let _ = state.broadcast.send(record);
                became_terminal = state.record.status.is_terminal() && state.mark_terminal(now);
            }
            if became_terminal {
                if let Ok(mut aborts) = self.aborts.write() {
                    aborts.remove(conversation_id);
                }
                prune_terminal_locked(&mut guard, now);
            }
        }
    }
}

impl ChatRunState {
    /// Stamp the terminal timestamp the first time the run reaches a
    /// terminal status. Returns `true` only on that first transition so
    /// callers can run one-shot side effects (abort-handle cleanup,
    /// eviction sweep) exactly once.
    fn mark_terminal(&mut self, now: u64) -> bool {
        if self.terminated_at.is_none() {
            self.terminated_at = Some(now);
            true
        } else {
            false
        }
    }
}

fn make_state(conversation_id: &str, status: ChatRunStatus, now: u64) -> ChatRunState {
    let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
    ChatRunState {
        record: ChatRunRecord {
            conversation_id: conversation_id.to_string(),
            status,
            started_at: now,
            updated_at: now,
            latest_seq: 0,
            current_tool: None,
            last_error: None,
        },
        events: Vec::new(),
        next_seq: 1,
        broadcast: tx,
        // Always starts `None`; the caller stamps it via `mark_terminal`
        // after setting the status so the first-transition bookkeeping
        // (abort cleanup, eviction sweep) fires exactly once.
        terminated_at: None,
    }
}

/// Evict terminal runs that have outlived their retention window, then
/// cap the number of retained terminal runs as a backstop against a
/// burst completing inside the TTL. Active runs are never evicted.
/// Caller must hold the `inner` write lock.
fn prune_terminal_locked(guard: &mut HashMap<String, ChatRunState>, now: u64) {
    // TTL eviction. Active runs (`terminated_at == None`) are kept
    // unconditionally; `saturating_sub` keeps a clock that jumped
    // backwards from evicting everything.
    guard.retain(|_, state| match state.terminated_at {
        Some(t) => now.saturating_sub(t) < TERMINAL_RETENTION_MS,
        None => true,
    });

    // LRU backstop: if too many terminal runs survived the TTL window,
    // drop the oldest by terminal timestamp.
    let terminal_count = guard.values().filter(|s| s.terminated_at.is_some()).count();
    if terminal_count > MAX_RETAINED_TERMINAL {
        let mut terminals: Vec<(String, u64)> = guard
            .iter()
            .filter_map(|(id, s)| s.terminated_at.map(|t| (id.clone(), t)))
            .collect();
        terminals.sort_by_key(|(_, t)| *t);
        for (id, _) in terminals
            .into_iter()
            .take(terminal_count - MAX_RETAINED_TERMINAL)
        {
            guard.remove(&id);
        }
    }
}

impl ChatRunStatus {
    fn is_active(self) -> bool {
        matches!(
            self,
            ChatRunStatus::Running | ChatRunStatus::WaitingApproval | ChatRunStatus::WaitingHitl
        )
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            ChatRunStatus::Completed | ChatRunStatus::Failed | ChatRunStatus::Cancelled
        )
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
impl ChatRunRegistry {
    /// Test seam: run the eviction sweep with an injected clock so TTL
    /// behaviour is testable without sleeping a real `TERMINAL_RETENTION_MS`.
    fn force_prune(&self, now: u64) {
        if let Ok(mut guard) = self.inner.write() {
            prune_terminal_locked(&mut guard, now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_ordered_events_and_filters_by_seq() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "a".into(),
            },
        );
        registry.frame(
            Some("c1"),
            None,
            serde_json::json!({ "type": "custom", "value": 1 }),
        );

        let all = registry.events("c1", 0);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].seq, 1);
        assert_eq!(all[1].seq, 2);

        let tail = registry.events("c1", 1);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].frame["type"], "custom");
    }

    #[test]
    fn terminal_event_updates_status_and_latest_seq() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Error {
                message: "boom".into(),
            },
        );

        let rows = registry.list(false);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, ChatRunStatus::Failed);
        assert_eq!(rows[0].latest_seq, 1);
        assert_eq!(rows[0].last_error.as_deref(), Some("boom"));
        assert!(registry.list(true).is_empty());
    }

    #[test]
    fn try_start_rejects_active_run_and_allows_after_terminal() {
        let registry = ChatRunRegistry::default();
        assert!(registry.try_start("c1"));
        assert!(!registry.try_start("c1"));
        assert!(registry.is_active("c1"));

        registry.event(
            Some("c1"),
            &AgentEvent::Error {
                message: "boom".into(),
            },
        );

        assert!(!registry.is_active("c1"));
        assert!(registry.try_start("c1"));
    }

    #[tokio::test]
    async fn subscribe_replays_buffered_then_streams_live_without_gaps() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "past-1".into(),
            },
        );
        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "past-2".into(),
            },
        );

        let (snapshot, mut rx) = registry.subscribe("c1", 0).expect("active run");
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].seq, 1);
        assert_eq!(snapshot[1].seq, 2);

        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "live-3".into(),
            },
        );
        registry.frame(
            Some("c1"),
            Some(ChatRunStatus::Completed),
            serde_json::json!({ "type": "done" }),
        );

        let live = rx.recv().await.expect("live event");
        assert_eq!(live.seq, 3);
        assert_eq!(live.frame["content"], "live-3");

        let terminal = rx.recv().await.expect("terminal event");
        assert_eq!(terminal.seq, 4);
        assert_eq!(terminal.frame["type"], "done");
    }

    #[test]
    fn subscribe_after_filters_out_already_seen_seqs() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        for i in 0..3 {
            registry.event(
                Some("c1"),
                &AgentEvent::Delta {
                    content: format!("d{i}"),
                },
            );
        }
        let (snapshot, _rx) = registry.subscribe("c1", 2).expect("active run");
        // seqs 1 and 2 filtered out; only 3 remains in the replay window.
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].seq, 3);
    }

    #[test]
    fn subscribe_returns_none_for_unknown_conversation() {
        let registry = ChatRunRegistry::default();
        assert!(registry.subscribe("never-started", 0).is_none());
    }

    #[test]
    fn terminal_run_is_evicted_after_ttl() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Error {
                message: "boom".into(),
            },
        );
        // Within the retention window it's still queryable for late
        // reconnects.
        assert_eq!(registry.list(false).len(), 1);
        registry.force_prune(now_ms());
        assert_eq!(registry.list(false).len(), 1);

        // Far enough past the terminal timestamp, it's swept.
        registry.force_prune(u64::MAX);
        assert!(registry.list(false).is_empty());
        assert!(registry.subscribe("c1", 0).is_none());
    }

    #[test]
    fn active_run_is_never_evicted() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "still going".into(),
            },
        );
        // Even with an absurd clock, an active (non-terminal) run stays.
        registry.force_prune(u64::MAX);
        assert!(registry.is_active("c1"));
        assert_eq!(registry.list(false).len(), 1);
    }

    #[test]
    fn cancelled_run_is_evicted_after_ttl() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.cancelled(Some("c1"));
        assert_eq!(registry.list(false).len(), 1);
        registry.force_prune(u64::MAX);
        assert!(registry.list(false).is_empty());
    }

    #[test]
    fn terminal_runs_are_capped_by_lru_backstop() {
        let registry = ChatRunRegistry::default();
        let total = MAX_RETAINED_TERMINAL + 5;
        for i in 0..total {
            let id = format!("c{i}");
            registry.start(&id);
            registry.event(
                Some(&id),
                &AgentEvent::Done {
                    outcome: harness_core::RunOutcome::Stopped { iterations: 1 },
                    conversation: Default::default(),
                },
            );
        }
        // The LRU backstop kicks in on each terminal transition, so the
        // retained set never exceeds the cap regardless of TTL.
        assert!(registry.list(false).len() <= MAX_RETAINED_TERMINAL);
    }

    #[test]
    fn restarting_an_evicted_conversation_succeeds() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        registry.event(
            Some("c1"),
            &AgentEvent::Done {
                outcome: harness_core::RunOutcome::Stopped { iterations: 1 },
                conversation: Default::default(),
            },
        );
        registry.force_prune(u64::MAX);
        assert!(registry.list(false).is_empty());
        // A fresh run on the same id after eviction starts cleanly.
        assert!(registry.try_start("c1"));
        assert!(registry.is_active("c1"));
    }
}
