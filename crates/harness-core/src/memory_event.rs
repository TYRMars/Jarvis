//! Memory compaction signal — typed "what just happened during
//! compaction" stream.
//!
//! Mirrors the [`crate::plan`] / [`crate::progress`] task-local
//! channel pattern. The agent loop calls
//! [`crate::memory::Memory::compact`] silently before every LLM
//! iteration; without this channel the only way a transport learns
//! that turns were summarised or cache-hit is to compare message
//! counts on either side and guess. Wired up properly, the
//! summariser publishes one [`CompactionInfo`] per `compact()` call
//! describing what happened and why.
//!
//! Wire model:
//!
//! - The agent loop installs an
//!   [`mpsc::UnboundedSender<CompactionInfo>`] in a `tokio::task_local`
//!   for the duration of each `build_request` call, scoped via
//!   [`with_compaction_channel`].
//! - Memory backends call [`emit`] from inside `compact()` at the
//!   point where they decide what to send (cache hit / fresh
//!   summary / fallback prune / no-op).
//! - The agent drains the receiver after `build_request` returns
//!   and forwards each info as `AgentEvent::MemoryCompacted` on both
//!   the streaming and blocking paths.
//!
//! Outside an agent invocation (or before the channel is installed)
//! emits are silent no-ops, which keeps `harness-memory`'s unit
//! tests trivial.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// Why the compactor picked the slice it returned.
///
/// Each variant is rendered as its own front-end label, so adding a
/// new one is a wire-compat extension — older clients that don't
/// recognise a value should treat it as "compaction happened, no
/// specific source".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionSource {
    /// The full input slice fits within the budget; nothing was
    /// dropped or summarised. Emitted so the front end can show
    /// the diagnostic panel a steady stream of "compactor was
    /// consulted" pings even when no work was needed.
    NoOp,
    /// `SlidingWindowMemory` dropped older turns to fit the
    /// budget. No LLM call involved.
    WindowDropped,
    /// `SummarizingMemory` hit the in-memory single-slot cache
    /// (Tier 1).
    CacheMemory,
    /// `SummarizingMemory` hit the persistent `ConversationStore`
    /// cache (Tier 2). The summary was loaded from disk / SQL.
    CacheStore,
    /// `SummarizingMemory` called the LLM to produce a fresh
    /// summary (Tier 3). This is the expensive path.
    FreshLlm,
    /// `SummarizingMemory` ran the PTL fallback round one (drop
    /// the oldest ~20 % of non-critical turns). Reached when the
    /// summariser's output was over-budget or the circuit was
    /// open.
    PtlRoundOne,
    /// `SummarizingMemory` ran the PTL fallback round two (hard
    /// prune to the latest turn). Reached when round one's
    /// output was still over-budget.
    PtlRoundTwo,
    /// `SummarizingMemory` wanted to produce a summary but the
    /// circuit breaker was open or the upstream LLM returned
    /// `Err`. The slice still has the dropped prefix elided —
    /// just with a `[N earlier turn(s) omitted — summary
    /// unavailable]` placeholder in place of a real summary.
    /// UIs render this as a degraded state ("summariser
    /// offline, history pruned without a summary") so operators
    /// know to investigate, vs treating it as a normal cache
    /// hit.
    SummaryUnavailable,
}

/// Snapshot of one compaction round — what changed and why.
///
/// All fields are best-effort: `turns_*` come from
/// `crates/harness-memory::turns::split_into_turns` so they reflect
/// the same notion of "turn" the summariser uses internally
/// (User + every following Assistant/Tool until the next User).
/// `*_chars` are character counts from the rendered string the
/// backend chose, not token counts. `model_input_tokens_est` is the
/// total estimate across the *returned* slice using whatever
/// estimator the backend was constructed with — typically
/// `CharRatioEstimator` or a provider tokeniser plugged in via
/// `LlmProvider::estimator`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionInfo {
    /// Why this slice was chosen. See [`CompactionSource`].
    pub source: CompactionSource,
    /// Turn count of the slice the backend returned.
    pub turns_kept: usize,
    /// `turns_in - turns_kept`. Zero when [`CompactionSource::NoOp`].
    pub turns_dropped: usize,
    /// Length of the synthetic summary `System` message inserted
    /// after the dropped prefix, in chars. `None` when no summary
    /// was inserted (no-op, plain window-drop, PTL fallback).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary_chars: Option<usize>,
    /// Length of the rendered `=== working context ===` block
    /// appended to the kept tail, in chars. `None` when no
    /// working-context snapshot was active.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub working_context_chars: Option<usize>,
    /// Estimated total tokens for the slice the backend returned.
    /// Lets the UI show "we shipped ~3 200 tokens after
    /// compaction" without re-running the estimator front-end side.
    pub model_input_tokens_est: usize,
}

tokio::task_local! {
    /// Per-iteration compaction-info sender, scoped via
    /// [`with_compaction_channel`]. Absent outside an agent loop.
    static COMPACTION_TX: mpsc::UnboundedSender<CompactionInfo>;
}

/// Publish a compaction-info record. No-op when no listener is
/// installed (memory backends invoked outside the agent loop —
/// e.g. unit tests).
pub fn emit(info: CompactionInfo) {
    let _ = COMPACTION_TX.try_with(|tx| {
        let _ = tx.send(info);
    });
}

/// Whether a compaction-info sender is installed for the current
/// task. Used by tests to assert the channel is wired correctly.
pub fn is_active() -> bool {
    COMPACTION_TX.try_with(|_| ()).is_ok()
}

/// Run `fut` with `tx` installed as the active sender. The agent
/// loop uses this to scope a sender around a single `build_request`
/// call so emits during compaction land in the right per-iteration
/// receiver.
pub async fn with_compaction_channel<F, R>(tx: mpsc::UnboundedSender<CompactionInfo>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    COMPACTION_TX.scope(tx, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_info(source: CompactionSource) -> CompactionInfo {
        CompactionInfo {
            source,
            turns_kept: 2,
            turns_dropped: 5,
            summary_chars: Some(180),
            working_context_chars: Some(90),
            model_input_tokens_est: 1234,
        }
    }

    #[tokio::test]
    async fn emit_inside_scope_reaches_receiver() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            assert!(is_active());
            emit(sample_info(CompactionSource::CacheMemory));
        })
        .await;
        let got = rx.try_recv().unwrap();
        assert_eq!(got.source, CompactionSource::CacheMemory);
        assert_eq!(got.turns_kept, 2);
        assert_eq!(got.turns_dropped, 5);
    }

    #[tokio::test]
    async fn emit_outside_scope_is_noop() {
        assert!(!is_active());
        emit(sample_info(CompactionSource::FreshLlm));
        // The point: this didn't panic.
    }

    #[test]
    fn source_serialises_snake_case() {
        let cases = [
            (CompactionSource::NoOp, "no_op"),
            (CompactionSource::WindowDropped, "window_dropped"),
            (CompactionSource::CacheMemory, "cache_memory"),
            (CompactionSource::CacheStore, "cache_store"),
            (CompactionSource::FreshLlm, "fresh_llm"),
            (CompactionSource::PtlRoundOne, "ptl_round_one"),
            (CompactionSource::PtlRoundTwo, "ptl_round_two"),
            (CompactionSource::SummaryUnavailable, "summary_unavailable"),
        ];
        for (source, expected) in cases {
            let info = sample_info(source);
            let json = serde_json::to_string(&info).unwrap();
            assert!(
                json.contains(&format!("\"source\":\"{expected}\"")),
                "expected `{expected}` in: {json}",
            );
        }
    }

    #[test]
    fn info_skips_optionals_when_none() {
        let info = CompactionInfo {
            source: CompactionSource::NoOp,
            turns_kept: 3,
            turns_dropped: 0,
            summary_chars: None,
            working_context_chars: None,
            model_input_tokens_est: 42,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(!json.contains("summary_chars"), "got: {json}");
        assert!(!json.contains("working_context_chars"), "got: {json}");
        assert!(json.contains("\"model_input_tokens_est\":42"), "got: {json}");
    }
}
