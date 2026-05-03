//! Short-term memory hook for the agent loop.
//!
//! The agent calls [`Memory::compact`] before every LLM iteration with a
//! borrowed slice of the current conversation. Implementations decide what
//! to send to the model — usually a clipped, summarised, or otherwise
//! compressed view — without mutating the canonical [`Conversation`] held
//! by the caller.
//!
//! Concrete implementations live in sibling crates (e.g. `harness-memory`
//! provides `SlidingWindowMemory`). `harness-core` only owns the trait and
//! a cheap token estimator so any implementation can budget consistently.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::BoxError;
use crate::message::Message;

/// Compact a conversation before it goes to the LLM. Implementations must
/// preserve correctness invariants the provider cares about — most
/// importantly, every `Message::Tool` in the returned slice must be
/// preceded by the `Message::Assistant` whose `tool_calls` reference its
/// `tool_call_id`.
#[async_trait]
pub trait Memory: Send + Sync {
    /// Return the messages that should be sent on the next iteration.
    /// The default contract is "clone everything"; real implementations
    /// drop / summarise older content.
    async fn compact(&self, messages: &[Message]) -> Result<Vec<Message>, BoxError>;
}

/// Per-provider token-counting strategy. Memory backends consume one of
/// these instead of calling the free [`estimate_tokens`] helper, so a
/// provider with a real tokeniser (e.g. tiktoken for OpenAI) can plug in
/// accurate counts without each backend caring how counting works.
///
/// Implementations are expected to be cheap to clone (typically `Arc`'d
/// internal state) and safe to call from multiple async tasks.
pub trait TokenEstimator: Send + Sync {
    /// Tokens for a single message, including any role/separator
    /// overhead the model would count internally.
    fn estimate_message(&self, message: &Message) -> usize;

    /// Tokens for raw text — used by summarisers when sizing the
    /// summary prompt itself.
    fn estimate_text(&self, text: &str) -> usize;

    /// Sum across a slice. Default sums per-message; providers can
    /// override to amortise per-request overhead.
    fn estimate_messages(&self, messages: &[Message]) -> usize {
        messages.iter().map(|m| self.estimate_message(m)).sum()
    }
}

/// Cheap, provider-agnostic estimator: roughly `chars / 4` plus a fixed
/// per-message overhead for role/separator tokens. Same numbers as the
/// historical [`estimate_tokens`] free function — kept identical so
/// switching default backends doesn't shift any existing budgets.
#[derive(Debug, Default, Clone, Copy)]
pub struct CharRatioEstimator;

impl CharRatioEstimator {
    pub const fn new() -> Self {
        Self
    }
}

impl TokenEstimator for CharRatioEstimator {
    fn estimate_message(&self, message: &Message) -> usize {
        estimate_tokens(message)
    }

    fn estimate_text(&self, text: &str) -> usize {
        text.chars().count().div_ceil(4)
    }
}

/// Cheap, provider-agnostic token estimate. Roughly `chars / 4` plus a
/// fixed per-message overhead for role/separator tokens. This is *not* a
/// precise tiktoken count — it's a heuristic that lets memory backends
/// budget without pulling a tokeniser dep into `harness-core`.
///
/// Prefer [`TokenEstimator::estimate_message`] when you have an
/// estimator handle; this free function exists so old call sites and
/// `CharRatioEstimator` itself share one definition.
pub fn estimate_tokens(message: &Message) -> usize {
    const PER_MESSAGE_OVERHEAD: usize = 4;

    let chars: usize = match message {
        Message::System { content, .. } | Message::User { content, .. } => content.chars().count(),
        Message::Assistant {
            content,
            tool_calls,
            reasoning_content,
            ..
        } => {
            let body = content.as_deref().map(|s| s.chars().count()).unwrap_or(0);
            let reasoning = reasoning_content
                .as_deref()
                .map(|s| s.chars().count())
                .unwrap_or(0);
            let calls: usize = tool_calls
                .iter()
                .map(|tc| {
                    tc.id.chars().count()
                        + tc.name.chars().count()
                        + tc.arguments.to_string().chars().count()
                })
                .sum();
            body + reasoning + calls
        }
        Message::Tool {
            tool_call_id,
            content,
            ..
        } => tool_call_id.chars().count() + content.chars().count(),
    };
    chars.div_ceil(4) + PER_MESSAGE_OVERHEAD
}

/// Sum of [`estimate_tokens`] over a slice. Cheap convenience for
/// implementations.
pub fn estimate_total_tokens(messages: &[Message]) -> usize {
    messages.iter().map(estimate_tokens).sum()
}

/// Default `Arc<dyn TokenEstimator>` returned by [`crate::LlmProvider::estimator`]
/// and used as the fallback by memory backends. The same instance is
/// safe to share — `CharRatioEstimator` carries no state.
pub fn default_estimator() -> Arc<dyn TokenEstimator> {
    Arc::new(CharRatioEstimator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolCall;
    use serde_json::json;

    #[test]
    fn char_ratio_matches_legacy_helper() {
        let est = CharRatioEstimator;
        let m = Message::user("hello world");
        assert_eq!(est.estimate_message(&m), estimate_tokens(&m));
    }

    #[test]
    fn char_ratio_text_is_chars_over_four() {
        let est = CharRatioEstimator;
        // 16 chars → ceil(16/4) = 4.
        assert_eq!(est.estimate_text("0123456789abcdef"), 4);
        // Empty.
        assert_eq!(est.estimate_text(""), 0);
    }

    #[test]
    fn char_ratio_assistant_counts_text_plus_tool_call_args() {
        let est = CharRatioEstimator;
        let m = Message::Assistant {
            content: Some("hi".into()),
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                name: "echo".into(),
                arguments: json!({ "text": "hi" }),
            }],
            reasoning_content: None,
            cache: None,
        };
        // Same number you'd get from the free helper.
        assert_eq!(est.estimate_message(&m), estimate_tokens(&m));
    }

    #[test]
    fn estimate_messages_sums_per_message() {
        let est = CharRatioEstimator;
        let msgs = vec![Message::user("a"), Message::assistant_text("b")];
        let summed: usize = msgs.iter().map(|m| est.estimate_message(m)).sum();
        assert_eq!(est.estimate_messages(&msgs), summed);
    }
}
