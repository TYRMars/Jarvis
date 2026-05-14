//! Project domain — `Project` + everything that hangs off it.
//!
//! Extracted from `harness-core` so the latter goes back to what its
//! CLAUDE.md charter says: agent loop + the traits the loop itself
//! consumes. Project-style features (kanban, requirements,
//! requirement runs, activity timeline, comments, labels, docs,
//! project-scoped memory) are a separate domain and live here.
//!
//! Like `harness-channel`, this crate is a **leaf** — no
//! `harness-*` deps. The only consumers are:
//! - `harness-store` (concrete persistence backends)
//! - `harness-server` (HTTP routes + business logic)
//! - `harness-tools` (the `project.*` / `requirement.*` / `doc.*`
//!   agent tools)
//! - `apps/jarvis` (composition root)
//!
//! `harness-core` does not depend on this crate. Dependency direction:
//!
//! ```text
//! harness-project ←──┐
//!                    ├── harness-tools
//!                    ├── harness-store
//!                    └── harness-server
//!
//! harness-core (agent loop only)
//! ```

pub mod activity;
pub mod comment;
pub mod doc;
pub mod label;
pub mod project;
pub mod project_memory;
pub mod requirement;
pub mod requirement_run;
pub mod store;

pub use activity::{Activity, ActivityActor, ActivityEvent, ActivityKind};
pub use comment::{Comment, CommentEvent};
pub use doc::{DocDraft, DocEvent, DocKind, DocProject};
pub use label::{
    validate_label_colour, validate_label_name, Label, LabelEvent, MAX_LABEL_NAME_LEN,
};
pub use project::{
    default_kanban_columns, derive_slug, validate_column_id, validate_slug, KanbanColumn, Project,
    ProjectAutomation, ProjectWorkspace,
};
pub use project_memory::{ProjectMemory, ProjectMemoryKind};
pub use requirement::{
    AcceptancePolicy, Requirement, RequirementEvent, RequirementStatus, RequirementTodo,
    RequirementTodoCreator, RequirementTodoEvidence, RequirementTodoKind, RequirementTodoStatus,
    TriageState,
};
pub use requirement_run::{
    CommandResult, RequirementRun, RequirementRunEvent, RequirementRunLog, RequirementRunLogLevel,
    RequirementRunStatus, VerificationPlan, VerificationResult, VerificationStatus,
};
pub use store::{
    ActivityStore, CommentStore, DocStore, LabelStore, ProjectMemoryStore, ProjectStore,
    RequirementRunStore, RequirementStore,
};
