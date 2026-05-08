//! Provider-fallback event channel — Phase 4.6 of the model & tool
//! compatibility rollout.
//!
//! Companion to [`crate::progress`] / [`crate::plan`] /
//! [`crate::subagent`]. The wire model is the same: the agent loop
//! installs an [`mpsc::UnboundedSender<FallbackEvent>`] in a
//! [`tokio::task_local`] scope via [`with_fallback_listener`] before
//! the LLM call; a fallback wrapper emits via [`emit`] when it
//! decides to walk to the next entry in its chain; the loop drains
//! the receiver alongside `complete_stream`'s chunks and forwards
//! each event as `AgentEvent::ProviderFallback`.
//!
//! The emit is **fire-and-forget** — outside an agent invocation
//! the channel is absent and emits become no-ops, so a
//! [`crate::LlmProvider`] impl that wraps another and reports
//! fallback hops works fine in unit-test scope without any test
//! plumbing.
//!
//! Two motivations for surfacing this to the UI:
//!
//! 1. Operators want to know **why** a chat is slower than usual
//!    or which model actually answered. A silent fallback hides
//!    rate-limit incidents and makes "is the upstream OK?"
//!    debugging painful.
//! 2. Cost / privacy auditing: knowing that the request fell
//!    through to a third-party router or a local Ollama matters
//!    for compliance reviews.

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// One fallback hop. Emitted when the active fallback wrapper
/// decides to retry the request against the next entry in its
/// chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FallbackEvent {
    /// Provider name the request started with (the wrapper's
    /// "primary"). Matches [`crate::ProviderInfo::name`]-style
    /// identifiers, not display labels.
    pub from: String,
    /// Provider name of the fallback we're trying next.
    pub to: String,
    /// Wire model id sent on the retry — the chain doesn't change
    /// the request's model, but the operator wants to see what
    /// model the fallback picked up.
    pub model: String,
    /// Truncated error message from the previous attempt. Useful
    /// for the inline banner ("rate limited", "503 …"). Capped at
    /// `MAX_REASON_LEN` so a multi-line provider error doesn't
    /// flood the WS stream.
    pub reason: String,
    /// Whether this was the *streaming* path's fallback (`true`)
    /// or the blocking `complete()` path (`false`). Lets the UI
    /// distinguish "streamed answer started fresh" from "single
    /// answer returned via fallback".
    pub streaming: bool,
}

const MAX_REASON_LEN: usize = 240;

impl FallbackEvent {
    /// Helper that truncates `reason` to the wire-cap on
    /// construction so callers don't need a separate helper.
    pub fn new(
        from: impl Into<String>,
        to: impl Into<String>,
        model: impl Into<String>,
        reason: impl Into<String>,
        streaming: bool,
    ) -> Self {
        let mut reason = reason.into();
        if reason.len() > MAX_REASON_LEN {
            // Truncate at a UTF-8 boundary.
            let cut = reason
                .char_indices()
                .take_while(|(i, _)| *i < MAX_REASON_LEN)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            reason.truncate(cut);
            reason.push('…');
        }
        Self {
            from: from.into(),
            to: to.into(),
            model: model.into(),
            reason,
            streaming,
        }
    }
}

tokio::task_local! {
    static FALLBACK_TX: mpsc::UnboundedSender<FallbackEvent>;
}

/// Publish a fallback event. No-op when no listener is installed.
pub fn emit(event: FallbackEvent) {
    let _ = FALLBACK_TX.try_with(|tx| {
        let _ = tx.send(event);
    });
}

/// `true` iff a sender is installed. Provider wrappers can check
/// this to skip building an event when nobody's listening (a tiny
/// perf nicety; the cost is one syscall per LLM call regardless).
pub fn is_active() -> bool {
    FALLBACK_TX.try_with(|_| ()).is_ok()
}

/// Run `fut` with `tx` installed as the active fallback sender.
/// Mirrors [`crate::plan::with_plan`] and friends.
pub async fn with_fallback_listener<F, R>(
    tx: mpsc::UnboundedSender<FallbackEvent>,
    fut: F,
) -> R
where
    F: std::future::Future<Output = R>,
{
    FALLBACK_TX.scope(tx, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_inside_listener_reaches_receiver() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        with_fallback_listener(tx, async {
            assert!(is_active());
            emit(FallbackEvent::new(
                "openai",
                "ollama",
                "gpt-4o-mini",
                "429 Too Many Requests",
                false,
            ));
        })
        .await;
        let evt = rx.try_recv().unwrap();
        assert_eq!(evt.from, "openai");
        assert_eq!(evt.to, "ollama");
        assert_eq!(evt.reason, "429 Too Many Requests");
        assert!(!evt.streaming);
    }

    #[tokio::test]
    async fn emit_outside_listener_is_noop() {
        assert!(!is_active());
        emit(FallbackEvent::new("a", "b", "m", "r", true));
        // Didn't panic — that's the contract.
    }

    #[test]
    fn long_reason_is_truncated_at_utf8_boundary() {
        let long: String = "x".repeat(500);
        let evt = FallbackEvent::new("a", "b", "m", long, false);
        assert!(evt.reason.len() <= MAX_REASON_LEN + 4);
        assert!(evt.reason.ends_with('…'));
    }

    #[test]
    fn unicode_reason_is_truncated_at_char_boundary() {
        // Mix multi-byte chars to confirm we cut at boundaries.
        let long = "中".repeat(200);
        let evt = FallbackEvent::new("a", "b", "m", long, false);
        // Should still parse as valid UTF-8 (panic on invalid
        // boundary cut would be the failure mode).
        assert!(evt.reason.is_char_boundary(evt.reason.len()));
    }

    #[test]
    fn event_serialises_with_camelcase_compatible_default() {
        // No rename_all so the wire field names are snake_case
        // matching every other AgentEvent payload — keeps WS frame
        // shape consistent with `subagent_event` etc.
        let evt = FallbackEvent::new("openai", "ollama", "gpt-4o-mini", "429", false);
        let s = serde_json::to_string(&evt).unwrap();
        assert!(s.contains("\"from\":\"openai\""), "got: {s}");
        assert!(s.contains("\"to\":\"ollama\""), "got: {s}");
        assert!(s.contains("\"streaming\":false"), "got: {s}");
    }
}
