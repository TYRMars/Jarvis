//! Core agent harness.
//!
//! This crate defines the runtime-independent pieces: message types, the
//! `Tool` and `LlmProvider` traits, a `Conversation` state container, and
//! the `Agent` run loop that ties them together. Concrete LLM clients,
//! transports, and storage live in sibling crates.

pub mod activity;
pub mod agent;
pub mod agent_profile;
pub mod approval;
pub mod comment;
pub mod conversation;
pub mod doc;
pub mod error;
pub mod hitl;
pub mod label;
pub mod llm;
pub mod memory;
pub mod message;
pub mod observability;
pub mod permission;
pub mod plan;
pub mod progress;
pub mod project;
pub mod project_memory;
pub mod requirement;
pub mod requirement_run;
pub mod store;
pub mod subagent;
pub mod tenant;
pub mod todo;
pub mod tool;
pub mod workspace;

pub use activity::{Activity, ActivityActor, ActivityEvent, ActivityKind};
pub use agent::{Agent, AgentConfig, AgentEvent, AgentStream, RunOutcome};
pub use agent_profile::{AgentProfile, AgentProfileEvent};
pub use approval::{
    AlwaysApprove, AlwaysDeny, ApprovalDecision, ApprovalRequest, Approver, ChannelApprover,
    PendingApproval,
};
pub use comment::{Comment, CommentEvent};
pub use conversation::Conversation;
pub use doc::{DocDraft, DocEvent, DocKind, DocProject};
pub use error::{BoxError, Error, Result};
pub use hitl::{
    request as request_human, with_hitl, HitlKind, HitlOption, HitlRequest, HitlResponse,
    HitlStatus, HitlTransport, PendingHitl,
};
pub use label::{
    validate_label_colour, validate_label_name, Label, LabelEvent, MAX_LABEL_NAME_LEN,
};
pub use llm::{ChatRequest, ChatResponse, FinishReason, LlmChunk, LlmProvider, LlmStream, Usage};
pub use memory::{
    cache_breakpoint_indices, default_estimator, estimate_tokens, estimate_total_tokens,
    CharRatioEstimator, Memory, TokenEstimator,
};
pub use message::{CacheHint, Message, ToolCall};
pub use observability::{
    DashboardSnapshot, EvalBaseline, EvalCaseResult, EvalFilter, EvalStore, EvalSuiteRun,
    MetricKind, MetricPoint, ObservabilityFilter, ObservabilityStore, ObservedOutcome, ObservedRun,
    ObservedRunKind, ObservedSpanSummary, TimeWindow,
};
pub use permission::{
    glob_match, Decision, HitSource, PermissionMode, PermissionRule, PermissionStore,
    PermissionTable, RuleHit, Scope as PermissionScope, ScopedRule,
};
pub use plan::{emit as emit_plan, is_active as plan_active, with_plan, PlanItem, PlanStatus};
pub use progress::{
    emit as emit_progress, emit_with as emit_progress_to, is_active as progress_active,
    sender as progress_sender, ToolProgress,
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
    ActivityStore, AgentProfileStore, CommentStore, ConversationMetadata, ConversationRecord,
    ConversationStore, DocStore, LabelStore, ProjectMemoryStore, ProjectStore, RequirementRunStore,
    RequirementStore, TodoStore,
};
pub use subagent::{
    emit as emit_subagent, is_active as subagent_active, with_subagent, SubAgentEvent,
    SubAgentFrame,
};
/// Tenant (multi-tenant isolation boundary) value types and store trait.
///
/// **Important distinction:** [`Tenant`](crate::tenant::Tenant) is a
/// multi-tenant organisational boundary (team, customer, SaaS tenant).
/// It is **not** a filesystem workspace — the per-session working
/// directory concept lives in [`workspace`](crate::workspace).
pub use tenant::{Tenant, TenantSettings, TenantStore};
pub use todo::{TodoEvent, TodoItem, TodoPriority, TodoStatus};
pub use tool::{Tool, ToolCategory, ToolRegistry, ToolSpec};
pub use workspace::{
    active_workspace, active_workspace_or, canonicalize_workspace, with_session_workspace,
};
