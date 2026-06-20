//! Declarative, multi-step agent **workflows** for the Jarvis harness.
//!
//! A [`WorkflowDefinition`] is a reusable recipe: an ordered list of
//! [`WorkflowStep`]s that a server-side runtime executes by driving the
//! existing agent loop (and, later, the subagent registry). It is the
//! structured evolution of the single-string `workflow_prompt` seed that
//! `harness-server`'s auto loop reads from `WORKFLOW.md`: instead of one
//! undifferentiated turn, a workflow expresses *research → implement →
//! verify* as discrete steps with handoff between them.
//!
//! The step vocabulary mirrors Claude Code's `Workflow` primitives so the
//! mental model transfers:
//!
//! - [`WorkflowStepKind::Agent`]  ≈ `agent(prompt, …)` — one agent step.
//! - [`WorkflowStepKind::Pipeline`] ≈ `pipeline(…)` — sequential, the
//!   output of step N is threaded into step N+1.
//! - [`WorkflowStepKind::Phase`] ≈ `phase(title)` — a labelled sequential
//!   group (progress boundary).
//! - [`WorkflowStepKind::Parallel`] ≈ `parallel([…])` — fan-out with a
//!   join policy.
//!
//! A [`WorkflowDefinition`] can be **bound to a `Requirement`** (via the
//! requirement's `workflow_id`); executing the requirement then runs the
//! whole recipe. Each execution attempt is a [`WorkflowRun`] with per-step
//! [`WorkflowStepResult`]s.
//!
//! This crate is a true leaf: value types + the [`WorkflowStore`] trait,
//! depending only on `harness-core` (for [`BoxError`]). It owns no HTTP,
//! storage, or execution logic — `harness-store` provides backends and
//! `harness-server` provides the runtime. The wire-shape types that cross the
//! SPA boundary now live in the Node `@jarvis/shared-types` package (the
//! single source of truth); these Rust structs only need to serialise to the
//! same JSON shape.

use async_trait::async_trait;
use harness_core::BoxError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------- WorkflowDefinition --------------------------------------------

/// A reusable, multi-step agent recipe.
///
/// The wire shape matches the JSON serialisation of this struct. Newer
/// fields are added with `#[serde(default, skip_serializing_if = …)]` so
/// older rows on disk keep deserialising.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    /// Stable identifier (UUID v4 string), server-allocated.
    pub id: String,
    /// Optional [`Project`](harness_core) scope. `None` = a global
    /// workflow not tied to a single project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Human label shown in catalogues and pickers.
    pub name: String,
    /// Optional longer description of what the recipe does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Ordered top-level steps. Executed in sequence; nested
    /// [`WorkflowStepKind::Parallel`] introduces concurrency.
    #[serde(default)]
    pub steps: Vec<WorkflowStep>,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 timestamp; bumped on every mutation via [`Self::touch`].
    pub updated_at: String,
}

impl WorkflowDefinition {
    /// Mint a new definition with a fresh UUID and current timestamps.
    pub fn new(name: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: Uuid::new_v4().to_string(),
            project_id: None,
            name: name.into(),
            description: None,
            steps: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Depth-first count of every leaf [`WorkflowStepKind::Agent`] step.
    /// Used by REST validation to reject empty recipes.
    pub fn agent_step_count(&self) -> usize {
        fn walk(steps: &[WorkflowStep]) -> usize {
            steps
                .iter()
                .map(|s| match &s.kind {
                    WorkflowStepKind::Agent { .. } => 1,
                    WorkflowStepKind::Pipeline { steps }
                    | WorkflowStepKind::Phase { steps, .. }
                    | WorkflowStepKind::Parallel { steps, .. } => walk(steps),
                })
                .sum()
        }
        walk(&self.steps)
    }
}

// ---------- WorkflowStep --------------------------------------------------

/// One node in a [`WorkflowDefinition`]. Carries presentation metadata
/// (`id`, `name`) plus the executable [`WorkflowStepKind`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowStep {
    /// Stable id within the definition (UUID v4). Referenced by
    /// [`WorkflowStepResult::step_id`].
    pub id: String,
    /// Short label for the step.
    pub name: String,
    /// What the step actually does.
    pub kind: WorkflowStepKind,
}

impl WorkflowStep {
    /// Mint a step with a fresh id.
    pub fn new(name: impl Into<String>, kind: WorkflowStepKind) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            kind,
        }
    }
}

/// The executable shape of a [`WorkflowStep`]. Externally tagged on
/// `type` so the wire form is a discriminated union the SPA can switch on
/// (`{"type":"agent",…}` / `{"type":"pipeline",…}` / …).
///
/// Recursive: `Pipeline` / `Phase` / `Parallel` nest further steps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowStepKind {
    /// One agent step. The runtime mints a fresh conversation, sends
    /// `prompt` (after interpolating `{{ prev }}` / `{{ outputs.<key> }}`),
    /// and captures the final assistant text as this step's output.
    Agent {
        /// Step instruction. Supports `{{ prev }}` (previous step output)
        /// and `{{ outputs.<key> }}` (any prior step's `output_key`).
        prompt: String,
        /// Optional `subagent.<name>` to delegate to. `None` runs the
        /// main agent loop. (Executor: subagent path is forward-compat.)
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<String>,
        /// Optional per-step model override (else the run's default).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Optional name to record this step's output under, so later
        /// steps can interpolate `{{ outputs.<key> }}`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_key: Option<String>,
    },
    /// Sequential group. Children run in order; each child's output is
    /// threaded forward as `{{ prev }}` to the next.
    Pipeline {
        #[serde(default)]
        steps: Vec<WorkflowStep>,
    },
    /// Labelled sequential group — a progress boundary. Behaves like
    /// `Pipeline` but emits a phase marker.
    Phase {
        title: String,
        #[serde(default)]
        steps: Vec<WorkflowStep>,
    },
    /// Concurrent fan-out. Children run in parallel (bounded by the
    /// runtime's concurrency cap); [`JoinPolicy`] decides failure
    /// handling.
    Parallel {
        #[serde(default)]
        steps: Vec<WorkflowStep>,
        #[serde(default)]
        join: JoinPolicy,
    },
}

/// How a [`WorkflowStepKind::Parallel`] group treats child failures.
/// Mirrors the semantics of `harness_subagents::JoinStrategy` without a
/// hard dependency (this value crate stays a `harness-core`-only leaf;
/// the server runtime maps between the two).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinPolicy {
    /// Every child must succeed; the first failure fails the whole run.
    #[default]
    AllRequired,
    /// Collect whatever succeeds; child failures are recorded but do not
    /// fail the run.
    BestEffort,
}

impl JoinPolicy {
    /// Parse a wire string. `None` for unrecognised values; REST handlers
    /// turn that into a 400.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "all_required" => Self::AllRequired,
            "best_effort" => Self::BestEffort,
            _ => return None,
        })
    }

    /// Wire form (snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::AllRequired => "all_required",
            Self::BestEffort => "best_effort",
        }
    }
}

// ---------- WorkflowRun ----------------------------------------------------

/// One execution attempt against a [`WorkflowDefinition`].
///
/// Sibling to `harness_project::RequirementRun`: that records one
/// single-agent run; this records a *multi-step* run, one
/// [`WorkflowStepResult`] per leaf step executed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRun {
    /// Stable identifier (UUID v4).
    pub id: String,
    /// The definition this run executed.
    pub workflow_id: String,
    /// Optional [`Requirement`](harness_project) this run was bound to.
    /// `None` for ad-hoc runs not tied to a kanban card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    /// Lifecycle state.
    pub status: WorkflowRunStatus,
    /// Per-step results in execution order.
    #[serde(default)]
    pub step_results: Vec<WorkflowStepResult>,
    /// Free-form error string when the run failed before / between steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// RFC-3339 timestamp of run creation.
    pub started_at: String,
    /// RFC-3339 timestamp of completion. `None` while in flight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl WorkflowRun {
    /// Mint a new run with a fresh UUID, current timestamp, and status
    /// [`WorkflowRunStatus::Running`] (runs are dispatched immediately).
    pub fn new(workflow_id: impl Into<String>, requirement_id: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            workflow_id: workflow_id.into(),
            requirement_id,
            status: WorkflowRunStatus::Running,
            step_results: Vec::new(),
            error: None,
            started_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
        }
    }

    /// Mark the run finished (terminal status + `finished_at`). Terminal
    /// status is sticky — a late call does not overwrite an existing
    /// terminal status.
    pub fn finish(&mut self, status: WorkflowRunStatus) {
        if !self.status.is_terminal() {
            self.status = status;
        }
        self.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }

    /// Append a step result.
    pub fn push_step(&mut self, result: WorkflowStepResult) {
        self.step_results.push(result);
    }
}

/// Result of executing one leaf [`WorkflowStep`] within a
/// [`WorkflowRun`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowStepResult {
    /// The [`WorkflowStep::id`] this result corresponds to.
    pub step_id: String,
    /// Step label, denormalised so a client can render without the
    /// definition.
    pub name: String,
    /// Terminal state of the step.
    pub status: WorkflowRunStatus,
    /// Conversation that drove the step (for drill-down). `None` for
    /// steps that never reached the agent loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Final assistant text — also the handoff value for `{{ prev }}` /
    /// `{{ outputs.<key> }}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Error string if the step failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl WorkflowStepResult {
    /// A successful step result.
    pub fn ok(step: &WorkflowStep, conversation_id: Option<String>, output: String) -> Self {
        Self {
            step_id: step.id.clone(),
            name: step.name.clone(),
            status: WorkflowRunStatus::Succeeded,
            conversation_id,
            output: Some(output),
            error: None,
        }
    }

    /// A failed step result.
    pub fn failed(step: &WorkflowStep, conversation_id: Option<String>, error: String) -> Self {
        Self {
            step_id: step.id.clone(),
            name: step.name.clone(),
            status: WorkflowRunStatus::Failed,
            conversation_id,
            output: None,
            error: Some(error),
        }
    }
}

/// Lifecycle of a [`WorkflowRun`] (and the terminal state of a
/// [`WorkflowStepResult`]). Serialised snake_case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRunStatus {
    /// Created but not yet started.
    Pending,
    /// In flight.
    Running,
    /// Finished cleanly.
    Succeeded,
    /// Finished with an error.
    Failed,
    /// Stopped before finishing.
    Cancelled,
}

impl WorkflowRunStatus {
    /// Parse a wire string. `None` for unrecognised values.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    /// Wire form (snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// Terminal states cannot transition further.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

// ---------- WorkflowStore --------------------------------------------------

/// Persistence for [`WorkflowDefinition`]s and their [`WorkflowRun`]s.
///
/// One trait covers both because runs live beside the definition they
/// belong to (the same way `RequirementRun` rows hang off a
/// `Requirement`). Backends live in `harness-store`.
#[async_trait]
pub trait WorkflowStore: Send + Sync {
    /// All definitions, newest-first is not required.
    async fn list(&self) -> Result<Vec<WorkflowDefinition>, BoxError>;
    /// Fetch one definition by id. `Ok(None)` when absent.
    async fn get(&self, id: &str) -> Result<Option<WorkflowDefinition>, BoxError>;
    /// Create or replace a definition (last-write-wins).
    async fn upsert(&self, def: &WorkflowDefinition) -> Result<(), BoxError>;
    /// Remove a definition. `Ok(false)` when it didn't exist.
    async fn delete(&self, id: &str) -> Result<bool, BoxError>;

    /// Runs, optionally filtered by `workflow_id` and/or
    /// `requirement_id` (both `None` = every run).
    async fn list_runs(
        &self,
        workflow_id: Option<&str>,
        requirement_id: Option<&str>,
    ) -> Result<Vec<WorkflowRun>, BoxError>;
    /// Fetch one run by id. `Ok(None)` when absent.
    async fn get_run(&self, run_id: &str) -> Result<Option<WorkflowRun>, BoxError>;
    /// Create or replace a run.
    async fn upsert_run(&self, run: &WorkflowRun) -> Result<(), BoxError>;
}

/// Errors surfaced when validating workflow definitions.
#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    /// A definition had no executable steps.
    #[error("workflow must contain at least one agent step")]
    Empty,
    /// A step carried an empty prompt.
    #[error("agent step '{0}' has an empty prompt")]
    EmptyPrompt(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_definition() -> WorkflowDefinition {
        let mut def = WorkflowDefinition::new("ship-feature");
        def.description = Some("research → implement → verify".into());
        def.steps = vec![
            WorkflowStep::new(
                "research",
                WorkflowStepKind::Agent {
                    prompt: "Investigate the codebase".into(),
                    subagent: None,
                    model: None,
                    output_key: Some("research".into()),
                },
            ),
            WorkflowStep::new(
                "build",
                WorkflowStepKind::Phase {
                    title: "Implement".into(),
                    steps: vec![WorkflowStep::new(
                        "edit",
                        WorkflowStepKind::Agent {
                            prompt: "Apply the change using {{ outputs.research }}".into(),
                            subagent: None,
                            model: Some("gpt-4o".into()),
                            output_key: None,
                        },
                    )],
                },
            ),
            WorkflowStep::new(
                "verify",
                WorkflowStepKind::Parallel {
                    steps: vec![
                        WorkflowStep::new(
                            "tests",
                            WorkflowStepKind::Agent {
                                prompt: "Run the tests".into(),
                                subagent: None,
                                model: None,
                                output_key: None,
                            },
                        ),
                        WorkflowStep::new(
                            "review",
                            WorkflowStepKind::Agent {
                                prompt: "Review the diff".into(),
                                subagent: Some("review".into()),
                                model: None,
                                output_key: None,
                            },
                        ),
                    ],
                    join: JoinPolicy::BestEffort,
                },
            ),
        ];
        def
    }

    #[test]
    fn definition_round_trips_through_json() {
        let def = sample_definition();
        let json = serde_json::to_string(&def).unwrap();
        let back: WorkflowDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(def, back);
    }

    #[test]
    fn agent_step_count_walks_nested_groups() {
        // research (1) + phase>edit (1) + parallel>{tests,review} (2) = 4
        assert_eq!(sample_definition().agent_step_count(), 4);
    }

    #[test]
    fn step_kind_is_tagged_on_type() {
        let v = serde_json::to_value(&WorkflowStepKind::Agent {
            prompt: "do it".into(),
            subagent: None,
            model: None,
            output_key: None,
        })
        .unwrap();
        assert_eq!(v["type"], "agent");
        assert_eq!(v["prompt"], "do it");
        // Optional fields are skipped when None.
        assert!(v.get("subagent").is_none());
        assert!(v.get("model").is_none());
    }

    #[test]
    fn parallel_join_defaults_to_all_required() {
        // A parallel block whose JSON omits `join` decodes to AllRequired.
        let raw = serde_json::json!({ "type": "parallel", "steps": [] });
        let kind: WorkflowStepKind = serde_json::from_value(raw).unwrap();
        match kind {
            WorkflowStepKind::Parallel { join, .. } => assert_eq!(join, JoinPolicy::AllRequired),
            other => panic!("expected parallel, got {other:?}"),
        }
    }

    #[test]
    fn unknown_step_type_is_rejected() {
        let raw = serde_json::json!({ "type": "teleport", "prompt": "x" });
        let parsed: Result<WorkflowStepKind, _> = serde_json::from_value(raw);
        assert!(parsed.is_err(), "unknown tag must fail to deserialise");
    }

    #[test]
    fn join_policy_wire_round_trips() {
        for p in [JoinPolicy::AllRequired, JoinPolicy::BestEffort] {
            assert_eq!(JoinPolicy::from_wire(p.as_wire()), Some(p));
        }
        assert_eq!(JoinPolicy::from_wire("nonsense"), None);
    }

    #[test]
    fn run_status_wire_round_trips_and_terminal() {
        for s in [
            WorkflowRunStatus::Pending,
            WorkflowRunStatus::Running,
            WorkflowRunStatus::Succeeded,
            WorkflowRunStatus::Failed,
            WorkflowRunStatus::Cancelled,
        ] {
            assert_eq!(WorkflowRunStatus::from_wire(s.as_wire()), Some(s));
        }
        assert!(!WorkflowRunStatus::Pending.is_terminal());
        assert!(!WorkflowRunStatus::Running.is_terminal());
        assert!(WorkflowRunStatus::Succeeded.is_terminal());
        assert!(WorkflowRunStatus::Failed.is_terminal());
        assert!(WorkflowRunStatus::Cancelled.is_terminal());
    }

    #[test]
    fn run_finish_is_terminal_sticky() {
        let mut run = WorkflowRun::new("wf-1", Some("req-1".into()));
        assert_eq!(run.status, WorkflowRunStatus::Running);
        run.finish(WorkflowRunStatus::Failed);
        let saved = run.status;
        run.finish(WorkflowRunStatus::Succeeded);
        assert_eq!(run.status, saved, "late finish must not overwrite terminal");
        assert!(run.finished_at.is_some());
    }

    #[test]
    fn run_requirement_id_skipped_when_none() {
        let run = WorkflowRun::new("wf-1", None);
        let json = serde_json::to_string(&run).unwrap();
        assert!(!json.contains("requirement_id"), "got: {json}");
    }

    #[test]
    fn legacy_definition_without_optional_fields_decodes() {
        // Minimal row: no project_id / description / steps default.
        let raw = serde_json::json!({
            "id": "wf-legacy",
            "name": "Old recipe",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        });
        let def: WorkflowDefinition = serde_json::from_value(raw).unwrap();
        assert!(def.project_id.is_none());
        assert!(def.description.is_none());
        assert!(def.steps.is_empty());
    }

    #[test]
    fn step_result_constructors() {
        let step = WorkflowStep::new(
            "s",
            WorkflowStepKind::Agent {
                prompt: "p".into(),
                subagent: None,
                model: None,
                output_key: None,
            },
        );
        let ok = WorkflowStepResult::ok(&step, Some("c1".into()), "done".into());
        assert_eq!(ok.status, WorkflowRunStatus::Succeeded);
        assert_eq!(ok.output.as_deref(), Some("done"));
        let bad = WorkflowStepResult::failed(&step, None, "boom".into());
        assert_eq!(bad.status, WorkflowRunStatus::Failed);
        assert_eq!(bad.error.as_deref(), Some("boom"));
    }
}
