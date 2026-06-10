//! `GET /v1/tasks` — unified background-tasks panel feed.
//!
//! The UI's BackgroundTasksPanel needs one place to see *every*
//! kind of long-running work the server is currently handling: chat
//! turns mid-stream, subagent runs in flight, auto-mode requirement
//! picks, future shell/MCP entries. Rather than have the UI call
//! three endpoints and reconcile them, this route normalises each
//! source into a single `TaskEntry` shape sorted newest-first.
//!
//! v1 sources (more can be added without breaking the wire shape —
//! each entry's `kind` discriminator lets the UI render new types
//! progressively):
//!
//! - `chat_run`     — from [`crate::chat_runs::ChatRunRegistry`]
//! - `subagent_run` — from [`crate::subagent_runs::SubAgentRunRegistry`]
//!
//! Filtering: only entries with a still-active lifecycle status
//! appear (running / waiting_*); completed / failed / cancelled
//! runs are surfaced through their dedicated detail endpoints. The
//! panel is "what's in flight right now", not a history view.

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use harness_automation::AutomationRunStatus;
use harness_project::RequirementRunStatus;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_runs::ChatRunStatus;
use crate::state::AppState;
use crate::subagent_runs::SubAgentRunStatus;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/v1/tasks", get(list_tasks))
}

/// One normalised entry across kinds. `kind` is the source
/// discriminator and `id` is unique within that kind. `label` is
/// the one-line UI string; `detail` carries the raw record so a
/// click-into-detail UI can pivot without a second fetch.
#[derive(Debug, Serialize)]
pub struct TaskEntry {
    pub kind: TaskKind,
    pub id: String,
    pub label: String,
    pub status: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub detail: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    ChatRun,
    SubagentRun,
    RequirementRun,
    McpServer,
    AutomationRun,
}

#[derive(Debug, Serialize)]
struct TasksResponse {
    items: Vec<TaskEntry>,
    /// Server clock at snapshot time (ms since epoch). Lets the UI
    /// render relative "started 30s ago" without trusting the
    /// client wall clock.
    generated_at: u64,
}

/// Optional query filters for the tasks endpoint. v1 supports
/// `?conversation=<id>` so reconnecting WS clients can ask "is the
/// run for this conversation still in flight?" without sifting
/// through every running task in the org.
#[derive(Debug, Default, Deserialize)]
pub struct TasksQuery {
    /// When set, only entries tied to this conversation id are
    /// returned. Matches `chat_run.id` directly; matches
    /// `subagent_run` / `requirement_run` via their detail payload
    /// when those records carry `conversation_id`. MCP entries are
    /// always elided when this filter is active (they're not
    /// conversation-scoped).
    pub conversation: Option<String>,
}

async fn list_tasks(
    State(state): State<AppState>,
    Query(query): Query<TasksQuery>,
) -> impl IntoResponse {
    let mut items = collect_tasks(&state).await;
    if let Some(conv) = query.conversation.as_deref() {
        items.retain(|t| task_matches_conversation(t, conv));
    }
    Json(TasksResponse {
        items,
        generated_at: now_ms(),
    })
}

/// Whether a `TaskEntry` is scoped to the requested conversation id.
/// Chat runs match by `id` (the id is the conversation id today);
/// subagent / requirement runs check `detail.conversation_id` when
/// present; MCP entries never match (they're cross-conversation
/// infrastructure).
fn task_matches_conversation(task: &TaskEntry, conversation_id: &str) -> bool {
    match task.kind {
        TaskKind::ChatRun => task.id == conversation_id,
        TaskKind::SubagentRun | TaskKind::RequirementRun => task
            .detail
            .get("conversation_id")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v == conversation_id),
        TaskKind::McpServer | TaskKind::AutomationRun => false,
    }
}

/// Build a snapshot of the current `TaskEntry` set from every
/// configured source. Pulled out of [`list_tasks`] so the future
/// WS push path can call it on a timer / event without going
/// through HTTP.
pub(crate) async fn collect_tasks(state: &AppState) -> Vec<TaskEntry> {
    let mut items: Vec<TaskEntry> = Vec::new();

    // Chat runs — always available; filter to active states.
    let chat_runs = state.chat_runs.list(/* active_only */ true);
    for r in chat_runs {
        let active = matches!(
            r.status,
            ChatRunStatus::Running | ChatRunStatus::WaitingApproval | ChatRunStatus::WaitingHitl
        );
        if !active {
            continue;
        }
        let status = match r.status {
            ChatRunStatus::Running => "running",
            ChatRunStatus::WaitingApproval => "waiting_approval",
            ChatRunStatus::WaitingHitl => "waiting_hitl",
            ChatRunStatus::Completed => "completed",
            ChatRunStatus::Failed => "failed",
            ChatRunStatus::Cancelled => "cancelled",
        };
        let label = match r.current_tool.as_deref() {
            Some(tool) => format!("Chat · running {tool}"),
            None => "Chat turn".to_string(),
        };
        items.push(TaskEntry {
            kind: TaskKind::ChatRun,
            id: r.conversation_id.clone(),
            label,
            status: status.to_string(),
            started_at: r.started_at,
            updated_at: r.updated_at,
            detail: serde_json::to_value(&r).unwrap_or(Value::Null),
        });
    }

    // Subagent runs — optional registry.
    if let Some(reg) = state.subagent_runs.as_ref() {
        for r in reg.list() {
            if !matches!(r.status, SubAgentRunStatus::Running) {
                continue;
            }
            // Compose a concise label: "<name>: <task-head>" with
            // the task truncated so the panel row stays readable.
            let task_head = r.task.as_deref().unwrap_or("");
            // Truncate by char count, not byte index — a raw byte slice
            // panics when byte 47 splits a multibyte char (CJK, emoji),
            // and this runs inside the WS turn-terminal handler.
            let task_short = if task_head.chars().count() > 48 {
                format!("{}…", task_head.chars().take(47).collect::<String>())
            } else {
                task_head.to_string()
            };
            let label = if task_short.is_empty() {
                r.name.clone()
            } else {
                format!("{}: {}", r.name, task_short)
            };
            items.push(TaskEntry {
                kind: TaskKind::SubagentRun,
                id: r.id.clone(),
                label,
                status: "running".into(),
                started_at: r.started_at,
                updated_at: r.updated_at,
                detail: serde_json::to_value(&r).unwrap_or(Value::Null),
            });
        }
    }

    // Requirement runs (auto-mode picks + manual `start_run`).
    // We only surface still-in-flight rows. Listing through the
    // store is bounded (the trait caps `list_all` at ~200), so
    // even a noisy run history doesn't bloat the panel.
    if let Some(store) = state.requirement_runs.as_ref() {
        if let Ok(rows) = store.list_all(200).await {
            for r in rows {
                if !matches!(
                    r.status,
                    RequirementRunStatus::Pending | RequirementRunStatus::Running
                ) {
                    continue;
                }
                let status = match r.status {
                    RequirementRunStatus::Pending => "pending",
                    RequirementRunStatus::Running => "running",
                    RequirementRunStatus::Completed => "completed",
                    RequirementRunStatus::Failed => "failed",
                    RequirementRunStatus::Cancelled => "cancelled",
                };
                let label = format!("Requirement {} · {}", r.requirement_id, status);
                // `RequirementRun.started_at` is an RFC-3339 string
                // (the row gets persisted across processes); parse to
                // millis for the panel sort. Fall back to now() when
                // a row predates the timestamp convention.
                let started_ms = parse_rfc3339_ms(&r.started_at).unwrap_or_else(now_ms);
                let updated_ms = r
                    .finished_at
                    .as_deref()
                    .and_then(parse_rfc3339_ms)
                    .unwrap_or(started_ms);
                items.push(TaskEntry {
                    kind: TaskKind::RequirementRun,
                    id: r.id.clone(),
                    label,
                    status: status.to_string(),
                    started_at: started_ms,
                    updated_at: updated_ms,
                    detail: serde_json::to_value(&r).unwrap_or(Value::Null),
                });
            }
        }
    }

    // MCP server health — surface unhealthy / stopped servers as
    // "tasks" so the operator can spot a wedged tool source. We
    // omit cleanly-running servers from the panel: they aren't
    // pending work, they're idle infrastructure.
    if let Some(mgr) = state.mcp.as_ref() {
        for s in mgr.list().await {
            use harness_mcp::manager::McpServerStatus;
            if matches!(s.status, McpServerStatus::Running) {
                continue;
            }
            let (status, label) = match s.status {
                McpServerStatus::Stopped => ("stopped", format!("MCP {} · stopped", s.prefix)),
                McpServerStatus::Unhealthy => {
                    ("unhealthy", format!("MCP {} · unhealthy", s.prefix))
                }
                McpServerStatus::Running => unreachable!(),
            };
            // MCP servers don't have a meaningful timestamp on
            // McpServerInfo today; pin to now() so they sort to
            // the head only when freshly broken. We may extend
            // McpServerInfo later with a last_status_at field.
            let now = now_ms();
            items.push(TaskEntry {
                kind: TaskKind::McpServer,
                id: s.prefix.clone(),
                label,
                status: status.to_string(),
                started_at: now,
                updated_at: now,
                detail: serde_json::to_value(&s).unwrap_or(Value::Null),
            });
        }
    }

    if let Some(store) = state.automations.as_ref() {
        if let Ok(rows) = store.list().await {
            for task in rows {
                if task.last_run_status != Some(AutomationRunStatus::Running) {
                    continue;
                }
                let started_ms = task
                    .last_run_at
                    .as_deref()
                    .and_then(parse_rfc3339_ms)
                    .unwrap_or_else(now_ms);
                items.push(TaskEntry {
                    kind: TaskKind::AutomationRun,
                    id: task.id.clone(),
                    label: format!("Automation · {}", task.title),
                    status: "running".into(),
                    started_at: started_ms,
                    updated_at: parse_rfc3339_ms(&task.updated_at).unwrap_or(started_ms),
                    detail: serde_json::to_value(&task).unwrap_or(Value::Null),
                });
            }
        }
    }

    // Newest first across kinds so a fresh task lands at the top
    // regardless of where it came from.
    items.sort_by_key(|t| std::cmp::Reverse(t.started_at));
    items
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse an RFC-3339 / ISO-8601 timestamp into ms since epoch.
/// Returns `None` on any parse failure so callers can fall back
/// cleanly. Used to normalise persisted run-store timestamps onto
/// the same axis as the in-memory chat / subagent registries.
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis().max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    /// Minimal stub provider; the tasks endpoint never reaches the
    /// agent so any never-call provider works here.
    struct StubLlm;
    #[async_trait::async_trait]
    impl harness_core::LlmProvider for StubLlm {
        async fn complete(
            &self,
            _: harness_core::ChatRequest,
        ) -> Result<harness_core::ChatResponse, harness_core::Error> {
            Err(harness_core::Error::Provider("stub".into()))
        }
    }

    fn mk_state() -> AppState {
        use harness_core::{Agent, AgentConfig};
        let cfg = AgentConfig::new("stub-model");
        let agent = Arc::new(Agent::new(Arc::new(StubLlm) as _, cfg));
        AppState::new(agent)
    }

    async fn read_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn empty_state_returns_empty_items() {
        let state = mk_state();
        let resp = list_tasks(State(state), Query(TasksQuery::default()))
            .await
            .into_response();
        let body = read_json(resp).await;
        assert!(body["items"].as_array().unwrap().is_empty());
        assert!(body["generated_at"].as_u64().is_some());
    }

    #[tokio::test]
    async fn active_chat_run_surfaces() {
        let state = mk_state();
        state.chat_runs.start("conv-123");
        let resp = list_tasks(State(state), Query(TasksQuery::default()))
            .await
            .into_response();
        let body = read_json(resp).await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "expected 1 task, got: {items:?}");
        assert_eq!(items[0]["kind"], "chat_run");
        assert_eq!(items[0]["id"], "conv-123");
        assert_eq!(items[0]["status"], "running");
    }

    #[tokio::test]
    async fn multibyte_task_name_does_not_panic() {
        // Regression: the task label was truncated with a raw byte
        // slice, which panics when byte 47 splits a multibyte char.
        // The task text is LLM/agent-supplied, so a long CJK task name
        // must not crash GET /v1/tasks (and, transitively, the WS).
        use crate::subagent_runs::SubAgentRunRegistry;
        use harness_core::subagent::{SubAgentEvent, SubAgentFrame};

        let runs = SubAgentRunRegistry::new();
        // 60 CJK chars = 180 bytes; byte index 47 lands mid-character.
        let task = "验证代码变更并运行测试套件确保一切正常工作完成质量检查任务".repeat(2);
        assert!(task.len() > 48 && !task.is_char_boundary(47));
        runs.record_frame(
            Some("conv-cjk"),
            &SubAgentFrame {
                subagent_id: "sub-1".into(),
                subagent_name: "review".into(),
                event: SubAgentEvent::Started {
                    task: task.clone(),
                    model: None,
                },
            },
        );
        let state = mk_state().with_subagent_runs(runs);
        let resp = list_tasks(State(state), Query(TasksQuery::default()))
            .await
            .into_response();
        let body = read_json(resp).await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "expected the subagent run, got: {items:?}");
        assert_eq!(items[0]["kind"], "subagent_run");
        // Label is truncated to 47 chars + ellipsis, on a char boundary.
        let label = items[0]["label"].as_str().unwrap();
        assert!(label.ends_with('…'), "expected ellipsis, got: {label}");
    }

    #[tokio::test]
    async fn completed_chat_run_does_not_surface() {
        let state = mk_state();
        state.chat_runs.start("conv-done");
        // `event` with a Done event flips to completed.
        let done = harness_core::AgentEvent::Done {
            outcome: harness_core::RunOutcome::Stopped { iterations: 1 },
            conversation: harness_core::Conversation::new(),
        };
        state.chat_runs.event(Some("conv-done"), &done);
        let resp = list_tasks(State(state), Query(TasksQuery::default()))
            .await
            .into_response();
        let body = read_json(resp).await;
        assert!(
            body["items"].as_array().unwrap().is_empty(),
            "completed run leaked into tasks: {body}"
        );
    }

    #[tokio::test]
    async fn conversation_filter_keeps_matching_chat_run_and_drops_others() {
        let state = mk_state();
        state.chat_runs.start("conv-keep");
        state.chat_runs.start("conv-drop");
        let resp = list_tasks(
            State(state),
            Query(TasksQuery {
                conversation: Some("conv-keep".into()),
            }),
        )
        .await
        .into_response();
        let body = read_json(resp).await;
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "filter should keep only conv-keep");
        assert_eq!(items[0]["id"], "conv-keep");
    }

    #[tokio::test]
    async fn conversation_filter_returns_empty_when_no_match() {
        let state = mk_state();
        state.chat_runs.start("conv-a");
        let resp = list_tasks(
            State(state),
            Query(TasksQuery {
                conversation: Some("conv-other".into()),
            }),
        )
        .await
        .into_response();
        let body = read_json(resp).await;
        assert!(body["items"].as_array().unwrap().is_empty());
    }
}
