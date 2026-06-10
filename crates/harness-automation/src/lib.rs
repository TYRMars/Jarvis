use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use harness_core::BoxError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduleSpec,
    #[serde(default)]
    pub status: AutomationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<AutomationRunStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_count: u64,
}

impl AutomationTask {
    pub fn new(input: NewAutomationTask) -> Self {
        let now = Utc::now();
        let next_run_at = input.schedule.next_after(None, now).map(to_rfc3339);
        Self {
            id: Uuid::new_v4().to_string(),
            title: input.title,
            prompt: input.prompt,
            schedule: input.schedule,
            status: input.status.unwrap_or_default(),
            provider: input.provider,
            model: input.model,
            conversation_id: input.conversation_id,
            created_at: to_rfc3339(now),
            updated_at: to_rfc3339(now),
            last_run_at: None,
            next_run_at,
            last_run_status: None,
            last_error: None,
            run_count: 0,
        }
    }

    pub fn is_due_at(&self, now: DateTime<Utc>) -> bool {
        self.status == AutomationStatus::Enabled
            && self.last_run_status != Some(AutomationRunStatus::Running)
            && self
                .next_run_at
                .as_deref()
                .and_then(parse_rfc3339)
                .is_some_and(|next| next <= now)
    }

    pub fn mark_running(&mut self, now: DateTime<Utc>) {
        self.last_run_at = Some(to_rfc3339(now));
        self.next_run_at = self.schedule.next_after(Some(now), now).map(to_rfc3339);
        self.last_run_status = Some(AutomationRunStatus::Running);
        self.last_error = None;
        self.updated_at = to_rfc3339(now);
    }

    pub fn mark_manual_run_started(&mut self, now: DateTime<Utc>) {
        self.last_run_at = Some(to_rfc3339(now));
        // Advance next_run_at the same way the scheduled path does, otherwise the
        // scheduler sees a non-Running task still due at/before `now` and fires it a
        // second time (a Once task runs twice; an Interval task re-fires immediately).
        self.next_run_at = self.schedule.next_after(Some(now), now).map(to_rfc3339);
        self.last_run_status = Some(AutomationRunStatus::Running);
        self.last_error = None;
        self.updated_at = to_rfc3339(now);
    }

    pub fn mark_finished(&mut self, now: DateTime<Utc>, result: Result<(), String>) {
        self.updated_at = to_rfc3339(now);
        self.run_count = self.run_count.saturating_add(1);
        match result {
            Ok(()) => {
                self.last_run_status = Some(AutomationRunStatus::Succeeded);
                self.last_error = None;
            }
            Err(error) => {
                self.last_run_status = Some(AutomationRunStatus::Failed);
                self.last_error = Some(error);
            }
        }
    }

    pub fn recompute_next_run(&mut self, now: DateTime<Utc>) {
        self.next_run_at = self.schedule.next_after(None, now).map(to_rfc3339);
        self.updated_at = to_rfc3339(now);
    }
}

#[derive(Debug, Clone)]
pub struct NewAutomationTask {
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduleSpec,
    pub status: Option<AutomationStatus>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleSpec {
    Once {
        run_at: String,
    },
    Interval {
        every_seconds: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_at: Option<String>,
    },
}

impl ScheduleSpec {
    pub fn next_after(
        &self,
        previous_run_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        match self {
            Self::Once { run_at } => {
                let run_at = parse_rfc3339(run_at)?;
                if previous_run_at.is_some() {
                    None
                } else {
                    Some(run_at)
                }
            }
            Self::Interval {
                every_seconds,
                start_at,
            } => {
                let seconds = (*every_seconds).max(1);
                let interval = Duration::seconds(seconds as i64);
                let mut next = previous_run_at
                    .map(|t| t + interval)
                    .or_else(|| start_at.as_deref().and_then(parse_rfc3339))
                    .unwrap_or(now + interval);
                while next <= now {
                    next += interval;
                }
                Some(next)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStatus {
    #[default]
    Enabled,
    Paused,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Running,
    Succeeded,
    Failed,
}

#[async_trait]
pub trait AutomationStore: Send + Sync {
    async fn list(&self) -> Result<Vec<AutomationTask>, BoxError>;
    async fn get(&self, id: &str) -> Result<Option<AutomationTask>, BoxError>;
    async fn upsert(&self, task: &AutomationTask) -> Result<(), BoxError>;
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;
}

pub fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

pub fn to_rfc3339(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, thiserror::Error)]
pub enum AutomationError {
    #[error("invalid schedule: {0}")]
    InvalidSchedule(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_skips_missed_ticks() {
        let schedule = ScheduleSpec::Interval {
            every_seconds: 60,
            start_at: Some("2026-01-01T00:00:00Z".into()),
        };
        let now = parse_rfc3339("2026-01-01T00:03:30Z").unwrap();
        let next = schedule.next_after(None, now).unwrap();
        assert_eq!(to_rfc3339(next), "2026-01-01T00:04:00.000Z");
    }

    #[test]
    fn once_has_no_next_after_run() {
        let schedule = ScheduleSpec::Once {
            run_at: "2026-01-01T00:00:00Z".into(),
        };
        let now = parse_rfc3339("2026-01-01T00:00:01Z").unwrap();
        assert!(schedule.next_after(Some(now), now).is_none());
    }

    #[test]
    fn manual_run_clears_next_run_at_for_once_task() {
        // A Once task manually run before its run_at must not fire again when run_at arrives.
        let mut task = AutomationTask::new(NewAutomationTask {
            title: "once".into(),
            prompt: "do it".into(),
            schedule: ScheduleSpec::Once {
                run_at: "2026-01-01T01:00:00Z".into(),
            },
            status: None,
            provider: None,
            model: None,
            conversation_id: None,
        });
        assert_eq!(task.next_run_at.as_deref(), Some("2026-01-01T01:00:00.000Z"));

        let now = parse_rfc3339("2026-01-01T00:30:00Z").unwrap();
        task.mark_manual_run_started(now);
        task.mark_finished(now, Ok(()));

        // Once finished, the once-task has no next run, so it never re-fires.
        assert!(task.next_run_at.is_none());
        let run_at = parse_rfc3339("2026-01-01T01:00:00Z").unwrap();
        assert!(!task.is_due_at(run_at));
    }

    #[test]
    fn manual_run_advances_next_run_at_for_interval_task() {
        // An Interval task manually run at/past its scheduled time must not re-fire on the next tick.
        let mut task = AutomationTask::new(NewAutomationTask {
            title: "interval".into(),
            prompt: "do it".into(),
            schedule: ScheduleSpec::Interval {
                every_seconds: 60,
                start_at: Some("2026-01-01T00:00:00Z".into()),
            },
            status: None,
            provider: None,
            model: None,
            conversation_id: None,
        });

        let now = parse_rfc3339("2026-01-01T00:00:00Z").unwrap();
        task.mark_manual_run_started(now);
        task.mark_finished(now, Ok(()));

        // next_run_at advanced one interval into the future, so it is not due immediately.
        assert_eq!(task.next_run_at.as_deref(), Some("2026-01-01T00:01:00.000Z"));
        assert!(!task.is_due_at(now));
        let next_tick = parse_rfc3339("2026-01-01T00:01:00Z").unwrap();
        assert!(task.is_due_at(next_tick));
    }
}
