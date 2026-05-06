//! Persistent product requirements — the **executable backlog** that
//! lives under each [`Project`](crate::Project).
//!
//! `Requirement` is the server-side counterpart of the Web UI's
//! `/projects` kanban (Backlog / In progress / Review / Done). It is
//! distinct from [`TodoItem`](crate::TodoItem) and
//! [`PlanItem`](crate::PlanItem):
//!
//! - [`PlanItem`] is **per-turn** working steps the model emits via
//!   `plan.update`.
//! - [`TodoItem`] is **workspace-scoped** lightweight backlog
//!   (anything-goes notes, follow-ups).
//! - [`Requirement`] is **project-scoped** structured work — the
//!   long-lived "what we're building", with status transitions that
//!   drive the kanban view and (later) `RequirementRun` execution.
//!
//! The wire shape mirrors the existing frontend type at
//! `apps/jarvis-web/src/types/frames.ts` so the migration off
//! `localStorage["jarvis.productRequirements.v1"]` is a verbatim
//! field-name match: `id / project_id / title / description / status /
//! conversation_ids / created_at / updated_at`. New fields are added
//! with `#[serde(default, skip_serializing_if = ...)]` so v2
//! extensions (priority, manifest, run metadata) don't break clients.
//!
//! Mutations broadcast a [`RequirementEvent`] — the store's
//! `subscribe()` is the single fanout path, mirroring [`TodoStore`].
//! The WS bridge in `harness-server` filters by `project_id` so a
//! multi-window UI focused on different projects only sees its own
//! kanban move.

use serde::{Deserialize, Serialize};

use crate::requirement_run::VerificationPlan;

/// One persistent requirement scoped to a single [`Project`](crate::Project).
///
/// The wire shape matches the JSON serialisation of this struct.
/// Renderers should treat unknown statuses as
/// [`RequirementStatus::Backlog`] for forward compat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    /// Stable identifier (UUID v4 string). Server-allocated on
    /// `POST /v1/projects/:id/requirements` so clients can't pick
    /// colliding ids.
    pub id: String,
    /// Foreign key into [`Project::id`](crate::Project). Not enforced
    /// at the storage layer (no DB FK) so a project delete doesn't
    /// cascade-orphan requirements; higher layers should check.
    pub project_id: String,
    /// Headline. One sentence; markdown is allowed but most UIs
    /// render it as plain text.
    pub title: String,
    /// Optional longer body. `None` means no body — UI shows just the
    /// title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Kanban column.
    pub status: RequirementStatus,
    /// Conversations (by id) that have been used to work on this
    /// requirement — i.e. the "runs". Each id refers to a row in
    /// [`ConversationStore`](crate::ConversationStore). Empty by
    /// default; appended when the user opens a fresh chat from the
    /// requirement card.
    #[serde(default)]
    pub conversation_ids: Vec<String>,
    /// Optional [`AgentProfile`](crate::AgentProfile) id this
    /// requirement is assigned to. `None` = "anyone / use the
    /// server default". `start_run` reads this when minting the
    /// fresh conversation so the chosen profile's `system_prompt`
    /// (and, in future phases, provider/model routing) applies.
    /// Added in Phase 3.6 — older rows on disk without the field
    /// deserialise as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    /// Phase 6 — optional pinned [`VerificationPlan`] that auto
    /// mode (and the manual "Run verification" UI when filled
    /// from a template) should fire after each
    /// [`RequirementRun`](crate::RequirementRun) finishes. `None`
    /// = "no per-requirement template; verify only when the
    /// caller passes commands explicitly". Newer field so older
    /// JSON rows without it deserialise as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_plan: Option<VerificationPlan>,
    /// Structured execution / verification checklist under this
    /// requirement. These are intentionally more operational than a
    /// requirement description: CI commands, deploy-preview checks,
    /// manual QA items, reviewer passes, etc. The auto loop and
    /// future CI/CD adapters can update `status` + `evidence` here
    /// so later inspection doesn't depend on reading chat history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<RequirementTodo>,
    /// Triage gate (v1.0). Distinguishes "user-approved work the
    /// auto executor may pick up" from "agent-proposed / scan-
    /// surfaced candidate that must be reviewed first". Auto loop
    /// only consumes [`TriageState::Approved`] rows. Older JSON
    /// rows without the field deserialise as `Approved` (the
    /// pre-v1.0 default behaviour).
    #[serde(default, skip_serializing_if = "TriageState::is_default")]
    pub triage_state: TriageState,
    /// Other requirement ids that must reach
    /// [`RequirementStatus::Done`] before this one is eligible for
    /// auto execution. Manual `Start` ignores this list — the gate
    /// is a scheduler concern, not a hard FK. Empty = no
    /// dependencies. Older JSON rows without the field deserialise
    /// as an empty `Vec`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Who decides `Review → Done`. The default
    /// [`AcceptancePolicy::Subagent`] hands the call off to a
    /// reviewer subagent (see `docs/proposals/subagents.zh-CN.md`)
    /// once the work agent flips to Review; setting it to
    /// [`AcceptancePolicy::Human`] preserves the pre-subagent
    /// behaviour and waits for a person to click "accept" in the UI.
    /// Older JSON rows without the field deserialise as `Subagent`.
    #[serde(default, skip_serializing_if = "AcceptancePolicy::is_default")]
    pub acceptance_policy: AcceptancePolicy,
    /// RFC-3339 / ISO-8601 timestamp of creation.
    pub created_at: String,
    /// RFC-3339 / ISO-8601 timestamp; bumped on every mutation via
    /// [`Self::touch`].
    pub updated_at: String,
}

/// Kanban column / lifecycle state of a [`Requirement`]. Serialised
/// snake_case (`"backlog"` / `"in_progress"` / `"review"` / `"done"`)
/// to match the wire shape the Web UI already produces and consumes
/// (see `apps/jarvis-web/src/types/frames.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    /// Not yet picked up.
    Backlog,
    /// Actively being worked on.
    InProgress,
    /// Implementation finished, waiting for review / verification.
    Review,
    /// Accepted; nothing more to do.
    Done,
}

/// Structured TODO / check item scoped to one [`Requirement`].
///
/// This is the durable execution ledger for a card. It is not a
/// free-form chat plan: every item has a kind, status, optional
/// command, dependencies, and evidence so automation can decide what
/// to run next and humans can audit what happened later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementTodo {
    /// Stable item id (UUID v4).
    pub id: String,
    /// Short actionable label.
    pub title: String,
    /// Operational category.
    pub kind: RequirementTodoKind,
    /// Current state.
    pub status: RequirementTodoStatus,
    /// Optional shell command or workflow command. Only meaningful
    /// for `ci`, `deploy`, and command-backed `check` items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Latest machine-readable proof for this item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<RequirementTodoEvidence>,
    /// Other TODO ids that must pass before this one is eligible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// Who created the item.
    pub created_by: RequirementTodoCreator,
    pub created_at: String,
    pub updated_at: String,
}

impl RequirementTodo {
    pub fn new(title: impl Into<String>, kind: RequirementTodoKind) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into().trim().to_string(),
            kind,
            status: RequirementTodoStatus::Pending,
            command: None,
            evidence: None,
            depends_on: Vec::new(),
            created_by: RequirementTodoCreator::Human,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementTodoKind {
    Work,
    Check,
    Ci,
    Deploy,
    Review,
    Manual,
}

impl RequirementTodoKind {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "work" => Self::Work,
            "check" => Self::Check,
            "ci" => Self::Ci,
            "deploy" => Self::Deploy,
            "review" => Self::Review,
            "manual" => Self::Manual,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Check => "check",
            Self::Ci => "ci",
            Self::Deploy => "deploy",
            Self::Review => "review",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementTodoStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
    Blocked,
}

impl RequirementTodoStatus {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "passed" => Self::Passed,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "blocked" => Self::Blocked,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Blocked => "blocked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementTodoCreator {
    Human,
    Agent,
    Workflow,
}

impl RequirementTodoCreator {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "human" => Self::Human,
            "agent" => Self::Agent,
            "workflow" => Self::Workflow,
            _ => return None,
        })
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
            Self::Workflow => "workflow",
        }
    }
}

/// Latest proof attached to a [`RequirementTodo`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequirementTodoEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl RequirementStatus {
    /// Parse a wire string. Returns `None` for unrecognised values;
    /// REST handlers convert that to a 400.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "backlog" => Self::Backlog,
            "in_progress" => Self::InProgress,
            "review" => Self::Review,
            "done" => Self::Done,
            _ => return None,
        })
    }

    /// Wire form (lowercase, snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::InProgress => "in_progress",
            Self::Review => "review",
            Self::Done => "done",
        }
    }
}

/// Triage gate for a [`Requirement`]. Distinguishes
/// **user-approved** work (default) from **agent-proposed** or
/// **scan-surfaced** candidates that must be reviewed before any
/// automation picks them up.
///
/// Wire form is snake_case (`"approved"` / `"proposed_by_agent"` /
/// `"proposed_by_scan"`). Older requirement rows on disk that
/// don't carry the field deserialise as [`TriageState::Approved`]
/// — i.e. v0 behaviour is preserved when no triage gate was set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageState {
    /// User has approved the work. The auto executor may pick it
    /// up subject to the usual `assignee_id` / `depends_on` /
    /// `status` checks. This is the default for backward compat.
    #[default]
    Approved,
    /// The agent proposed this requirement during a conversation
    /// (e.g. via `requirement.create` while working on a different
    /// card). Stays out of the auto queue until a human approves.
    ProposedByAgent,
    /// A scan tool surfaced this candidate (TODO comments, doctor
    /// findings, recent failed runs). Same gate as
    /// [`TriageState::ProposedByAgent`] — needs human approval
    /// before the executor will touch it.
    ProposedByScan,
}

impl TriageState {
    /// Parse a wire string. `None` for unrecognised values; REST
    /// handlers turn that into a 400.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "approved" => Self::Approved,
            "proposed_by_agent" => Self::ProposedByAgent,
            "proposed_by_scan" => Self::ProposedByScan,
            _ => return None,
        })
    }

    /// Wire form (snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::ProposedByAgent => "proposed_by_agent",
            Self::ProposedByScan => "proposed_by_scan",
        }
    }

    /// `true` for the [`TriageState::Approved`] default — used by
    /// `#[serde(skip_serializing_if = ...)]` so v0 callers don't
    /// see the new field on the wire.
    pub fn is_default(&self) -> bool {
        matches!(self, Self::Approved)
    }

    /// `true` when this gate requires a human to approve before the
    /// auto executor will pick the requirement up.
    pub fn needs_triage(self) -> bool {
        !matches!(self, Self::Approved)
    }
}

/// Who decides `Review → Done` for a [`Requirement`].
///
/// Older JSON rows on disk that don't carry the field deserialise
/// as the default [`AcceptancePolicy::Subagent`] — i.e. the new
/// reviewer-subagent behaviour applies once the v1.0 subagent
/// machinery is wired in. Until that machinery lands, the field is
/// inert (no caller checks it), so the default is forward-looking
/// without changing today's flow.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptancePolicy {
    /// Default. Once the work agent flips the requirement to
    /// `Review`, the auto loop dispatches a reviewer subagent that
    /// runs the [`VerificationPlan`] and decides pass/fail. On pass
    /// the requirement flips to `Done`; on fail it bounces back to
    /// `InProgress` with the reviewer's commentary attached so the
    /// next pickup can adapt.
    #[default]
    Subagent,
    /// Pre-subagent behaviour. The requirement stops at `Review` and
    /// waits for a human to accept it via the UI's "complete" action.
    /// Use this for changes where automated verification can't be
    /// trusted (UX/visual design, security-sensitive work, anything
    /// the verification_plan can't model).
    Human,
}

impl AcceptancePolicy {
    /// Parse a wire string. `None` for unrecognised values; REST
    /// handlers turn that into a 400.
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "subagent" => Self::Subagent,
            "human" => Self::Human,
            _ => return None,
        })
    }

    /// Wire form (snake_case).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Subagent => "subagent",
            Self::Human => "human",
        }
    }

    /// `true` for the [`AcceptancePolicy::Subagent`] default — used
    /// by `#[serde(skip_serializing_if = ...)]` so legacy callers
    /// don't see the new field on the wire when nothing's been set.
    pub fn is_default(&self) -> bool {
        matches!(self, Self::Subagent)
    }
}

impl Requirement {
    /// Mint a new requirement with a fresh UUID and current RFC-3339
    /// timestamps. Status defaults to [`RequirementStatus::Backlog`];
    /// triage_state defaults to [`TriageState::Approved`] so manual
    /// REST `POST /requirements` keeps its pre-v1.0 semantics.
    pub fn new(project_id: impl Into<String>, title: impl Into<String>) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.into(),
            title: title.into(),
            description: None,
            status: RequirementStatus::Backlog,
            conversation_ids: Vec::new(),
            assignee_id: None,
            verification_plan: None,
            todos: Vec::new(),
            triage_state: TriageState::Approved,
            depends_on: Vec::new(),
            acceptance_policy: AcceptancePolicy::Subagent,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// Bump `updated_at` to "now". Called by every mutator.
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }

    /// Append `conversation_id` to [`Self::conversation_ids`] if it
    /// isn't already present, then [`Self::touch`]. Idempotent —
    /// a no-op when the id is already linked, in which case
    /// `updated_at` is **not** bumped (no actual mutation).
    pub fn link_conversation(&mut self, conversation_id: impl Into<String>) -> bool {
        let id = conversation_id.into();
        if self.conversation_ids.iter().any(|c| c == &id) {
            return false;
        }
        self.conversation_ids.push(id);
        self.touch();
        true
    }
}

/// Broadcast envelope sent on every successful [`RequirementStore`]
/// mutation. WS transports filter by `project_id` and forward to
/// subscribed clients as `requirement_upserted` / `requirement_deleted`
/// frames.
///
/// `Upserted` carries a full `Requirement` (~280 bytes of strings +
/// vecs) while `Deleted` is just an id pair; clippy flags this as
/// `large_enum_variant`. We accept the size asymmetry — broadcast
/// channel events are infrequent (one per kanban mutation), and the
/// alternative (boxing) costs us a heap alloc on every fan-out path
/// across 5 store backends. Same exemption pattern as
/// [`AgentProfileEvent`](crate::AgentProfileEvent).
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RequirementEvent {
    /// A requirement was created or updated. The full row is
    /// included so listeners don't need to re-fetch.
    Upserted(Requirement),
    /// A requirement was deleted. Carries the project_id so listeners
    /// pinned to a different project can ignore it cheaply.
    Deleted { project_id: String, id: String },
}

impl RequirementEvent {
    /// Project key the event targets — used by WS handlers to filter
    /// against the socket's pinned project (when one is set).
    pub fn project_id(&self) -> &str {
        match self {
            Self::Upserted(item) => &item.project_id,
            Self::Deleted { project_id, .. } => project_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_round_trips_via_wire() {
        for s in [
            RequirementStatus::Backlog,
            RequirementStatus::InProgress,
            RequirementStatus::Review,
            RequirementStatus::Done,
        ] {
            assert_eq!(RequirementStatus::from_wire(s.as_wire()), Some(s));
        }
        assert_eq!(RequirementStatus::from_wire("nonsense"), None);
    }

    #[test]
    fn status_serialises_snake_case() {
        let json = serde_json::to_string(&RequirementStatus::InProgress).unwrap();
        assert_eq!(json, "\"in_progress\"");
        let json = serde_json::to_string(&RequirementStatus::Backlog).unwrap();
        assert_eq!(json, "\"backlog\"");
    }

    #[test]
    fn new_mints_uuid_and_timestamps() {
        let r = Requirement::new("proj-1", "ship the kanban");
        assert_eq!(r.id.len(), 36);
        assert_eq!(r.project_id, "proj-1");
        assert_eq!(r.title, "ship the kanban");
        assert_eq!(r.status, RequirementStatus::Backlog);
        assert!(r.description.is_none());
        assert!(r.conversation_ids.is_empty());
        assert_eq!(r.created_at, r.updated_at);
    }

    #[test]
    fn touch_bumps_updated_at() {
        let mut r = Requirement::new("p", "x");
        let before = r.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        r.touch();
        assert!(r.updated_at > before);
    }

    #[test]
    fn description_field_is_skipped_when_none() {
        let r = Requirement::new("p", "x");
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("description"), "got: {json}");
    }

    #[test]
    fn round_trip_through_json() {
        let mut r = Requirement::new("p", "x");
        r.description = Some("Build the kanban view".into());
        r.status = RequirementStatus::Review;
        r.conversation_ids = vec!["c1".into(), "c2".into()];
        let mut todo = RequirementTodo::new("run CI", RequirementTodoKind::Ci);
        todo.command = Some("cargo test --workspace".into());
        r.todos.push(todo);
        let json = serde_json::to_string(&r).unwrap();
        let back: Requirement = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn legacy_json_without_todos_defaults_to_empty_list() {
        let raw = serde_json::json!({
            "id": "r1",
            "project_id": "p1",
            "title": "Old row",
            "status": "backlog",
            "conversation_ids": [],
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        });
        let r: Requirement = serde_json::from_value(raw).unwrap();
        assert!(r.todos.is_empty());
    }

    #[test]
    fn requirement_todo_wire_strings_round_trip() {
        assert_eq!(RequirementTodoKind::Ci.as_wire(), "ci");
        assert_eq!(
            RequirementTodoKind::from_wire("deploy"),
            Some(RequirementTodoKind::Deploy)
        );
        assert_eq!(RequirementTodoStatus::Passed.as_wire(), "passed");
        assert_eq!(
            RequirementTodoStatus::from_wire("blocked"),
            Some(RequirementTodoStatus::Blocked)
        );
        assert_eq!(RequirementTodoCreator::Workflow.as_wire(), "workflow");
        assert_eq!(
            RequirementTodoCreator::from_wire("agent"),
            Some(RequirementTodoCreator::Agent)
        );
    }

    #[test]
    fn link_conversation_appends_uniquely_and_touches() {
        let mut r = Requirement::new("p", "x");
        let before = r.updated_at.clone();
        std::thread::sleep(std::time::Duration::from_millis(5));

        assert!(r.link_conversation("c1"));
        assert_eq!(r.conversation_ids, vec!["c1"]);
        assert!(r.updated_at > before);

        // Idempotent: second link of the same id is a no-op.
        let second_pass = r.updated_at.clone();
        assert!(!r.link_conversation("c1"));
        assert_eq!(r.conversation_ids, vec!["c1"]);
        assert_eq!(r.updated_at, second_pass, "no-op should not touch");

        assert!(r.link_conversation("c2"));
        assert_eq!(r.conversation_ids, vec!["c1", "c2"]);
    }

    #[test]
    fn event_project_id_helper() {
        let r = Requirement::new("p1", "x");
        let upserted = RequirementEvent::Upserted(r.clone());
        assert_eq!(upserted.project_id(), "p1");
        let deleted = RequirementEvent::Deleted {
            project_id: "p2".into(),
            id: r.id.clone(),
        };
        assert_eq!(deleted.project_id(), "p2");
    }

    #[test]
    fn legacy_field_names_match_frontend_wire_shape() {
        // Sanity test: the JSON serialisation must use exactly the
        // field names the existing apps/jarvis-web/src/types/frames.ts
        // already produces. If any of these snake_case names drift,
        // the migration off localStorage breaks silently.
        let mut r = Requirement::new("p1", "title");
        r.description = Some("body".into());
        r.conversation_ids.push("c1".into());
        let json: serde_json::Value = serde_json::to_value(&r).unwrap();
        for key in [
            "id",
            "project_id",
            "title",
            "description",
            "status",
            "conversation_ids",
            "created_at",
            "updated_at",
        ] {
            assert!(json.get(key).is_some(), "missing wire key: {key}");
        }
    }

    #[test]
    fn legacy_json_without_acceptance_policy_defaults_to_subagent() {
        // Pre-v1.0 row on disk — no `acceptance_policy` field.
        let raw = serde_json::json!({
            "id": "r1",
            "project_id": "p1",
            "title": "Old row",
            "status": "backlog",
            "conversation_ids": [],
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        });
        let r: Requirement = serde_json::from_value(raw).unwrap();
        assert_eq!(r.acceptance_policy, AcceptancePolicy::Subagent);
    }

    #[test]
    fn default_acceptance_policy_omitted_on_wire() {
        let r = Requirement::new("p1", "Hello");
        let json = serde_json::to_value(&r).unwrap();
        assert!(
            json.get("acceptance_policy").is_none(),
            "default Subagent policy should be skipped on serialise; got: {json}"
        );
    }

    #[test]
    fn explicit_human_policy_round_trips() {
        let mut r = Requirement::new("p1", "Hello");
        r.acceptance_policy = AcceptancePolicy::Human;
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["acceptance_policy"], "human");
        let back: Requirement = serde_json::from_value(json).unwrap();
        assert_eq!(back.acceptance_policy, AcceptancePolicy::Human);
    }

    #[test]
    fn acceptance_policy_wire_strings() {
        assert_eq!(AcceptancePolicy::Subagent.as_wire(), "subagent");
        assert_eq!(AcceptancePolicy::Human.as_wire(), "human");
        assert_eq!(
            AcceptancePolicy::from_wire("subagent"),
            Some(AcceptancePolicy::Subagent)
        );
        assert_eq!(
            AcceptancePolicy::from_wire("human"),
            Some(AcceptancePolicy::Human)
        );
        assert_eq!(AcceptancePolicy::from_wire("unknown"), None);
    }
}
