use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use harness_core::AgentEvent;
use serde::Serialize;
use serde_json::Value;

const MAX_EVENTS_PER_RUN: usize = 1_000;

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

#[derive(Debug, Clone)]
struct ChatRunState {
    record: ChatRunRecord,
    events: Vec<ChatRunEventRecord>,
    next_seq: u64,
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
            guard.insert(
                conversation_id.to_string(),
                ChatRunState {
                    record,
                    events: Vec::new(),
                    next_seq: 1,
                },
            );
        }
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
            let state = guard.entry(conversation_id.to_string()).or_insert_with(|| {
                let record = ChatRunRecord {
                    conversation_id: conversation_id.to_string(),
                    status,
                    started_at: now,
                    updated_at: now,
                    latest_seq: 0,
                    current_tool: None,
                    last_error: None,
                };
                ChatRunState {
                    record,
                    events: Vec::new(),
                    next_seq: 1,
                }
            });
            state.record.status = status;
            state.record.updated_at = now;
            if let Some(tool) = current_tool {
                state.record.current_tool = tool;
            }
            if let Some(err) = last_error {
                state.record.last_error = err;
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
            let state = guard.entry(conversation_id.to_string()).or_insert_with(|| {
                let record = ChatRunRecord {
                    conversation_id: conversation_id.to_string(),
                    status: status
                        .as_ref()
                        .map(|(s, _, _)| *s)
                        .unwrap_or(ChatRunStatus::Running),
                    started_at: now,
                    updated_at: now,
                    latest_seq: 0,
                    current_tool: None,
                    last_error: None,
                };
                ChatRunState {
                    record,
                    events: Vec::new(),
                    next_seq: 1,
                }
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
            state.events.push(ChatRunEventRecord {
                conversation_id: conversation_id.to_string(),
                seq,
                timestamp: now,
                frame,
            });
            if state.events.len() > MAX_EVENTS_PER_RUN {
                let excess = state.events.len() - MAX_EVENTS_PER_RUN;
                state.events.drain(0..excess);
            }
            if state.record.status.is_terminal() {
                if let Ok(mut aborts) = self.aborts.write() {
                    aborts.remove(conversation_id);
                }
            }
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
}
