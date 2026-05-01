//! Token-budgeted sliding window over a conversation.
//!
//! The conversation is split into:
//!
//! - **System messages** at the start — kept unconditionally.
//! - **Turns**, each starting at a `User` message and extending up to (but
//!   not including) the next `User`. A turn therefore bundles an Assistant
//!   reply together with any `Tool` results it triggered, so the window
//!   never splits a tool exchange.
//!
//! Turns are kept newest-first until the running total fits the
//! configured token budget, then the survivors are emitted in
//! chronological order. The most recent turn is always preserved, even
//! if it alone exceeds the budget — sending no recent context would be
//! strictly worse than slightly overrunning.

use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{default_estimator, BoxError, Memory, Message, TokenEstimator};
use tracing::debug;

use crate::turns::{select_recent_turns, split_into_turns};

/// Drop oldest turns until the estimated token count fits `max_tokens`.
pub struct SlidingWindowMemory {
    max_tokens: usize,
    insert_marker: bool,
    estimator: Arc<dyn TokenEstimator>,
}

impl SlidingWindowMemory {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            insert_marker: true,
            estimator: default_estimator(),
        }
    }

    /// Disable the synthetic `[earlier turns omitted to fit context]`
    /// system note inserted when turns are dropped.
    pub fn without_marker(mut self) -> Self {
        self.insert_marker = false;
        self
    }

    /// Use a provider-supplied [`TokenEstimator`] in place of the
    /// `chars/4 + 4` fallback. Pass the value of
    /// [`harness_core::LlmProvider::estimator`] for the agent's
    /// configured provider; over-counting is safer than
    /// under-counting for budget-driven compaction.
    pub fn with_estimator(mut self, estimator: Arc<dyn TokenEstimator>) -> Self {
        self.estimator = estimator;
        self
    }
}

#[async_trait]
impl Memory for SlidingWindowMemory {
    async fn compact(&self, messages: &[Message]) -> Result<Vec<Message>, BoxError> {
        Ok(compact(
            messages,
            self.max_tokens,
            self.insert_marker,
            self.estimator.as_ref(),
        ))
    }
}

fn compact(
    messages: &[Message],
    max_tokens: usize,
    insert_marker: bool,
    estimator: &dyn TokenEstimator,
) -> Vec<Message> {
    let (system_idxs, turns) = split_into_turns(messages);

    let system_tokens: usize = system_idxs
        .iter()
        .map(|&i| estimator.estimate_message(&messages[i]))
        .sum();
    let budget = max_tokens.saturating_sub(system_tokens);

    let kept = select_recent_turns(&turns, budget, |turn| {
        turn.iter()
            .map(|&i| estimator.estimate_message(&messages[i]))
            .sum()
    });

    let dropped_turns = turns.len() - kept.len();
    debug!(
        total_turns = turns.len(),
        kept_turns = kept.len(),
        dropped_turns,
        "compact (sliding)",
    );

    let mut out: Vec<Message> =
        Vec::with_capacity(system_idxs.len() + kept.iter().map(|t| t.len()).sum::<usize>() + 1);
    for &i in &system_idxs {
        out.push(messages[i].clone());
    }
    if insert_marker && dropped_turns > 0 {
        // Marker text is intentionally constant — embedding the count
        // would change byte-for-byte every time a turn drops off the
        // tail, which would bust the LLM's prompt cache for every
        // message after this point. The count is interesting for
        // debugging (it's in the `tracing::debug!` line above) but
        // not load-bearing for the model.
        out.push(Message::system(
            "[earlier turns omitted to fit context]".to_string(),
        ));
    }
    for turn in kept {
        for &i in turn {
            out.push(messages[i].clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{estimate_tokens, CharRatioEstimator, ToolCall};
    use serde_json::json;

    fn user(s: &str) -> Message {
        Message::user(s)
    }
    fn assistant(s: &str) -> Message {
        Message::assistant_text(s)
    }
    fn system(s: &str) -> Message {
        Message::system(s)
    }
    fn tool_reply(id: &str, body: &str) -> Message {
        Message::tool_result(id, body)
    }
    fn assistant_with_call(id: &str, name: &str) -> Message {
        Message::Assistant {
            content: None,
            tool_calls: vec![ToolCall {
                id: id.into(),
                name: name.into(),
                arguments: json!({}),
            }],
            reasoning_content: None,
            cache: None,
        }
    }

    fn tokens(messages: &[Message]) -> usize {
        messages.iter().map(estimate_tokens).sum()
    }

    #[test]
    fn under_budget_returns_everything() {
        let msgs = vec![system("you are jarvis"), user("hi"), assistant("hello")];
        let out = compact(&msgs, 10_000, true, &CharRatioEstimator);
        assert_eq!(out.len(), msgs.len());
    }

    #[test]
    fn drops_oldest_turns_over_budget() {
        let msgs = vec![
            system("sys"),
            user("turn 1 user"),
            assistant("turn 1 reply"),
            user("turn 2 user"),
            assistant("turn 2 reply"),
            user("turn 3 user"),
            assistant("turn 3 reply"),
        ];
        // Budget that fits roughly two turns plus the system prompt.
        let budget = tokens(&msgs[0..1])
            + tokens(&msgs[3..5]) // turn 2
            + tokens(&msgs[5..7]); // turn 3
        let out = compact(&msgs, budget, true, &CharRatioEstimator);

        // System + marker + turn 2 + turn 3
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::System { content, .. } if content == "sys")));
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 3 user")));
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 2 user")));
        assert!(!out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 1 user")));
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::System { content, .. } if content.contains("omitted"))));
    }

    #[test]
    fn always_keeps_latest_turn_even_if_oversized() {
        let big = "x".repeat(10_000);
        let msgs = vec![system("sys"), user(&big), assistant(&big)];
        let out = compact(&msgs, 10, true, &CharRatioEstimator);
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content.starts_with("xxxx"))));
    }

    #[test]
    fn keeps_tool_call_with_replies_atomic() {
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant_with_call("call_1", "fs.read"),
            tool_reply("call_1", "file contents"),
            assistant("done"),
        ];
        // Budget that only fits the recent turn (5 messages from index 3..7).
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[3..7]);
        let out = compact(&msgs, budget, false, &CharRatioEstimator);

        // The Tool reply must be in there together with the Assistant
        // tool-call that produced it — both kept or both dropped.
        let has_call = out
            .iter()
            .any(|m| matches!(m, Message::Assistant { tool_calls, .. } if !tool_calls.is_empty()));
        let has_reply = out
            .iter()
            .any(|m| matches!(m, Message::Tool { tool_call_id, .. } if tool_call_id == "call_1"));
        assert_eq!(has_call, has_reply);
        assert!(has_call, "expected the recent tool exchange to survive");

        // Old turn is gone.
        assert!(!out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "old")));
    }

    #[test]
    fn marker_inserted_only_when_dropping() {
        let msgs = vec![
            system("sys"),
            user("a"),
            assistant("b"),
            user("c"),
            assistant("d"),
        ];
        let out = compact(&msgs, 10_000, true, &CharRatioEstimator);
        assert!(!out
            .iter()
            .any(|m| matches!(m, Message::System { content, .. } if content.contains("omitted"))));
    }

    #[test]
    fn marker_disabled_via_flag() {
        let msgs = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1"),
            user("turn 2"),
            assistant("reply 2"),
        ];
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[3..5]);
        let out = compact(&msgs, budget, false, &CharRatioEstimator);
        assert!(!out
            .iter()
            .any(|m| matches!(m, Message::System { content, .. } if content.contains("omitted"))));
    }

    #[test]
    fn marker_is_byte_stable_across_drop_counts() {
        // Two conversations that drop a different number of turns
        // must produce identical marker bytes — anything else busts
        // the LLM prompt cache after the marker.
        let drops_one = vec![
            system("sys"),
            user("dropped 1"),
            assistant("d1"),
            user("recent"),
            assistant("r"),
        ];
        let drops_three = vec![
            system("sys"),
            user("dropped 1"),
            assistant("d1"),
            user("dropped 2"),
            assistant("d2"),
            user("dropped 3"),
            assistant("d3"),
            user("recent"),
            assistant("r"),
        ];
        let budget = tokens(&drops_one[0..1]) + tokens(&drops_one[3..5]);
        let out1 = compact(&drops_one, budget, true, &CharRatioEstimator);
        let out2 = compact(&drops_three, budget, true, &CharRatioEstimator);

        let marker1 = out1
            .iter()
            .find_map(|m| match m {
                Message::System { content, .. } if content.contains("omitted") => {
                    Some(content.clone())
                }
                _ => None,
            })
            .unwrap();
        let marker2 = out2
            .iter()
            .find_map(|m| match m {
                Message::System { content, .. } if content.contains("omitted") => {
                    Some(content.clone())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            marker1, marker2,
            "marker must be byte-stable for cache hits"
        );
    }

    #[test]
    fn preserves_chronological_order() {
        let msgs = vec![
            system("sys"),
            user("u1"),
            assistant("a1"),
            user("u2"),
            assistant("a2"),
            user("u3"),
            assistant("a3"),
        ];
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[3..7]);
        let out = compact(&msgs, budget, false, &CharRatioEstimator);

        // Find indices of the user messages we kept.
        let positions: Vec<&str> = out
            .iter()
            .filter_map(|m| match m {
                Message::User { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(positions, vec!["u2", "u3"]);
    }

    /// A pluggable estimator that doubles every count. Useful to prove
    /// `with_estimator` actually drives compaction decisions and isn't
    /// silently overridden by `CharRatioEstimator`.
    struct DoublingEstimator;
    impl harness_core::TokenEstimator for DoublingEstimator {
        fn estimate_message(&self, m: &Message) -> usize {
            estimate_tokens(m) * 2
        }
        fn estimate_text(&self, t: &str) -> usize {
            t.chars().count() / 2
        }
    }

    #[tokio::test]
    async fn custom_estimator_halves_effective_budget() {
        let msgs = vec![
            system("sys"),
            user("turn 1 user"),
            assistant("turn 1 reply"),
            user("turn 2 user"),
            assistant("turn 2 reply"),
            user("turn 3 user"),
            assistant("turn 3 reply"),
        ];
        // Budget that fits everything under the default estimator.
        let baseline = SlidingWindowMemory::new(100_000);
        let kept_default = baseline.compact(&msgs).await.unwrap();
        assert_eq!(kept_default.len(), msgs.len());

        // Pick a budget that JUST fits the conversation under the
        // default estimator, then swap in the doubling estimator: the
        // backend now sees us "over" by 2x and drops the oldest turn.
        let exact_budget: usize = msgs.iter().map(estimate_tokens).sum();
        let mem = SlidingWindowMemory::new(exact_budget)
            .with_estimator(std::sync::Arc::new(DoublingEstimator));
        let kept_doubled = mem.compact(&msgs).await.unwrap();
        assert!(
            kept_doubled.len() < msgs.len(),
            "doubling estimator should force at least one turn out: kept {}/{}",
            kept_doubled.len(),
            msgs.len()
        );
    }
}
