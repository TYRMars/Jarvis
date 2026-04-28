//! Tokeniser-backed [`TokenEstimator`] implementations shared by every
//! provider in this crate.
//!
//! Each provider picks an encoding (`cl100k_base` or `o200k_base`) and
//! optionally a safety margin to over-count when the underlying model
//! uses a different tokeniser:
//!
//! - **OpenAI / Responses (Codex):** exact `o200k_base` for the
//!   `gpt-4o` / `o*` family, exact `cl100k_base` for older models. No
//!   margin.
//! - **Anthropic:** `cl100k_base` + 20 % safety margin. Anthropic's
//!   tokeniser (`claude-3-5-sonnet`) is BPE-similar but not identical;
//!   over-counting is the safe direction for budget-driven compaction.
//! - **Google Gemini:** `cl100k_base` + 10 % safety margin. Gemini's
//!   tokeniser is closer to GPT's for ASCII text.
//!
//! Encoders are cached in process-wide `OnceLock`s so the heavy BPE
//! merge load happens at most once per encoding.

use std::sync::{Arc, OnceLock};

use harness_core::{Message, TokenEstimator};
use tiktoken_rs::{cl100k_base, o200k_base, CoreBPE};

/// Per-message overhead the model counts internally for role /
/// separator tokens. Matches the OpenAI cookbook's
/// `tokens_per_message = 3` plus 1 we keep for the trailing newline,
/// and is close enough for Anthropic / Google not to need its own
/// constant — the safety margin absorbs the slack.
const PER_MESSAGE_OVERHEAD: usize = 4;

/// `cl100k_base` BPE — used by `gpt-3.5`, `gpt-4`, `gpt-4-turbo`, and
/// as the cross-provider fallback. Loaded once.
fn cl100k() -> Arc<CoreBPE> {
    static CACHE: OnceLock<Arc<CoreBPE>> = OnceLock::new();
    CACHE
        .get_or_init(|| Arc::new(cl100k_base().expect("cl100k merges bundled by tiktoken-rs")))
        .clone()
}

/// `o200k_base` BPE — used by the `gpt-4o`, `gpt-4o-mini`, and `o1` /
/// `o3` reasoning families. Loaded once.
fn o200k() -> Arc<CoreBPE> {
    static CACHE: OnceLock<Arc<CoreBPE>> = OnceLock::new();
    CACHE
        .get_or_init(|| Arc::new(o200k_base().expect("o200k merges bundled by tiktoken-rs")))
        .clone()
}

/// BPE-backed estimator with an optional safety multiplier. Cheap to
/// clone — internal state is a single `Arc<CoreBPE>`.
#[derive(Clone)]
pub struct TiktokenEstimator {
    bpe: Arc<CoreBPE>,
    safety_margin: f32,
}

impl TiktokenEstimator {
    /// `cl100k_base` encoder, exact (no safety margin).
    pub fn cl100k() -> Self {
        Self {
            bpe: cl100k(),
            safety_margin: 1.0,
        }
    }

    /// `o200k_base` encoder, exact (no safety margin).
    pub fn o200k() -> Self {
        Self {
            bpe: o200k(),
            safety_margin: 1.0,
        }
    }

    /// Multiply every count by `1.0 + margin` (e.g. `0.20` for +20 %).
    /// Use when this estimator is approximating a different
    /// tokeniser — over-counting keeps memory budgets safe.
    pub fn with_safety_margin(mut self, margin: f32) -> Self {
        self.safety_margin = 1.0 + margin.max(0.0);
        self
    }

    /// Pick the right OpenAI encoder for `model`. Anything containing
    /// `gpt-4o`, `o1`, `o3`, `o4`, `gpt-5`, or `omni` uses `o200k_base`;
    /// everything else falls back to `cl100k_base`. The check is on the
    /// caller-supplied model string so out-of-tree forks (Azure, Kimi)
    /// land on the safer fallback.
    pub fn for_openai_model(model: &str) -> Self {
        let m = model.to_ascii_lowercase();
        let o200k_marker = m.contains("gpt-4o") || m.contains("gpt-5") || m.contains("omni");
        let o_reasoning = m.starts_with("o1")
            || m.starts_with("o3")
            || m.starts_with("o4")
            || m.contains("/o1")
            || m.contains("/o3")
            || m.contains("/o4");
        if o200k_marker || o_reasoning {
            Self::o200k()
        } else {
            Self::cl100k()
        }
    }

    fn margined(&self, raw: usize) -> usize {
        if (self.safety_margin - 1.0).abs() < f32::EPSILON {
            raw
        } else {
            ((raw as f32) * self.safety_margin).ceil() as usize
        }
    }
}

impl TokenEstimator for TiktokenEstimator {
    fn estimate_text(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        let raw = self.bpe.encode_with_special_tokens(text).len();
        self.margined(raw)
    }

    fn estimate_message(&self, message: &Message) -> usize {
        let body = match message {
            Message::System { content, .. }
            | Message::User { content }
            | Message::Tool { content, .. } => self.estimate_text(content),
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content,
            } => {
                let mut n = 0;
                if let Some(c) = content {
                    n += self.estimate_text(c);
                }
                if let Some(r) = reasoning_content {
                    n += self.estimate_text(r);
                }
                for tc in tool_calls {
                    n += self.estimate_text(&tc.id);
                    n += self.estimate_text(&tc.name);
                    n += self.estimate_text(&tc.arguments.to_string());
                }
                n
            }
        };
        body + PER_MESSAGE_OVERHEAD
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::ToolCall;
    use serde_json::json;

    #[test]
    fn empty_text_is_zero() {
        let est = TiktokenEstimator::cl100k();
        assert_eq!(est.estimate_text(""), 0);
    }

    #[test]
    fn cl100k_counts_more_or_equal_than_o200k_for_same_text() {
        // o200k has a richer vocabulary, so it usually encodes the same
        // English prose in fewer tokens. This test pins that ordering
        // so a future tiktoken-rs upgrade that flips it gets noticed.
        let prose = "The agent loop dispatches one tool at a time and \
                     keeps the conversation in memory.";
        let cl = TiktokenEstimator::cl100k().estimate_text(prose);
        let oo = TiktokenEstimator::o200k().estimate_text(prose);
        assert!(cl >= oo, "expected cl100k({cl}) >= o200k({oo})");
    }

    #[test]
    fn safety_margin_overcount() {
        let exact = TiktokenEstimator::cl100k().estimate_text("hello world");
        let padded = TiktokenEstimator::cl100k()
            .with_safety_margin(0.20)
            .estimate_text("hello world");
        // Padded must be at least exact, and strictly greater for any
        // non-trivial count.
        assert!(padded >= exact);
        assert!(padded as f32 >= (exact as f32) * 1.20 - 1.0);
    }

    #[test]
    fn message_includes_per_message_overhead() {
        let est = TiktokenEstimator::cl100k();
        let msg = Message::user("");
        // Empty content → exactly the per-message overhead.
        assert_eq!(est.estimate_message(&msg), PER_MESSAGE_OVERHEAD);
    }

    #[test]
    fn assistant_with_tool_call_counts_arguments() {
        let est = TiktokenEstimator::cl100k();
        let m = Message::Assistant {
            content: None,
            tool_calls: vec![ToolCall {
                id: "call_1".into(),
                name: "echo".into(),
                arguments: json!({ "text": "hello world" }),
            }],
            reasoning_content: None,
        };
        let n = est.estimate_message(&m);
        // Strictly more than just the overhead — the tool-call id /
        // name / arguments contribute real tokens.
        assert!(n > PER_MESSAGE_OVERHEAD, "got {n}");
    }

    #[test]
    fn for_openai_model_picks_o200k_for_gpt4o_family() {
        let oo = TiktokenEstimator::for_openai_model("gpt-4o-mini");
        let cl = TiktokenEstimator::cl100k();
        // o200k encodes prose more compactly than cl100k. Use a long
        // enough snippet that the difference is reliable; very short
        // ASCII strings happen to tokenise identically under both.
        let txt = "The transformer encoder block applies pre-layer-norm \
                   followed by a multi-head attention sub-layer and a \
                   feed-forward sub-layer with residual connections \
                   around each. Counting tokens accurately matters when \
                   you are budgeting context window for long agent runs \
                   that trail dozens of tool exchanges across many turns.";
        let oo_n = oo.estimate_text(txt);
        let cl_n = cl.estimate_text(txt);
        assert!(oo_n < cl_n, "expected o200k({oo_n}) < cl100k({cl_n})");
    }

    #[test]
    fn for_openai_model_falls_back_to_cl100k_for_unknown() {
        let est = TiktokenEstimator::for_openai_model("kimi-k2-thinking");
        // Same encoder as cl100k() → identical text counts.
        assert_eq!(
            est.estimate_text("hello world"),
            TiktokenEstimator::cl100k().estimate_text("hello world")
        );
    }
}
