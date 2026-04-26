//! Short-term memory implementations for the harness `Agent`.
//!
//! The trait itself ([`harness_core::Memory`]) lives in `harness-core` so
//! the agent loop can call it without depending on this crate.
//! Implementations here decide *how* to compact a conversation before it
//! is sent to the LLM:
//!
//! - [`SlidingWindowMemory`] — drops oldest user-bounded turns until the
//!   estimated token count fits a budget. System messages are always
//!   preserved, the most recent turn is always preserved (even if it
//!   alone exceeds the budget — better to overrun than to send a request
//!   without context), and tool-call atomicity is preserved by grouping
//!   on `User` boundaries so we never split an Assistant tool-call from
//!   its `Tool` replies.
//!
//! - [`SummarizingMemory`] — same windowing rules, but instead of hard-
//!   dropping the oldest turns it asks an `LlmProvider` to summarise
//!   them and inserts the summary as a synthetic `System` message
//!   between the leading systems and the kept turns. A single-slot
//!   fingerprint cache dedupes repeat work so a long-running agent loop
//!   doesn't trigger a fresh summarisation call on every iteration.
//!   In-process only — cross-conversation persistence depends on the
//!   `ConversationStore` route work that hasn't landed yet.

mod sliding;
mod summarizing;
mod turns;

pub use sliding::SlidingWindowMemory;
pub use summarizing::{SummarizingMemory, DEFAULT_SUMMARY_PROMPT};
