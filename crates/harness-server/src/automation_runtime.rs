use harness_automation::{AutomationRunStatus, AutomationTask};
use harness_core::{Conversation, ConversationMetadata, Message};
use tracing::{info, warn};

use crate::state::AppState;

const DEFAULT_TICK_SECONDS: u64 = 5;

/// Wall-clock budget, in milliseconds, after which a task still flagged
/// `Running` is assumed abandoned and reclaimed. Mirrors the auto loop's
/// `JARVIS_WORK_RUN_TIMEOUT_MS` (10 min) and the `× 3` safety multiplier it
/// applies to in-flight `Running` rows so a slow-but-healthy run is never
/// reaped out from under itself. Overridable via `JARVIS_AUTOMATION_RUN_TIMEOUT_MS`.
const DEFAULT_RUN_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const RUNNING_STALE_MULTIPLIER: u64 = 3;

pub fn spawn_automation_scheduler(state: AppState) {
    let Some(store) = state.automations.clone() else {
        return;
    };
    let tick_seconds = std::env::var("JARVIS_AUTOMATION_TICK_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TICK_SECONDS)
        .max(1);
    let run_timeout_ms = std::env::var("JARVIS_AUTOMATION_RUN_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_RUN_TIMEOUT_MS)
        .max(1);
    let stale_threshold_ms = run_timeout_ms.saturating_mul(RUNNING_STALE_MULTIPLIER);
    info!(
        tick_seconds,
        run_timeout_ms, stale_threshold_ms, "automation scheduler started"
    );
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(tick_seconds));
        loop {
            tick.tick().await;
            let now = chrono::Utc::now();
            let tasks = match store.list().await {
                Ok(tasks) => tasks,
                Err(error) => {
                    warn!(error = %error, "automation scheduler list failed");
                    continue;
                }
            };
            for mut task in tasks {
                // Reap tasks pinned in `Running` by a lost worker (restart,
                // cancellation, panic) before evaluating due-ness — without
                // this they never reschedule again.
                if task.is_stale_running(now, stale_threshold_ms) {
                    task.mark_stale_reclaimed(now);
                    match store.upsert(&task).await {
                        Ok(()) => warn!(
                            automation_id = %task.id,
                            stale_threshold_ms,
                            "automation reaped stale running task"
                        ),
                        Err(error) => {
                            warn!(
                                error = %error,
                                automation_id = %task.id,
                                "automation reaper could not persist reclamation"
                            );
                            continue;
                        }
                    }
                }
                if task.is_due_at(now) {
                    spawn_automation_run(state.clone(), task, RunTrigger::Schedule);
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum RunTrigger {
    Schedule,
    Manual,
}

pub(crate) fn spawn_automation_run(state: AppState, mut task: AutomationTask, trigger: RunTrigger) {
    let Some(store) = state.automations.clone() else {
        return;
    };
    tokio::spawn(async move {
        let now = chrono::Utc::now();
        match trigger {
            RunTrigger::Schedule => task.mark_running(now),
            RunTrigger::Manual => task.mark_manual_run_started(now),
        }
        if let Err(error) = store.upsert(&task).await {
            warn!(
                error = %error,
                automation_id = %task.id,
                "automation run could not mark running"
            );
            return;
        }

        let result = execute_task(&state, &task).await;
        let mut latest = match store.get(&task.id).await {
            Ok(Some(latest)) => latest,
            Ok(None) => return,
            Err(error) => {
                warn!(
                    error = %error,
                    automation_id = %task.id,
                    "automation run could not reload task"
                );
                task
            }
        };
        latest.mark_finished(chrono::Utc::now(), result);
        if let Err(error) = store.upsert(&latest).await {
            warn!(
                error = %error,
                automation_id = %latest.id,
                "automation run could not persist final status"
            );
        }
    });
}

async fn execute_task(state: &AppState, task: &AutomationTask) -> Result<(), String> {
    let agent = state
        .build_agent(task.provider.as_deref(), task.model.as_deref())
        .map_err(|error| error.to_string())?;
    let mut conversation = load_conversation(state, task).await?;
    conversation.push(Message::user(task.prompt.clone()));
    agent
        .run(&mut conversation)
        .await
        .map_err(|error| error.to_string())?;
    if let (Some(store), Some(id)) = (state.store.as_ref(), task.conversation_id.as_ref()) {
        store
            .save_envelope(id, &conversation, &ConversationMetadata::default())
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn load_conversation(
    state: &AppState,
    task: &AutomationTask,
) -> Result<Conversation, String> {
    let Some(id) = task.conversation_id.as_deref() else {
        return Ok(Conversation::new());
    };
    let Some(store) = state.store.as_ref() else {
        return Ok(Conversation::new());
    };
    store
        .load(id)
        .await
        .map_err(|error| error.to_string())
        .map(|conv| conv.unwrap_or_default())
}

pub(crate) fn is_running(task: &AutomationTask) -> bool {
    task.last_run_status == Some(AutomationRunStatus::Running)
}
