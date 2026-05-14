//! Core agent harness.
//!
//! This crate defines the runtime-independent pieces: message types, the
//! `Tool` and `LlmProvider` traits, a `Conversation` state container, and
//! the `Agent` run loop that ties them together. Concrete LLM clients,
//! transports, and storage live in sibling crates.

pub mod agent;
pub mod agent_profile;
pub mod approval;
pub mod conversation;
pub mod error;
pub mod fallback_event;
pub mod hitl;
pub mod llm;
pub mod memory;
pub mod message;
pub mod permission;
pub mod plan;
pub mod progress;
pub mod redact;
pub mod store;
pub mod subagent;
pub mod tenant;
pub mod todo;
pub mod tool;
pub mod tool_metadata;
pub mod workspace;

// `activity` / `comment` / `doc` / `label` / `project` / `project_memory`
// / `requirement` / `requirement_run` modules moved to the
// `harness-project` crate together with their `*Store` trait
// surfaces. Importers: `use harness_project::{Project, Requirement,
// …};` and likewise for the stores.

pub use agent::{Agent, AgentConfig, AgentEvent, AgentStream, RunOutcome};
pub use agent_profile::{AgentProfile, AgentProfileEvent};
pub use approval::{
    AlwaysApprove, AlwaysDeny, ApprovalDecision, ApprovalRequest, Approver, ChannelApprover,
    PendingApproval,
};
pub use conversation::Conversation;
pub use error::{BoxError, Error, Result};
pub use fallback_event::{
    emit as emit_fallback, is_active as fallback_listener_active, with_fallback_listener,
    FallbackEvent,
};
pub use hitl::{
    request as request_human, with_hitl, HitlKind, HitlOption, HitlRequest, HitlResponse,
    HitlStatus, HitlTransport, PendingHitl,
};
pub use llm::{ChatRequest, ChatResponse, FinishReason, LlmChunk, LlmProvider, LlmStream, Usage};
pub use memory::{
    cache_breakpoint_indices, default_estimator, estimate_tokens, estimate_total_tokens,
    CharRatioEstimator, JsonAwareEstimator, Memory, TokenEstimator,
};
pub use message::{CacheHint, Message, ToolCall};
// `observability` module + all its types (Eval* / Observed* /
// Metric* / Dashboard* / TimeWindow / *Store / *Filter) moved to
// the `harness-observability` crate. Import via
// `use harness_observability::{EvalStore, ObservabilityStore, ...};`
// from consumer crates.
pub use permission::{
    glob_match, Decision, HitSource, PermissionMode, PermissionRule, PermissionStore,
    PermissionTable, RuleHit, Scope as PermissionScope, ScopedRule,
};
pub use plan::{emit as emit_plan, is_active as plan_active, with_plan, PlanItem, PlanStatus};
pub use progress::{
    emit as emit_progress, emit_with as emit_progress_to, is_active as progress_active,
    sender as progress_sender, ToolProgress,
};
pub use store::{
    AgentProfileStore, ConversationLifecycle, ConversationMetadata, ConversationRecord,
    ConversationStore, TodoStore,
};
pub use subagent::{
    active_sender as subagent_active_sender, emit as emit_subagent, is_active as subagent_active,
    with_subagent, SubAgentEvent, SubAgentFrame,
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
pub use tool_metadata::{
    derive_pack, derive_risk, ToolMetadata, ToolPackCategory, ToolRisk, ToolSource,
};
pub use workspace::{
    active_workspace, active_workspace_or, canonicalize_workspace, with_session_workspace,
};
