//! Core agent harness.
//!
//! This crate defines the runtime-independent pieces: message types, the
//! `Tool` and `LlmProvider` traits, a `Conversation` state container, and
//! the `Agent` run loop that ties them together. Concrete LLM clients,
//! transports, and storage live in sibling crates.

pub mod agent;
pub mod conversation;
pub mod error;
pub mod llm;
pub mod message;
pub mod tool;

pub use agent::{Agent, AgentConfig, AgentEvent, AgentStream, RunOutcome};
pub use conversation::Conversation;
pub use error::{BoxError, Error, Result};
pub use llm::{ChatRequest, ChatResponse, FinishReason, LlmChunk, LlmProvider, LlmStream};
pub use message::{Message, ToolCall};
pub use tool::{Tool, ToolRegistry, ToolSpec};
