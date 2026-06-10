//! Difficulty classifiers. P0 ships a zero-cost heuristic; the
//! [`Classifier`] trait leaves room for a P1 LLM judge with the same
//! shape.

use async_trait::async_trait;

use crate::tier::Tier;

/// Decides the [`Tier`] for a turn from its latest user message.
///
/// Async so a future LLM-backed judge can issue a (cheap, timeout-
/// bounded) classification call; the heuristic impl simply returns
/// without awaiting anything real.
#[async_trait]
pub trait Classifier: Send + Sync {
    async fn classify(&self, last_user_message: &str) -> Tier;
}

/// Zero-cost, no-LLM classifier. Routes by three cheap signals on the
/// latest user message:
///
/// * a fenced code block (```` ``` ````) or a complexity keyword
///   (English + 中文) ⇒ [`Tier::Complex`];
/// * very short text (≤ `simple_max_chars`) ⇒ [`Tier::Simple`];
/// * anything else ⇒ [`Tier::Medium`].
///
/// It never emits [`Tier::Reasoning`] — that tier is reserved for the
/// LLM judge. Empty input is treated as `Medium` (safe middle ground)
/// rather than `Simple`, since an empty trailing user message usually
/// means a tool-driven continuation, not a trivial ask.
#[derive(Debug, Clone)]
pub struct HeuristicClassifier {
    /// Inclusive upper bound (chars) for the `Simple` bucket.
    pub simple_max_chars: usize,
    /// Inclusive lower bound (chars) that forces `Complex` regardless of
    /// keywords — long prompts tend to carry multi-step intent.
    pub complex_min_chars: usize,
}

impl Default for HeuristicClassifier {
    fn default() -> Self {
        Self {
            simple_max_chars: 48,
            complex_min_chars: 600,
        }
    }
}

/// ASCII keywords that bias a turn toward `Complex`. Matched
/// case-insensitively against **whole tokens** of the lowercased message
/// (split on non-alphanumeric boundaries), so e.g. `"implement"` does not
/// fire on `"implementation"` / `"implemented"` and `"design"` does not
/// fire on `"redesigned"` / `"designer"`. Substring matching here mis-routed
/// trivial turns to the expensive `Complex` tier (see #89).
const ASCII_COMPLEX_KEYWORDS: &[&str] = &[
    "refactor",
    "architecture",
    "debug",
    "implement",
    "benchmark",
    "optimize",
    "optimise",
    "design",
];

/// CJK keywords that bias a turn toward `Complex`. CJK has no word
/// boundaries, so these are matched as substrings (`contains`) — and they
/// are unaffected by `to_lowercase`, so they match verbatim.
const CJK_COMPLEX_KEYWORDS: &[&str] = &["重构", "架构", "分析", "设计", "优化", "调试", "实现"];

/// Whether `lower` (an already-lowercased message) carries a complexity
/// keyword: a whole-token ASCII match or a CJK substring match.
fn has_complex_keyword(lower: &str) -> bool {
    let ascii_hit = lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| ASCII_COMPLEX_KEYWORDS.contains(&token));
    ascii_hit || CJK_COMPLEX_KEYWORDS.iter().any(|k| lower.contains(k))
}

#[async_trait]
impl Classifier for HeuristicClassifier {
    async fn classify(&self, last_user_message: &str) -> Tier {
        let text = last_user_message.trim();
        if text.is_empty() {
            return Tier::Medium;
        }
        let chars = text.chars().count();
        let lower = text.to_lowercase();
        if text.contains("```") || chars >= self.complex_min_chars || has_complex_keyword(&lower) {
            return Tier::Complex;
        }
        if chars <= self.simple_max_chars {
            return Tier::Simple;
        }
        Tier::Medium
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn short_text_is_simple() {
        assert_eq!(HeuristicClassifier::default().classify("ok").await, Tier::Simple);
        assert_eq!(
            HeuristicClassifier::default().classify("好的，继续").await,
            Tier::Simple
        );
    }

    #[tokio::test]
    async fn code_fence_is_complex() {
        let msg = "fix this:\n```rust\nfn x() {}\n```";
        assert_eq!(HeuristicClassifier::default().classify(msg).await, Tier::Complex);
    }

    #[tokio::test]
    async fn english_keyword_is_complex() {
        assert_eq!(
            HeuristicClassifier::default()
                .classify("please refactor the auth module")
                .await,
            Tier::Complex
        );
    }

    #[tokio::test]
    async fn chinese_keyword_is_complex() {
        assert_eq!(
            HeuristicClassifier::default().classify("帮我分析一下这段逻辑").await,
            Tier::Complex
        );
    }

    #[tokio::test]
    async fn mid_length_plain_text_is_medium() {
        let msg = "Can you explain what this function returns and whether it \
                   handles the empty input case the way a caller would expect";
        assert_eq!(HeuristicClassifier::default().classify(msg).await, Tier::Medium);
    }

    #[tokio::test]
    async fn substring_of_keyword_does_not_force_complex() {
        // "implementation" / "redesigned" contain a keyword as a substring but
        // are not whole-token matches — they must not be routed to Complex (#89).
        let msg = "I was reading the implementation notes and the page got \
                   redesigned, but otherwise everything looked fine to me here";
        assert_eq!(HeuristicClassifier::default().classify(msg).await, Tier::Medium);
    }

    #[tokio::test]
    async fn whole_word_keyword_still_complex() {
        // Boundary matching must still fire on a standalone keyword token,
        // including when adjacent to punctuation.
        assert_eq!(
            HeuristicClassifier::default()
                .classify("can you debug, then optimize the loop?")
                .await,
            Tier::Complex
        );
    }

    #[tokio::test]
    async fn empty_is_medium() {
        assert_eq!(HeuristicClassifier::default().classify("   ").await, Tier::Medium);
    }
}
