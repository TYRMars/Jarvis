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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{
    cache_breakpoint_indices, default_estimator, emit_memory_compaction, BoxError, CompactionInfo,
    CompactionSource, Memory, MemoryStatsProvider, Message, TokenEstimator,
};
use tracing::debug;

use crate::turns::{select_recent_turns, select_recent_turns_with_breakpoint, split_into_turns};

/// Lightweight telemetry surface for [`SlidingWindowMemory`].
///
/// `SummarizingMemory` ships a richer 10-counter struct (cache
/// hits, circuit breaker, PTL), but the sliding backend has neither
/// LLM nor cache — it just drops oldest turns. The counters track
/// what *can* happen here so operators on the default `mode=window`
/// deployment see something other than "not configured" in the
/// Memory diagnostics panel.
#[derive(Debug, Default)]
pub struct SlidingCounters {
    /// Total `compact()` calls. Same semantic as
    /// `CompactionCounters::compactions_total` so the diagnostics
    /// panel can use the same column unconditionally.
    pub compactions_total: AtomicU64,
    /// Calls that dropped at least one turn (`turns_dropped > 0`).
    pub window_dropped: AtomicU64,
}

impl SlidingCounters {
    fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
    fn load(c: &AtomicU64) -> u64 {
        c.load(Ordering::Relaxed)
    }
}

impl MemoryStatsProvider for SlidingCounters {
    fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": "sliding",
            "compactions_total": Self::load(&self.compactions_total),
            "window_dropped": Self::load(&self.window_dropped),
        })
    }
}

/// Drop oldest turns until the estimated token count fits `max_tokens`.
pub struct SlidingWindowMemory {
    max_tokens: usize,
    insert_marker: bool,
    estimator: Arc<dyn TokenEstimator>,
    counters: Arc<SlidingCounters>,
}

impl SlidingWindowMemory {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            insert_marker: true,
            estimator: default_estimator(),
            counters: Arc::new(SlidingCounters::default()),
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

    /// Clone-able handle to the telemetry counters. Composition
    /// roots stash this on `AppState::memory_stats` so the
    /// `GET /v1/diagnostics/memory` endpoint can render a snapshot
    /// even on the default `mode=window` backend.
    pub fn counters(&self) -> Arc<SlidingCounters> {
        self.counters.clone()
    }
}

#[async_trait]
impl Memory for SlidingWindowMemory {
    async fn compact(&self, messages: &[Message]) -> Result<Vec<Message>, BoxError> {
        SlidingCounters::inc(&self.counters.compactions_total);
        let (out, dropped) = compact(
            messages,
            self.max_tokens,
            self.insert_marker,
            self.estimator.as_ref(),
        );
        if dropped > 0 {
            SlidingCounters::inc(&self.counters.window_dropped);
        }
        Ok(out)
    }
}

fn compact(
    messages: &[Message],
    max_tokens: usize,
    insert_marker: bool,
    estimator: &dyn TokenEstimator,
) -> (Vec<Message>, usize) {
    let (system_idxs, turns) = split_into_turns(messages);

    let system_tokens: usize = system_idxs
        .iter()
        .map(|&i| estimator.estimate_message(&messages[i]))
        .sum();
    let budget = max_tokens.saturating_sub(system_tokens);

    // Cache-aware path: if any message carries an explicit cache
    // breakpoint, prefer to keep the cached prefix intact. The
    // highest-indexed breakpoint marks the end of what's cached on the
    // server side; dropping turns before it busts the cache for every
    // message that follows. Falls back to the plain newest-first
    // selector when no breakpoint is set, preserving the historical
    // behaviour for callers that don't use caching.
    let breakpoints = cache_breakpoint_indices(messages);
    let kept = if let Some(&bp) = breakpoints.iter().max() {
        select_recent_turns_with_breakpoint(&turns, bp, budget, |turn| {
            turn.iter()
                .map(|&i| estimator.estimate_message(&messages[i]))
                .sum()
        })
    } else {
        select_recent_turns(&turns, budget, |turn| {
            turn.iter()
                .map(|&i| estimator.estimate_message(&messages[i]))
                .sum()
        })
    };

    let kept_len = kept.len();
    let dropped_turns = turns.len() - kept_len;
    debug!(
        total_turns = turns.len(),
        kept_turns = kept_len,
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
    // Append the agent's working-context snapshot (recent files +
    // current plan). Empty snapshots render `None` and contribute
    // nothing. Outside an agent run (e.g. memory unit tests without
    // `with_working_context`) the snapshot is also `None`, so this
    // is a no-op in tests that don't opt in.
    let len_before_wc = out.len();
    append_working_context(&mut out);
    let working_context_chars = match out.get(len_before_wc) {
        Some(Message::System { content, .. }) if content.starts_with("=== working context ===") => {
            Some(content.chars().count())
        }
        _ => None,
    };

    emit_memory_compaction(CompactionInfo {
        source: if dropped_turns > 0 {
            CompactionSource::WindowDropped
        } else {
            CompactionSource::NoOp
        },
        turns_kept: kept_len,
        turns_dropped: dropped_turns,
        summary_chars: None,
        working_context_chars,
        model_input_tokens_est: estimator.estimate_messages(&out),
    });

    (out, dropped_turns)
}

/// Append the current `WorkingContext` snapshot as a trailing
/// `System` message. No-op when no snapshot is installed or the
/// snapshot has nothing worth rendering. Pulled out so the same
/// behaviour lives in `SummarizingMemory` without copy/paste.
pub(crate) fn append_working_context(out: &mut Vec<Message>) {
    if let Some(wc) = harness_core::working_context_snapshot() {
        if let Some(body) = wc.render() {
            out.push(Message::system(body));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{estimate_tokens, CacheHint, CharRatioEstimator, ToolCall};
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
        let (out, _) = compact(&msgs, 10_000, true, &CharRatioEstimator);
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
        let (out, _) = compact(&msgs, budget, true, &CharRatioEstimator);

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
        let (out, _) = compact(&msgs, 10, true, &CharRatioEstimator);
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
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);

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
        let (out, _) = compact(&msgs, 10_000, true, &CharRatioEstimator);
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
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);
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
        let (out1, _) = compact(&drops_one, budget, true, &CharRatioEstimator);
        let (out2, _) = compact(&drops_three, budget, true, &CharRatioEstimator);

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
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);

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

    #[test]
    fn cache_breakpoint_protects_pre_breakpoint_turns() {
        // Conversation: sys + 3 turns, with a CacheHint on the
        // assistant of turn 2. With a budget that fits only TWO turns
        // total, the default heuristic would drop turns 1 and 2 (keep
        // 2 newest). Cache-aware should instead keep turns 1 + 2
        // (the cached prefix) and the recent turn (recency invariant).
        let mut turn2_assistant = Message::assistant_text("turn 2 reply");
        turn2_assistant = turn2_assistant.with_cache(CacheHint::Ephemeral);
        let msgs = vec![
            system("sys"),
            user("turn 1 user"),
            assistant("turn 1 reply"),
            user("turn 2 user"),
            turn2_assistant,
            user("turn 3 user"),
            assistant("turn 3 reply"),
            user("turn 4 user"),
            assistant("turn 4 reply"),
        ];
        // Budget that fits sys + only TWO of the four turns at once.
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[1..3]) + tokens(&msgs[7..9]);
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);

        // Turn 1 (cached prefix) survives even though it's the oldest.
        assert!(
            out.iter()
                .any(|m| matches!(m, Message::User { content, .. } if content == "turn 1 user")),
            "cached-prefix turn 1 should survive over budget pressure"
        );
        // Turn 2 (cached prefix end) survives.
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 2 user")));
        // Turn 4 (recency invariant) survives.
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 4 user")));
        // Turn 3 (the middle) is the one that got dropped.
        assert!(!out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "turn 3 user")));
    }

    #[test]
    fn cache_breakpoint_inside_tool_exchange_keeps_atomicity() {
        // Breakpoint sits on a Tool reply inside the recent turn. The
        // tool exchange must still be atomic — the assistant tool-call
        // and the matching tool-result must both survive (or both drop).
        let tool_reply_with_hint =
            Message::tool_result("call_1", "file contents").with_cache(CacheHint::Ephemeral);
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant_with_call("call_1", "fs.read"),
            tool_reply_with_hint,
            assistant("done"),
        ];
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[3..7]);
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);

        let has_call = out
            .iter()
            .any(|m| matches!(m, Message::Assistant { tool_calls, .. } if !tool_calls.is_empty()));
        let has_reply = out
            .iter()
            .any(|m| matches!(m, Message::Tool { tool_call_id, .. } if tool_call_id == "call_1"));
        assert_eq!(
            has_call, has_reply,
            "tool exchange must stay atomic under cache-aware compaction"
        );
        assert!(has_call, "the recent tool exchange should survive");
    }

    #[test]
    fn cache_breakpoint_overflow_falls_back_to_recent_first() {
        // Cache prefix way bigger than budget — fall back to plain
        // newest-first behavior so we don't regress recency.
        let big = "x".repeat(2_000);
        let mut hinted = Message::assistant_text(&big);
        hinted = hinted.with_cache(CacheHint::Ephemeral);
        let msgs = vec![
            system("sys"),
            user(&big),
            hinted,
            user("recent"),
            assistant("r"),
        ];
        // Budget too tight to fit the cached prefix.
        let budget = 50;
        let (out, _) = compact(&msgs, budget, false, &CharRatioEstimator);
        // Recent turn should still be there.
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::User { content, .. } if content == "recent")));
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
    async fn appends_working_context_block_when_active() {
        use harness_core::{
            note_working_file, note_working_plan, with_working_context, PlanItem, PlanStatus,
        };
        let msgs = vec![system("sys"), user("hi"), assistant("hello")];
        with_working_context(async {
            note_working_file("src/lib.rs");
            note_working_plan(vec![PlanItem {
                id: "1".into(),
                title: "do thing".into(),
                status: PlanStatus::InProgress,
                note: None,
            }]);
            let mem = SlidingWindowMemory::new(10_000);
            let out = mem.compact(&msgs).await.unwrap();
            // Last message should be the working-context block.
            let last = out.last().unwrap();
            match last {
                Message::System { content, .. } => {
                    assert!(
                        content.starts_with("=== working context ==="),
                        "expected working-context block at tail, got: {content}"
                    );
                    assert!(content.contains("src/lib.rs"));
                    assert!(content.contains("do thing"));
                }
                _ => panic!("expected trailing System message, got {last:?}"),
            }
        })
        .await;
    }

    #[tokio::test]
    async fn no_block_when_working_context_inactive() {
        // No `with_working_context` scope: snapshot returns None and
        // the trailing block is skipped entirely.
        let msgs = vec![system("sys"), user("hi"), assistant("hello")];
        let mem = SlidingWindowMemory::new(10_000);
        let out = mem.compact(&msgs).await.unwrap();
        let has_block = out.iter().any(
            |m| matches!(m, Message::System { content, .. } if content.starts_with("=== working context ===")),
        );
        assert!(!has_block, "should not inject without a working-context scope");
    }

    #[tokio::test]
    async fn no_block_when_snapshot_is_empty() {
        use harness_core::with_working_context;
        let msgs = vec![system("sys"), user("hi"), assistant("hello")];
        with_working_context(async {
            let mem = SlidingWindowMemory::new(10_000);
            let out = mem.compact(&msgs).await.unwrap();
            let has_block = out.iter().any(
                |m| matches!(m, Message::System { content, .. } if content.starts_with("=== working context ===")),
            );
            assert!(!has_block, "empty context should not inject a block");
        })
        .await;
    }

    #[tokio::test]
    async fn counters_track_compactions_and_window_drops() {
        use harness_core::MemoryStatsProvider;
        // Tight budget — sized so the second conversation must drop.
        let big = vec![
            system("sys"),
            user("turn 1 long enough for the estimator"),
            assistant("reply 1 also reasonably long here"),
            user("turn 2 another long user message"),
            assistant("reply 2 with extra padding text"),
            user("turn 3 most recent here"),
            assistant("reply 3 short"),
        ];
        let budget = tokens(&big[0..1]) + tokens(&big[5..7]); // sys + last turn
        let mem = SlidingWindowMemory::new(budget);
        let counters = mem.counters();
        // First run: tiny conversation, fits → no drops.
        let small = vec![system("sys"), user("hi"), assistant("hello")];
        let _ = mem.compact(&small).await.unwrap();
        // Second run: must drop earlier turns to fit `budget`.
        let _ = mem.compact(&big).await.unwrap();
        assert_eq!(counters.compactions_total.load(Ordering::Relaxed), 2);
        assert_eq!(
            counters.window_dropped.load(Ordering::Relaxed),
            1,
            "the second call should have window-dropped",
        );
        let snap = counters.snapshot();
        assert_eq!(snap["backend"], "sliding");
        assert_eq!(snap["compactions_total"], 2);
        assert_eq!(snap["window_dropped"], 1);
    }

    #[tokio::test]
    async fn emits_window_dropped_event_when_turns_pruned() {
        use harness_core::{with_compaction_channel, CompactionSource};
        use tokio::sync::mpsc;
        let msgs = vec![
            system("sys"),
            user("turn 1 user"),
            assistant("turn 1 reply"),
            user("turn 2 user"),
            assistant("turn 2 reply"),
            user("turn 3 user"),
            assistant("turn 3 reply"),
        ];
        let budget = tokens(&msgs[0..1]) + tokens(&msgs[3..5]) + tokens(&msgs[5..7]);
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            let mem = SlidingWindowMemory::new(budget);
            let _ = mem.compact(&msgs).await.unwrap();
        })
        .await;
        let info = rx.try_recv().expect("expected an emitted CompactionInfo");
        assert_eq!(info.source, CompactionSource::WindowDropped);
        assert!(info.turns_dropped >= 1, "expected at least one turn dropped");
        assert!(info.turns_kept >= 1, "should keep recency invariant");
        assert!(info.summary_chars.is_none());
        assert!(info.model_input_tokens_est > 0);
    }

    #[tokio::test]
    async fn emits_no_op_event_when_under_budget() {
        use harness_core::{with_compaction_channel, CompactionSource};
        use tokio::sync::mpsc;
        let msgs = vec![system("sys"), user("hi"), assistant("hello")];
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            let mem = SlidingWindowMemory::new(10_000);
            let _ = mem.compact(&msgs).await.unwrap();
        })
        .await;
        let info = rx.try_recv().expect("expected an emitted CompactionInfo");
        assert_eq!(info.source, CompactionSource::NoOp);
        assert_eq!(info.turns_dropped, 0);
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
