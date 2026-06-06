use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use harness_automation::{AutomationRunStatus, AutomationTask};
use harness_core::{Conversation, ConversationMetadata, Message};
use tracing::{info, warn};

use crate::state::AppState;

const DEFAULT_TICK_SECONDS: u64 = 5;

/// Process-wide in-memory reservation set guarding against
/// double-firing the same automation.
///
/// The persisted `last_run_status == Running` flag alone cannot close
/// the window between a scheduler tick observing a task as due and the
/// spawned run asynchronously persisting `Running`: a second tick (or a
/// manual trigger) firing inside that window re-lists the still-due task
/// and spawns a duplicate run. This set is reserved **synchronously**
/// before `spawn_automation_run` (mirroring `auto_mode.rs`'s
/// `active_requirements`), so only one run per automation id can be
/// in flight at a time regardless of how slow the persisted write is.
#[derive(Debug, Clone, Default)]
pub struct AutomationClaims {
    active: Arc<Mutex<HashSet<String>>>,
}

impl AutomationClaims {
    /// Attempt to reserve `id`. Returns `Some(claim)` if the id was not
    /// already claimed; the reservation is released when the returned
    /// guard is dropped (i.e. when the spawned run terminates). Returns
    /// `None` if a run for this id is already in flight, or on lock
    /// poisoning (fail closed — better to skip than double-fire).
    pub(crate) fn try_claim(&self, id: &str) -> Option<AutomationRunClaim> {
        let mut active = self.active.lock().ok()?;
        if !active.insert(id.to_string()) {
            return None;
        }
        Some(AutomationRunClaim {
            id: id.to_string(),
            active: Arc::clone(&self.active),
        })
    }
}

/// RAII reservation handle. Held by the spawned run for its full
/// lifetime; `Drop` releases the id so the next tick can pick it up.
#[derive(Debug)]
pub(crate) struct AutomationRunClaim {
    id: String,
    active: Arc<Mutex<HashSet<String>>>,
}

impl Drop for AutomationRunClaim {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.id);
        }
    }
}

pub fn spawn_automation_scheduler(state: AppState) {
    let Some(store) = state.automations.clone() else {
        return;
    };
    let tick_seconds = std::env::var("JARVIS_AUTOMATION_TICK_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TICK_SECONDS)
        .max(1);
    info!(tick_seconds, "automation scheduler started");
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
            for task in tasks {
                if !task.is_due_at(now) {
                    continue;
                }
                // Reserve the id synchronously, before the spawn and
                // before the tick moves on. If a run is already in
                // flight (this tick, a prior tick whose `Running` write
                // hasn't landed yet, or a manual trigger) the claim
                // fails and we skip — closing the TOCTOU window the
                // persisted flag alone cannot.
                let Some(claim) = state.automation_claims.try_claim(&task.id) else {
                    continue;
                };
                spawn_automation_run(state.clone(), task, RunTrigger::Schedule, claim);
            }
        }
    });
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum RunTrigger {
    Schedule,
    Manual,
}

pub(crate) fn spawn_automation_run(
    state: AppState,
    mut task: AutomationTask,
    trigger: RunTrigger,
    claim: AutomationRunClaim,
) {
    let Some(store) = state.automations.clone() else {
        return;
    };
    tokio::spawn(async move {
        // Hold the reservation for the whole run; dropping it on exit
        // (success, early-return, or panic-unwind) releases the id for
        // the next tick.
        let _claim = claim;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_exclusive_per_id() {
        let claims = AutomationClaims::default();
        let first = claims.try_claim("auto-1").expect("first claim should win");
        assert!(
            claims.try_claim("auto-1").is_none(),
            "an in-flight automation cannot be claimed twice — closes the double-fire window"
        );
        // A different id is independent.
        let _other = claims.try_claim("auto-2").expect("distinct id is claimable");
        drop(first);
        assert!(
            claims.try_claim("auto-1").is_some(),
            "dropping the claim releases the id for the next tick"
        );
    }
}
