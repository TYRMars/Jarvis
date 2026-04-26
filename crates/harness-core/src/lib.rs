//! Core agent harness.
//!
//! This crate defines the runtime-independent pieces: message types, the
//! `Tool` and `LlmProvider` traits, a `Conversation` state container, and
//! the `Agent` run loop that ties them together. Concrete LLM clients,
//! transports, and storage live in sibling crates.

pub mod agent;
pub mod approval;
pub mod conversation;
pub mod error;
pub mod llm;
pub mod memory;
pub mod message;
pub mod progress;
pub mod store;
pub mod tool;

pub use agent::{Agent, AgentConfig, AgentEvent, AgentStream, RunOutcome};
pub use approval::{
    AlwaysApprove, AlwaysDeny, ApprovalDecision, ApprovalRequest, Approver, ChannelApprover,
    PendingApproval,
};
pub use conversation::Conversation;
pub use error::{BoxError, Error, Result};
pub use llm::{ChatRequest, ChatResponse, FinishReason, LlmChunk, LlmProvider, LlmStream, Usage};
pub use memory::{
    default_estimator, estimate_tokens, estimate_total_tokens, CharRatioEstimator, Memory,
    TokenEstimator,
};
pub use message::{CacheHint, Message, ToolCall};
pub use progress::{
    emit as emit_progress, emit_with as emit_progress_to, is_active as progress_active,
    sender as progress_sender, ToolProgress,
};
pub use store::{ConversationRecord, ConversationStore};
pub use tool::{Tool, ToolRegistry, ToolSpec};
