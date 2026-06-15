use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use harness_core::{AgentEvent, ApprovalDecision, ApprovalRequest};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

const MAX_EVENTS_PER_RUN: usize = 1_000;
/// Total bytes (estimated) of buffered frames retained per active
/// conversation. Caps memory growth from large tool outputs
/// (e.g. `fs.read` on a multi-MiB file) that would otherwise sit
/// well under the count limit but blow up the heap. Frames are
/// evicted FIFO until both this byte budget and the count cap are
/// satisfied.
const MAX_EVENT_BYTES_PER_RUN: usize = 8 * 1024 * 1024;
/// Hard cap for a single recorded frame. Frames over this size are
/// replaced with a `{type: "_truncated", ...}` stand-in **before**
/// being pushed into the ring, so a single oversized payload can't
/// itself evict the rest of the buffer. Live broadcast subscribers
/// see the same truncated payload — the original is not retained
/// anywhere on the server.
const MAX_SINGLE_FRAME_BYTES: usize = 1024 * 1024;
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
    events: VecDeque<ChatRunEventRecord>,
    /// Smallest `seq` still resident in `events`. Equal to
    /// `next_seq` when `events` is empty (i.e. nothing has ever been
    /// pushed, or everything has been evicted — the latter doesn't
    /// happen today since we always retain at least the most recent
    /// frame). A reconnecting client asking for `after_seq <
    /// first_seq - 1` has missed events and should be told via
    /// `ResumeError::Evicted` so it can do a full reload.
    first_seq: u64,
    next_seq: u64,
    /// Sum of estimated bytes for every record currently in `events`.
    /// Tracked incrementally so eviction doesn't need to re-walk the
    /// deque on every push.
    cumulative_bytes: usize,
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
    /// Approvals the agent is currently blocked on. Keyed by the
    /// tool's `tool_call_id` so an inbound `approve` / `deny` frame
    /// from any socket attached to the conversation can route back
    /// to the right `oneshot::Sender`. Pre-M4 these lived in the WS
    /// handler's per-socket map and a disconnect lost them
    /// silently; moving them onto the conversation lets a
    /// reconnecting socket pick up where the original left off.
    pending_approvals: HashMap<String, PendingApprovalSlot>,
}

/// One entry in a conversation's pending-approval table. Holds the
/// original `ApprovalRequest` so a reconnecting socket can be
/// replayed the prompt verbatim, plus the `oneshot::Sender` the
/// agent is awaiting on. `created_at` is for future idle sweeping
/// (post-v1 — a 30-min unanswered approval should auto-deny).
pub(crate) struct PendingApprovalSlot {
    pub request: ApprovalRequest,
    pub responder: oneshot::Sender<ApprovalDecision>,
    /// Reserved for post-v1 idle sweeping: when an approval has
    /// been waiting unanswered past a threshold (e.g. 30 min),
    /// auto-deny it to free the slot. v1 keeps slots alive until
    /// either an explicit Approve/Deny or run-terminal drain. The
    /// field is preserved so the sweeper doesn't need a schema
    /// change later.
    #[allow(dead_code)]
    pub created_at: u64,
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

/// Smallest / largest `seq` currently retained for an active run,
/// returned alongside a snapshot so callers can detect eviction and
/// decide whether to fall back to a full reload from the persisted
/// conversation store.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ReplayWindow {
    pub first_seq: u64,
    pub latest_seq: u64,
}

/// Why a `subscribe(after_seq)` call could not be served.
#[derive(Debug, Clone)]
pub enum ResumeError {
    /// Caller asked for events after `after_seq`, but events at or
    /// below that point have been evicted from the ring buffer.
    /// `first_available_seq` is the lowest `seq` the buffer can still
    /// produce; clients should treat this as "you've fallen too far
    /// behind, please reload from `/v1/conversations/:id`".
    Evicted { first_available_seq: u64 },
}

/// Result of `ChatRunRegistry::subscribe`. Outer `Option` is `None`
/// when the conversation has no run state in the registry (never
/// started, or a fresh process). Inner `Result` carries either the
/// snapshot + live receiver + window, or `ResumeError::Evicted` when
/// the caller's `after_seq` is older than the oldest retained seq.
pub type SubscribeOutcome = Option<
    Result<
        (
            Vec<ChatRunEventRecord>,
            broadcast::Receiver<ChatRunEventRecord>,
            ReplayWindow,
        ),
        ResumeError,
    >,
>;

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
                    events: VecDeque::new(),
                    first_seq: 1,
                    next_seq: 1,
                    cumulative_bytes: 0,
                    broadcast: tx,
                    terminated_at: None,
                    pending_approvals: HashMap::new(),
                },
            );
            true
        } else {
            false
        }
    }

    /// Atomically: subscribe to the live broadcast for `conversation_id`,
    /// snapshot all buffered events with `seq > after`, return both
    /// plus the current `ReplayWindow` so the caller can detect
    /// eviction.
    ///
    /// Returns `None` if the conversation has no run state (never
    /// started — distinct from "started but every event evicted",
    /// which today is impossible because the cap is positive).
    ///
    /// Terminal runs are dropped after `TERMINAL_RETENTION_MS`,
    /// so a reconnect long after completion sees `None` and falls
    /// back to the persisted history.
    ///
    /// Returns `Err(ResumeError::Evicted { first_available_seq })`
    /// when the caller's `after` cursor is strictly older than the
    /// oldest retained seq minus one — meaning at least one event in
    /// the requested range has been dropped from the ring. The
    /// receiver is not returned in this case; the caller should reset
    /// state and reload from persisted history.
    ///
    /// On success the snapshot + subscription pair is consistent:
    /// any event pushed after the lock is released arrives via the
    /// receiver, any event pushed before lands in the snapshot.
    /// Callers should replay the snapshot first, then drain the
    /// receiver.
    pub fn subscribe(&self, conversation_id: &str, after: u64) -> SubscribeOutcome {
        let guard = self.inner.read().ok()?;
        let state = guard.get(conversation_id)?;
        let window = ReplayWindow {
            first_seq: state.first_seq,
            latest_seq: state.record.latest_seq,
        };
        // Eviction check: the caller has seen everything up to and
        // including `after`. If `after + 1 < first_seq`, at least
        // one event in (after, first_seq) was evicted. `after == 0`
        // is the "give me everything" case — only fails when the
        // very first event (seq 1) is gone, which by definition
        // means events have been dropped.
        if state.first_seq > 1 && after < state.first_seq - 1 {
            return Some(Err(ResumeError::Evicted {
                first_available_seq: state.first_seq,
            }));
        }
        let rx = state.broadcast.subscribe();
        let snapshot: Vec<ChatRunEventRecord> = state
            .events
            .iter()
            .filter(|e| e.seq > after)
            .cloned()
            .collect();
        Some(Ok((snapshot, rx, window)))
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

    /// Inspect the current replay window without subscribing. Used
    /// by tasks/diagnostics surfaces that want to expose buffer
    /// health without holding a `Receiver`.
    pub fn replay_window(&self, conversation_id: &str) -> Option<ReplayWindow> {
        let guard = self.inner.read().ok()?;
        let state = guard.get(conversation_id)?;
        Some(ReplayWindow {
            first_seq: state.first_seq,
            latest_seq: state.record.latest_seq,
        })
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

    /// Record an `AgentEvent` in the run's ring buffer and fan out
    /// to live subscribers. Returns the `seq` assigned to this
    /// event so callers (specifically the owner WS path in
    /// `spawn_detached_turn`) can stamp the same seq onto their
    /// out-of-band mpsc send and keep wire ordering aligned with
    /// the broadcast subscribers. Returns `None` when no
    /// `conversation_id` was supplied (the registry is a no-op for
    /// non-persisted free chat).
    pub fn event(&self, conversation_id: Option<&str>, event: &AgentEvent) -> Option<u64> {
        let id = conversation_id?;
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
        Some(self.push_frame(id, status, frame))
    }

    /// Record a manually-shaped JSON frame. Same semantics as
    /// [`event`] — returns the assigned `seq` when a
    /// `conversation_id` is supplied so callers can stamp the same
    /// seq onto out-of-band sends. Returns `None` when no
    /// `conversation_id` was supplied.
    pub fn frame(
        &self,
        conversation_id: Option<&str>,
        status: Option<ChatRunStatus>,
        frame: Value,
    ) -> Option<u64> {
        let id = conversation_id?;
        Some(self.push_frame(id, status.map(|s| (s, None, None)), frame))
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

    /// Stash a `PendingApproval`'s responder under the conversation
    /// so any socket attached to it (including a fresh one after a
    /// disconnect) can route the user's verdict back to the agent.
    /// Pre-M4 this lived per-socket and a tab close lost the slot;
    /// now it survives until either an `approve`/`deny` consumes it
    /// or the run reaches a terminal status (which triggers
    /// [`drain_pending_approvals`] to auto-deny anything still
    /// waiting).
    pub fn register_pending_approval(
        &self,
        conversation_id: &str,
        request: ApprovalRequest,
        responder: oneshot::Sender<ApprovalDecision>,
    ) {
        let now = now_ms();
        if let Ok(mut guard) = self.inner.write() {
            let state = guard.entry(conversation_id.to_string()).or_insert_with(|| {
                make_state(conversation_id, ChatRunStatus::WaitingApproval, now)
            });
            state.pending_approvals.insert(
                request.tool_call_id.clone(),
                PendingApprovalSlot {
                    request,
                    responder,
                    created_at: now,
                },
            );
        }
    }

    /// Remove and return the responder for a pending approval. Used
    /// by the WS handler's `Approve` / `Deny` arms so the user's
    /// verdict reaches the agent. Returns `None` if the approval
    /// was already resolved (e.g. the run terminated and
    /// [`drain_pending_approvals`] auto-denied it, or another tab
    /// got there first).
    pub fn take_pending_approval(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> Option<oneshot::Sender<ApprovalDecision>> {
        let mut guard = self.inner.write().ok()?;
        let state = guard.get_mut(conversation_id)?;
        state
            .pending_approvals
            .remove(tool_call_id)
            .map(|slot| slot.responder)
    }

    /// Snapshot of the requests still awaiting a verdict on this
    /// conversation. Used by the `Resume` path to re-prompt a
    /// reconnecting client for any approvals it missed; the
    /// snapshot is cloned out under the registry lock so the
    /// caller can serialise + send without holding it.
    pub fn list_pending_approvals(&self, conversation_id: &str) -> Vec<ApprovalRequest> {
        let Ok(guard) = self.inner.read() else {
            return Vec::new();
        };
        guard
            .get(conversation_id)
            .map(|s| {
                s.pending_approvals
                    .values()
                    .map(|slot| slot.request.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Auto-deny every pending approval on this conversation,
    /// citing `reason`. Called when the run reaches a terminal
    /// status so the agent (already in the process of being torn
    /// down) doesn't see an indefinitely-stalled `approve()`
    /// future, and the registry doesn't grow stale `oneshot`
    /// senders for runs that nobody is going to revisit.
    pub fn drain_pending_approvals(&self, conversation_id: &str, reason: &str) {
        let Ok(mut guard) = self.inner.write() else {
            return;
        };
        let Some(state) = guard.get_mut(conversation_id) else {
            return;
        };
        for (_id, slot) in state.pending_approvals.drain() {
            let _ = slot
                .responder
                .send(ApprovalDecision::deny(reason.to_string()));
        }
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

    /// Returns the `seq` that was assigned to the pushed frame
    /// (always >= 1). When the registry lock is poisoned the push
    /// is skipped and `0` is returned — callers can treat 0 as
    /// "no seq, do not stamp out-of-band".
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
    ) -> u64 {
        let now = now_ms();
        let mut assigned_seq: u64 = 0;
        if let Ok(mut guard) = self.inner.write() {
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
            assigned_seq = seq;

            // Cap oversized single frames before insertion so they
            // don't single-handedly evict the rest of the buffer.
            // Preserve enough metadata that the client can show the
            // user a placeholder instead of silently missing the
            // frame.
            let frame_bytes = estimate_frame_bytes(&frame);
            let (frame_to_store, stored_bytes) = if frame_bytes > MAX_SINGLE_FRAME_BYTES {
                let original_type = frame
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let replacement = serde_json::json!({
                    "type": "_truncated",
                    "original_type": original_type,
                    "original_size_bytes": frame_bytes,
                    "reason": "frame_too_large",
                });
                let replacement_bytes = estimate_frame_bytes(&replacement);
                (replacement, replacement_bytes)
            } else {
                (frame, frame_bytes)
            };

            let record = ChatRunEventRecord {
                conversation_id: conversation_id.to_string(),
                seq,
                timestamp: now,
                frame: frame_to_store,
            };
            state.events.push_back(record.clone());
            state.cumulative_bytes = state.cumulative_bytes.saturating_add(stored_bytes);

            // FIFO eviction: drop oldest until both the count and the
            // byte budget are satisfied. Always retain at least the
            // most recent frame even if it alone exceeds the byte
            // cap — a chat needs SOMETHING in its buffer.
            while state.events.len() > 1
                && (state.events.len() > MAX_EVENTS_PER_RUN
                    || state.cumulative_bytes > MAX_EVENT_BYTES_PER_RUN)
            {
                if let Some(dropped) = state.events.pop_front() {
                    let dropped_bytes = estimate_frame_bytes(&dropped.frame);
                    state.cumulative_bytes = state.cumulative_bytes.saturating_sub(dropped_bytes);
                }
            }
            state.first_seq = state
                .events
                .front()
                .map(|e| e.seq)
                .unwrap_or(state.next_seq);

            // Fan out to live subscribers. `send` errors when there
            // are zero receivers — expected (no one is tailing) and
            // not worth logging. Lagged subscribers see `Lagged` on
            // their next recv() and we leave that handling to the
            // caller (the WS handler treats it as "drop the tail and
            // ask the client to refetch").
            let _ = state.broadcast.send(record);
            // Drain any oneshot responders that were waiting on
            // approvals when the run flipped terminal — leaving
            // them in the map would leak oneshots indefinitely
            // (the agent task is already going down) and would
            // also confuse a reconnecting socket into showing an
            // approval bar for a dead run. We send Deny so any
            // still-running consumer side observes the same
            // shape it would on a normal denial.
            if state.record.status.is_terminal() && !state.pending_approvals.is_empty() {
                let reason = match state.record.status {
                    ChatRunStatus::Cancelled => "run cancelled",
                    ChatRunStatus::Failed => "run failed",
                    _ => "run terminated",
                };
                for (_id, slot) in state.pending_approvals.drain() {
                    let _ = slot
                        .responder
                        .send(ApprovalDecision::deny(reason.to_string()));
                }
            }
            // One-shot terminal bookkeeping: stamp `terminated_at` on
            // the first terminal transition only; the `state` borrow ends
            // here so the sweep below can re-borrow the whole map.
            let became_terminal = state.record.status.is_terminal() && state.mark_terminal(now);
            if became_terminal {
                if let Ok(mut aborts) = self.aborts.write() {
                    aborts.remove(conversation_id);
                }
                prune_terminal_locked(&mut guard, now);
            }
        }
        assigned_seq
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
        events: VecDeque::new(),
        first_seq: 1,
        next_seq: 1,
        cumulative_bytes: 0,
        broadcast: tx,
        // Always starts `None`; the caller stamps it via `mark_terminal`
        // after setting the status so the first-transition bookkeeping
        // (abort cleanup, eviction sweep) fires exactly once.
        terminated_at: None,
        pending_approvals: HashMap::new(),
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

/// Estimate the on-wire byte cost of a frame. We use
/// `serde_json::to_string` length as a proxy — slightly different
/// from the WebSocket payload size (no framing header) but accurate
/// enough to budget against. Returns 0 when serialization fails
/// (which it shouldn't for a `Value` that already round-tripped
/// through serde).
fn estimate_frame_bytes(frame: &Value) -> usize {
    serde_json::to_string(frame).map(|s| s.len()).unwrap_or(0)
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

        let (snapshot, mut rx, window) = registry
            .subscribe("c1", 0)
            .expect("active run")
            .expect("not evicted");
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].seq, 1);
        assert_eq!(snapshot[1].seq, 2);
        assert_eq!(window.first_seq, 1);
        assert_eq!(window.latest_seq, 2);

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
        let (snapshot, _rx, window) = registry
            .subscribe("c1", 2)
            .expect("active run")
            .expect("not evicted");
        // seqs 1 and 2 filtered out; only 3 remains in the replay window.
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].seq, 3);
        assert_eq!(window.first_seq, 1);
        assert_eq!(window.latest_seq, 3);
    }

    #[test]
    fn subscribe_returns_none_for_unknown_conversation() {
        let registry = ChatRunRegistry::default();
        assert!(registry.subscribe("never-started", 0).is_none());
    }

    #[test]
    fn evicts_when_count_exceeds_max() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        for i in 0..MAX_EVENTS_PER_RUN + 10 {
            registry.event(
                Some("c1"),
                &AgentEvent::Delta {
                    content: format!("d{i}"),
                },
            );
        }
        let window = registry.replay_window("c1").expect("active");
        // 1010 pushed, oldest 10 evicted → first_seq = 11,
        // latest_seq = 1010, and the resident set is exactly 1000.
        assert_eq!(window.latest_seq, (MAX_EVENTS_PER_RUN + 10) as u64);
        assert_eq!(window.first_seq, 11);
        let all = registry.events("c1", 0);
        assert_eq!(all.len(), MAX_EVENTS_PER_RUN);
        assert_eq!(all.first().unwrap().seq, 11);
        assert_eq!(all.last().unwrap().seq, (MAX_EVENTS_PER_RUN + 10) as u64);
    }

    #[test]
    fn evicts_when_byte_budget_exceeded() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        // Each frame is ~256 KiB of payload. 40 of these = ~10 MiB
        // > 8 MiB budget, so eviction should kick in on byte
        // budget well before the 1000-event count cap.
        let big = "x".repeat(256 * 1024);
        for _ in 0..40 {
            registry.frame(
                Some("c1"),
                None,
                serde_json::json!({ "type": "blob", "payload": big }),
            );
        }
        let window = registry.replay_window("c1").expect("active");
        let resident = registry.events("c1", 0);
        // Byte budget enforced…
        let total: usize = resident
            .iter()
            .map(|r| estimate_frame_bytes(&r.frame))
            .sum();
        assert!(
            total <= MAX_EVENT_BYTES_PER_RUN,
            "bytes {total} exceeded cap {MAX_EVENT_BYTES_PER_RUN}",
        );
        // …and at least one event was evicted (so first_seq > 1).
        assert!(window.first_seq > 1, "expected eviction, got {window:?}");
        // Count cap not the trigger here.
        assert!(resident.len() < MAX_EVENTS_PER_RUN);
    }

    #[test]
    fn single_frame_over_1mib_is_truncated() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        let huge = "y".repeat(2 * 1024 * 1024);
        registry.frame(
            Some("c1"),
            None,
            serde_json::json!({ "type": "tool_end", "content": huge }),
        );
        let stored = registry.events("c1", 0);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].seq, 1);
        assert_eq!(stored[0].frame["type"], "_truncated");
        assert_eq!(stored[0].frame["original_type"], "tool_end");
        assert!(
            stored[0]
                .frame
                .get("original_size_bytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                > 1024 * 1024,
            "original size should reflect pre-truncation bytes"
        );
        // Subsequent normal frame keeps its seq monotonic.
        registry.frame(
            Some("c1"),
            None,
            serde_json::json!({ "type": "normal", "x": 1 }),
        );
        let all = registry.events("c1", 0);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].seq, 2);
        assert_eq!(all[1].frame["type"], "normal");
    }

    #[test]
    fn subscribe_evicted_returns_error() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        for i in 0..MAX_EVENTS_PER_RUN + 200 {
            registry.event(
                Some("c1"),
                &AgentEvent::Delta {
                    content: format!("d{i}"),
                },
            );
        }
        // first_seq is now 201 (lost 1..=200), latest 1200.
        let outcome = registry.subscribe("c1", 50).expect("active");
        match outcome {
            Err(ResumeError::Evicted {
                first_available_seq,
            }) => {
                assert_eq!(first_available_seq, 201);
            }
            Ok(_) => panic!("expected Evicted, got Ok"),
        }
        // Asking for the boundary (after = first_seq - 1 = 200) succeeds.
        assert!(registry.subscribe("c1", 200).expect("active").is_ok());
        // Asking for after = 0 on a buffer with first_seq > 1 also
        // fails: seq 1 was definitely lost.
        assert!(matches!(
            registry.subscribe("c1", 0).expect("active"),
            Err(ResumeError::Evicted { .. })
        ));
    }

    #[test]
    fn subscribe_with_max_after_does_not_overflow() {
        // Regression: a client-supplied `after_seq = u64::MAX` must not
        // overflow `after + 1` (panic in debug, wrap-to-0 + spurious
        // Evicted in release). A cursor at or past the latest seq has
        // seen everything, so it should resolve to an empty Ok snapshot,
        // never Evicted.
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        for i in 0..MAX_EVENTS_PER_RUN + 200 {
            registry.event(
                Some("c1"),
                &AgentEvent::Delta {
                    content: format!("d{i}"),
                },
            );
        }
        // first_seq is now 201 (lost 1..=200) — the branch that does the
        // arithmetic is reachable.
        let outcome = registry.subscribe("c1", u64::MAX).expect("active");
        match outcome {
            Ok((snapshot, _rx, _window)) => assert!(snapshot.is_empty()),
            Err(e) => panic!("expected empty Ok for max cursor, got {e:?}"),
        }
    }

    fn fake_approval(tool_call_id: &str) -> ApprovalRequest {
        ApprovalRequest {
            tool_call_id: tool_call_id.into(),
            tool_name: "fs.write".into(),
            arguments: serde_json::json!({ "path": "x.txt" }),
            category: harness_core::ToolCategory::Write,
        }
    }

    #[tokio::test]
    async fn take_pending_approval_round_trips_and_then_returns_none() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        let (tx, mut rx) = oneshot::channel();
        registry.register_pending_approval("c1", fake_approval("call-1"), tx);

        let responder = registry
            .take_pending_approval("c1", "call-1")
            .expect("slot present");
        responder
            .send(ApprovalDecision::Approve)
            .expect("recv side alive");
        let received = rx.try_recv().expect("verdict arrived");
        assert!(matches!(received, ApprovalDecision::Approve));

        // Second take returns None — slot consumed.
        assert!(registry.take_pending_approval("c1", "call-1").is_none());
    }

    #[tokio::test]
    async fn list_pending_approvals_returns_unresolved_only() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        let (tx_a, _rx_a) = oneshot::channel();
        let (tx_b, _rx_b) = oneshot::channel();
        let (tx_c, _rx_c) = oneshot::channel();
        registry.register_pending_approval("c1", fake_approval("a"), tx_a);
        registry.register_pending_approval("c1", fake_approval("b"), tx_b);
        registry.register_pending_approval("c1", fake_approval("c"), tx_c);

        // Resolve "b" — list should drop it.
        registry
            .take_pending_approval("c1", "b")
            .expect("present")
            .send(ApprovalDecision::Approve)
            .unwrap();

        let mut ids: Vec<String> = registry
            .list_pending_approvals("c1")
            .into_iter()
            .map(|r| r.tool_call_id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "c".to_string()]);
    }

    #[tokio::test]
    async fn terminal_status_drains_pending_with_deny() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        let (tx_a, mut rx_a) = oneshot::channel();
        let (tx_b, mut rx_b) = oneshot::channel();
        registry.register_pending_approval("c1", fake_approval("a"), tx_a);
        registry.register_pending_approval("c1", fake_approval("b"), tx_b);

        // A normal Done event flips the run terminal — drain fires.
        registry.event(
            Some("c1"),
            &AgentEvent::Done {
                outcome: harness_core::RunOutcome::Stopped { iterations: 1 },
                conversation: harness_core::Conversation::new(),
            },
        );

        let a = rx_a.try_recv().expect("a denied on drain");
        let b = rx_b.try_recv().expect("b denied on drain");
        assert!(matches!(a, ApprovalDecision::Deny { .. }));
        assert!(matches!(b, ApprovalDecision::Deny { .. }));
        assert!(registry.list_pending_approvals("c1").is_empty());
    }

    #[tokio::test]
    async fn drain_pending_approvals_is_idempotent_on_empty_set() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        // No approvals registered — drain must not panic.
        registry.drain_pending_approvals("c1", "manual");
        // And does nothing when conversation absent either.
        registry.drain_pending_approvals("never-started", "manual");
    }

    #[tokio::test]
    async fn subscribe_after_latest_returns_empty_and_streams_live() {
        let registry = ChatRunRegistry::default();
        registry.start("c1");
        for i in 0..5 {
            registry.event(
                Some("c1"),
                &AgentEvent::Delta {
                    content: format!("d{i}"),
                },
            );
        }
        let (snapshot, mut rx, window) = registry
            .subscribe("c1", 5)
            .expect("active")
            .expect("not evicted");
        assert!(snapshot.is_empty());
        assert_eq!(window.latest_seq, 5);
        registry.event(
            Some("c1"),
            &AgentEvent::Delta {
                content: "live-6".into(),
            },
        );
        let live = rx.recv().await.expect("live event");
        assert_eq!(live.seq, 6);
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
