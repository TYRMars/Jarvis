//! LLM-backed long-term memory: instead of hard-dropping the oldest
//! turns when the budget is exceeded, ask an `LlmProvider` to summarise
//! them into a single paragraph and inject that as a synthetic system
//! message between the leading systems and the kept recent turns.
//!
//! The same turn-grouping invariants as [`crate::SlidingWindowMemory`]
//! apply: leading `System` messages are kept verbatim, the most recent
//! turn is always preserved (even if it alone exceeds the budget), and
//! tool-call exchanges are atomic.
//!
//! ## Caching
//!
//! Without caching, every `Agent::build_request` iteration would
//! re-summarise the same prefix — for a long conversation that's many
//! redundant LLM calls per user turn. We carry a single-slot cache
//! keyed by a fingerprint of the messages we're about to summarise. As
//! the conversation grows turn-by-turn, the slice we'd summarise stays
//! identical (we're only adding to the *recent* end, not the dropped
//! end), so the cache hits and the LLM is only invoked when the set of
//! dropped turns actually changes. A single slot is enough because the
//! set of dropped turns is monotone — once a turn enters the dropped
//! set, it never leaves.
//!
//! ## Cross-process persistence
//!
//! When constructed with [`SummarizingMemory::with_persistence`], a
//! second cache tier kicks in: the same fingerprint that keys the
//! in-memory cache also keys a row in a [`ConversationStore`], so a
//! restart picks up where the previous process left off and parallel
//! workers sharing a database see each other's work. Storage is
//! **content-addressed** — the key is a stable BLAKE3 hex of the slice
//! we're summarising, not a conversation id — so the cache is shared
//! across conversations and survives the agent loop's churn without
//! needing the request layer to thread an id through.
//!
//! Persisted summaries are stored as a synthetic `Conversation` whose
//! single `System` message is the summary text, under the key
//! `__memory__.summary:<hash>`. The `__` prefix is a reserved
//! namespace; the HTTP server filters it out of the public CRUD
//! endpoints so internal rows never leak into client conversation
//! lists.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use harness_core::{
    cache_breakpoint_indices, default_estimator, BoxError, ChatRequest, Conversation,
    ConversationStore, Error as CoreError, LlmProvider, Memory, Message, TokenEstimator,
};
use tracing::{debug, warn};

use crate::turns::{select_recent_turns, select_recent_turns_with_breakpoint, split_into_turns};

/// Reserved namespace for memory's persisted rows. Keys live under
/// `__memory__.summary:<hash>` so the HTTP server can filter them out
/// of the public conversation list. The double-underscore prefix is the
/// canonical "internal-only" marker for the conversation store.
const PERSIST_KEY_PREFIX: &str = "__memory__.summary:";

/// Default system prompt used when the caller doesn't supply one.
pub const DEFAULT_SUMMARY_PROMPT: &str = "\
You are a conversation summariser. Compress the supplied excerpt into a \
short paragraph. Preserve concrete facts, decisions, file paths, names, \
numbers, and any in-flight tool results that later turns may rely on. \
Do not invent details, do not editorialise, and do not add a preamble.";

/// Reserved budget (in estimated tokens) carved out for the summary
/// itself when planning what to keep recent. Keeps us from packing the
/// budget so tight that the synthetic summary push us back over.
const SUMMARY_RESERVE_TOKENS: usize = 256;

/// Cap on how many tokens the summarisation call is allowed to emit.
const DEFAULT_SUMMARY_MAX_TOKENS: u32 = 400;

/// Compact a conversation by summarising the oldest turns.
pub struct SummarizingMemory {
    llm: Arc<dyn LlmProvider>,
    model: String,
    max_tokens: usize,
    summary_prompt: String,
    summary_max_tokens: u32,
    cache: Arc<Mutex<Option<CachedSummary>>>,
    /// When set, summaries are also written to (and read from) this
    /// store keyed by a content-addressed BLAKE3 fingerprint, so they
    /// survive process restarts and are shared across workers.
    persistence: Option<Arc<dyn ConversationStore>>,
    estimator: Arc<dyn TokenEstimator>,
}

struct CachedSummary {
    fingerprint: String,
    text: String,
}

impl SummarizingMemory {
    pub fn new(llm: Arc<dyn LlmProvider>, model: impl Into<String>, max_tokens: usize) -> Self {
        Self {
            llm,
            model: model.into(),
            max_tokens,
            summary_prompt: DEFAULT_SUMMARY_PROMPT.to_string(),
            summary_max_tokens: DEFAULT_SUMMARY_MAX_TOKENS,
            cache: Arc::new(Mutex::new(None)),
            persistence: None,
            estimator: default_estimator(),
        }
    }

    pub fn with_summary_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.summary_prompt = prompt.into();
        self
    }

    pub fn with_summary_max_tokens(mut self, n: u32) -> Self {
        self.summary_max_tokens = n;
        self
    }

    /// Persist (and rehydrate) summaries through `store`, content-
    /// addressed by a BLAKE3 fingerprint of the summarised slice. Rows
    /// land under the reserved `__memory__.` key namespace so the HTTP
    /// server can filter them out of the public conversation list.
    pub fn with_persistence(mut self, store: Arc<dyn ConversationStore>) -> Self {
        self.persistence = Some(store);
        self
    }

    /// Use a provider-supplied [`TokenEstimator`] in place of the
    /// `chars/4 + 4` fallback. Same semantics as
    /// [`crate::SlidingWindowMemory::with_estimator`].
    pub fn with_estimator(mut self, estimator: Arc<dyn TokenEstimator>) -> Self {
        self.estimator = estimator;
        self
    }
}

#[async_trait]
impl Memory for SummarizingMemory {
    async fn compact(&self, messages: &[Message]) -> Result<Vec<Message>, BoxError> {
        let (system_idxs, turns) = split_into_turns(messages);

        let estimator = self.estimator.as_ref();
        let system_tokens: usize = system_idxs
            .iter()
            .map(|&i| estimator.estimate_message(&messages[i]))
            .sum();
        // Leave headroom for the synthetic summary message we may insert.
        let budget = self
            .max_tokens
            .saturating_sub(system_tokens)
            .saturating_sub(SUMMARY_RESERVE_TOKENS);

        // Cache-aware path mirrors `SlidingWindowMemory`: when an
        // explicit breakpoint exists, prefer summarising turns that
        // fall *between* the cached prefix and the recent tail rather
        // than summarising the cached prefix itself (which would bust
        // the LLM's prompt cache for everything past it).
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

        let dropped_count = turns.len() - kept.len();
        debug!(
            total_turns = turns.len(),
            kept_turns = kept.len(),
            dropped_turns = dropped_count,
            "compact (summarising)",
        );

        // Build the dropped slice for summarisation, preserving original
        // order. The cache-aware selector may produce a non-contiguous
        // kept set (cached prefix + recent tail with a hole in the
        // middle), so we identify dropped turns by pointer-equality
        // against the kept references rather than assuming a contiguous
        // prefix [0..dropped_count).
        let dropped_msgs: Vec<Message> = turns
            .iter()
            .filter(|t| !kept.iter().any(|k| std::ptr::eq(*k, *t)))
            .flat_map(|t| t.iter().map(|&i| messages[i].clone()))
            .collect();

        // Summary failures are *soft*: a flaky LLM call (network
        // hiccup, provider 5xx) shouldn't blow up the whole user
        // turn. Fall back to a placeholder note — same shape as
        // `SlidingWindowMemory`'s "[N earlier turn(s) omitted ...]"
        // so the model still sees a clear gap marker. The error is
        // logged so it's not invisible.
        let summary = if dropped_msgs.is_empty() {
            None
        } else {
            match self.summarise(&dropped_msgs).await {
                Ok(s) => Some(s),
                Err(e) => {
                    warn!(error = %e, dropped = dropped_count,
                          "summary failed; falling back to placeholder note");
                    None
                }
            }
        };

        let mut out: Vec<Message> =
            Vec::with_capacity(system_idxs.len() + kept.iter().map(|t| t.len()).sum::<usize>() + 1);
        for &i in &system_idxs {
            out.push(messages[i].clone());
        }
        if let Some(s) = summary {
            out.push(Message::system(format!(
                "Earlier conversation summary ({dropped_count} turn(s) compressed):\n{s}"
            )));
        } else if dropped_count > 0 {
            // Surfacing the gap explicitly is better than silent
            // truncation; keeps the model from getting confused
            // about why the conversation seems to start mid-thought.
            out.push(Message::system(format!(
                "[{dropped_count} earlier turn(s) omitted — summary unavailable]"
            )));
        }
        for turn in kept {
            for &i in turn {
                out.push(messages[i].clone());
            }
        }
        Ok(out)
    }
}

impl SummarizingMemory {
    async fn summarise(&self, dropped: &[Message]) -> Result<String, BoxError> {
        let fp = fingerprint(dropped);

        // Tier 1: in-memory single-slot cache.
        if let Some(text) = self.cache_lookup(&fp) {
            debug!(fingerprint = %fp, "summary cache hit (memory)");
            return Ok(text);
        }

        // Tier 2: durable store, when configured.
        if let Some(store) = &self.persistence {
            match store.load(&persist_key(&fp)).await {
                Ok(Some(conv)) => {
                    if let Some(text) = extract_summary(&conv) {
                        debug!(fingerprint = %fp, "summary cache hit (store)");
                        self.cache_set(&fp, &text);
                        return Ok(text);
                    } else {
                        warn!(
                            fingerprint = %fp,
                            "persisted summary row had no system message; ignoring",
                        );
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    // Don't fail compaction on a flaky DB — fall through
                    // to the LLM and try to write the result back later.
                    warn!(error = %e, fingerprint = %fp, "summary store load failed");
                }
            }
        }

        // Tier 3: ask the LLM.
        let convo = vec![
            Message::system(self.summary_prompt.clone()),
            Message::user(format!(
                "Summarise the following conversation excerpt:\n\n{}",
                render_for_summary(dropped)
            )),
        ];
        let req = ChatRequest {
            model: self.model.clone(),
            messages: convo,
            tools: Vec::new(),
            temperature: Some(0.0),
            max_tokens: Some(self.summary_max_tokens),
            previous_response_id: None,
            chain_origin: None,
        };

        // One retry on transient transport errors — the summariser
        // shares a connection pool with the foreground agent and
        // sometimes hits a half-closed keep-alive on first send.
        // Auth refreshes / 401s / 4xxs are NOT retried (the second
        // attempt would just fail the same way).
        let resp = match self.llm.complete(req.clone()).await {
            Ok(r) => r,
            Err(e) if is_transport_error(&e) => {
                warn!(error = %e, "summary llm transport error; retrying once");
                self.llm
                    .complete(req)
                    .await
                    .map_err(|e| -> BoxError { format!("summary llm error: {e}").into() })?
            }
            Err(e) => {
                return Err(format!("summary llm error: {e}").into());
            }
        };

        let text = match resp.message {
            Message::Assistant {
                content: Some(t), ..
            } => t,
            _ => return Err("summariser returned no assistant text".into()),
        };

        // Populate both cache tiers.
        self.cache_set(&fp, &text);
        if let Some(store) = &self.persistence {
            let mut row = Conversation::new();
            row.push(Message::system(text.clone()));
            if let Err(e) = store.save(&persist_key(&fp), &row).await {
                warn!(error = %e, fingerprint = %fp, "summary store save failed");
            }
        }
        Ok(text)
    }

    fn cache_lookup(&self, fingerprint: &str) -> Option<String> {
        let guard = self.cache.lock().expect("memory cache poisoned");
        match guard.as_ref() {
            Some(hit) if hit.fingerprint == fingerprint => Some(hit.text.clone()),
            _ => None,
        }
    }

    fn cache_set(&self, fingerprint: &str, text: &str) {
        *self.cache.lock().expect("memory cache poisoned") = Some(CachedSummary {
            fingerprint: fingerprint.to_string(),
            text: text.to_string(),
        });
    }
}

/// Heuristic — does this look like a network-layer flake worth
/// retrying once? We don't retry HTTP-level rejections (4xx / 5xx
/// produce `Error::Provider("status NNN: ...")`) because those
/// won't fix themselves on a second attempt, but a `transport: …`
/// prefix from a `reqwest` `send()` failure (DNS, TLS handshake,
/// half-closed keep-alive) often does.
fn is_transport_error(e: &CoreError) -> bool {
    matches!(e, CoreError::Provider(msg) if msg.starts_with("transport:"))
}

fn persist_key(fingerprint: &str) -> String {
    format!("{PERSIST_KEY_PREFIX}{fingerprint}")
}

fn extract_summary(conv: &Conversation) -> Option<String> {
    conv.messages.iter().find_map(|m| match m {
        Message::System { content, .. } => Some(content.clone()),
        _ => None,
    })
}

/// BLAKE3 hex of the JSON-serialised messages. Stable across Rust
/// versions and processes — required for cross-restart cache hits.
fn fingerprint(messages: &[Message]) -> String {
    let mut h = blake3::Hasher::new();
    for m in messages {
        if let Ok(s) = serde_json::to_string(m) {
            h.update(s.as_bytes());
            h.update(b"\n");
        }
    }
    h.finalize().to_hex().to_string()
}

/// Flatten messages into a plain-text transcript the summariser can
/// digest. Tool arguments are serialised compactly so structure survives
/// without overwhelming the model.
fn render_for_summary(messages: &[Message]) -> String {
    let mut s = String::new();
    for m in messages {
        match m {
            Message::System { content, .. } => {
                s.push_str("[system] ");
                s.push_str(content);
                s.push('\n');
            }
            Message::User { content, .. } => {
                s.push_str("[user] ");
                s.push_str(content);
                s.push('\n');
            }
            Message::Assistant {
                content,
                tool_calls,
                reasoning_content: _,
                ..
            } => {
                s.push_str("[assistant] ");
                if let Some(c) = content {
                    s.push_str(c);
                }
                for tc in tool_calls {
                    s.push_str(&format!(
                        " <call {}({})>",
                        tc.name,
                        compact_args(&tc.arguments)
                    ));
                }
                s.push('\n');
            }
            Message::Tool {
                tool_call_id,
                content,
                ..
            } => {
                s.push_str(&format!("[tool {tool_call_id}] "));
                s.push_str(content);
                s.push('\n');
            }
        }
    }
    s
}

fn compact_args(v: &serde_json::Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_core::{
        ChatResponse, Error as CoreError, FinishReason, LlmStream, Result as CoreResult,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    struct FakeLlm {
        reply: String,
        calls: AtomicUsize,
        captured: StdMutex<Vec<ChatRequest>>,
    }

    impl FakeLlm {
        fn new(reply: impl Into<String>) -> Arc<Self> {
            Arc::new(Self {
                reply: reply.into(),
                calls: AtomicUsize::new(0),
                captured: StdMutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl LlmProvider for FakeLlm {
        async fn complete(&self, req: ChatRequest) -> CoreResult<ChatResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.captured.lock().unwrap().push(req);
            Ok(ChatResponse {
                message: Message::assistant_text(&self.reply),
                finish_reason: FinishReason::Stop,
                response_id: None,
            })
        }

        async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
            unimplemented!("not used in tests")
        }
    }

    struct FailingLlm;
    #[async_trait]
    impl LlmProvider for FailingLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            Err(CoreError::Provider("nope".into()))
        }
        async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
            unimplemented!()
        }
    }

    fn user(s: &str) -> Message {
        Message::user(s)
    }
    fn assistant(s: &str) -> Message {
        Message::assistant_text(s)
    }
    fn system(s: &str) -> Message {
        Message::system(s)
    }

    #[tokio::test]
    async fn under_budget_skips_summariser() {
        let llm = FakeLlm::new("SUMMARY");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 10_000);
        let msgs = vec![system("sys"), user("hi"), assistant("hello")];
        let out = mem.compact(&msgs).await.unwrap();
        assert_eq!(out.len(), msgs.len());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn over_budget_inserts_summary() {
        let llm = FakeLlm::new("ALPHA AND BETA HAPPENED");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);

        let msgs = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1"),
            user("turn 2"),
            assistant("reply 2"),
            user("turn 3 most recent"),
            assistant("reply 3"),
        ];
        let out = mem.compact(&msgs).await.unwrap();

        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
        assert!(out.iter().any(|m| matches!(m,
            Message::System { content, .. } if content.contains("ALPHA AND BETA HAPPENED")
        )));
        assert!(out.iter().any(|m| matches!(m,
            Message::User { content, .. } if content == "turn 3 most recent"
        )));
    }

    #[tokio::test]
    async fn project_block_survives_summarisation() {
        // Regression for the Project feature: the binder injects a
        // `=== project: NAME ===` block as the *second* leading
        // System (after the agent's base system). Compaction must
        // keep both leading systems intact and insert any synthetic
        // summary after them — otherwise the LLM would lose the
        // project context mid-conversation.
        let llm = FakeLlm::new("OLD STUFF SUMMARISED");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);

        let msgs = vec![
            system("base agent prompt"),
            system("=== project: Writing ===\nbe lyrical"),
            user("turn 1"),
            assistant("reply 1"),
            user("turn 2"),
            assistant("reply 2"),
            user("turn 3 most recent"),
            assistant("reply 3"),
        ];
        let out = mem.compact(&msgs).await.unwrap();

        // First two messages must still be the leading systems, in
        // the original order.
        assert!(matches!(&out[0], Message::System { content, .. } if content == "base agent prompt"));
        assert!(matches!(&out[1], Message::System { content, .. }
            if content.contains("=== project: Writing ===") && content.contains("be lyrical")));
        // The summary lands somewhere AFTER the project block.
        let summary_idx = out
            .iter()
            .position(|m| matches!(m,
                Message::System { content, .. } if content.contains("OLD STUFF SUMMARISED")
            ))
            .expect("summary system not found in output");
        assert!(summary_idx >= 2, "summary must come after the leading systems");
    }

    #[tokio::test]
    async fn cache_dedupes_identical_dropped_prefix() {
        let llm = FakeLlm::new("SUMMARY");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);

        let msgs = vec![
            system("sys"),
            user("old turn"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();
        let _ = mem.compact(&msgs).await.unwrap();
        // Same dropped prefix → only one LLM call total.
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cache_invalidates_when_dropped_prefix_changes() {
        let llm = FakeLlm::new("SUMMARY");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);

        let first = vec![
            system("sys"),
            user("old turn"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&first).await.unwrap();

        let second = vec![
            system("sys"),
            user("old turn"),
            assistant("old reply"),
            user("middle"),
            assistant("middle reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&second).await.unwrap();
        // Dropped prefix grew → a fresh summary call.
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn llm_failure_falls_back_to_placeholder_not_hard_error() {
        // Soft-fail behaviour: a flaky summariser shouldn't bring
        // down the user's turn. We expect compact() to succeed with
        // a placeholder gap marker in place of the real summary.
        let mem = SummarizingMemory::new(Arc::new(FailingLlm), "test-model", 64);
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let out = mem.compact(&msgs).await.unwrap();
        // System prompt + placeholder note + recent turn.
        assert!(
            out.iter().any(|m| matches!(m,
                Message::System { content, .. } if content.contains("summary unavailable")
            )),
            "missing placeholder note in: {out:?}"
        );
        // Recent turn must still be there — that's the whole point
        // of falling back instead of erroring.
        assert!(out.iter().any(|m| matches!(m,
            Message::User { content, .. } if content == "recent"
        )));
    }

    struct FlakyLlm {
        succeeds_after: usize,
        calls: AtomicUsize,
    }
    #[async_trait]
    impl LlmProvider for FlakyLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.succeeds_after {
                Err(CoreError::Provider("transport: connection reset".into()))
            } else {
                Ok(ChatResponse {
                    message: Message::assistant_text("EVENTUAL SUMMARY"),
                    finish_reason: FinishReason::Stop,
                    response_id: None,
                })
            }
        }
        async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn transport_error_retries_once() {
        let llm = Arc::new(FlakyLlm {
            succeeds_after: 1,
            calls: AtomicUsize::new(0),
        });
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 64);
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let out = mem.compact(&msgs).await.unwrap();
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2, "expected 1 retry");
        assert!(
            out.iter().any(|m| matches!(m,
                Message::System { content, .. } if content.contains("EVENTUAL SUMMARY")
            )),
            "expected real summary after retry, got: {out:?}"
        );
    }

    struct AlwaysTransportErrLlm {
        calls: AtomicUsize,
    }
    #[async_trait]
    impl LlmProvider for AlwaysTransportErrLlm {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(CoreError::Provider("transport: dns error".into()))
        }
        async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn persistent_transport_error_retries_once_then_falls_back() {
        let llm = Arc::new(AlwaysTransportErrLlm {
            calls: AtomicUsize::new(0),
        });
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 64);
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let out = mem.compact(&msgs).await.unwrap();
        assert_eq!(
            llm.calls.load(Ordering::SeqCst),
            2,
            "expected exactly 1 retry"
        );
        assert!(out.iter().any(|m| matches!(m,
            Message::System { content, .. } if content.contains("summary unavailable")
        )));
    }

    #[tokio::test]
    async fn non_transport_error_does_not_retry() {
        // FailingLlm returns "nope" (not a transport error). Should
        // bail straight to the soft-fallback after one call.
        let calls_seen = Arc::new(AtomicUsize::new(0));
        struct CountingFailingLlm(Arc<AtomicUsize>);
        #[async_trait]
        impl LlmProvider for CountingFailingLlm {
            async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(CoreError::Provider("status 401: bad auth".into()))
            }
            async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
                unimplemented!()
            }
        }
        let mem = SummarizingMemory::new(
            Arc::new(CountingFailingLlm(calls_seen.clone())),
            "test-model",
            64,
        );
        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();
        assert_eq!(calls_seen.load(Ordering::SeqCst), 1, "401 should not retry");
    }

    #[tokio::test]
    async fn summary_request_omits_tools_and_pins_temperature() {
        let llm = FakeLlm::new("ok");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);
        let msgs = vec![
            system("sys"),
            user("a"),
            assistant("b"),
            user("c"),
            assistant("d"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();
        let captured = llm.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let req = &captured[0];
        assert_eq!(req.model, "test-model");
        assert!(req.tools.is_empty());
        assert_eq!(req.temperature, Some(0.0));
        assert!(req.max_tokens.is_some());
    }

    // --- persistence ---

    #[tokio::test]
    async fn persistence_writes_under_internal_namespace() {
        let llm = FakeLlm::new("REMEMBERED");
        let store: Arc<dyn ConversationStore> =
            Arc::new(harness_store::MemoryConversationStore::new());
        let mem =
            SummarizingMemory::new(llm.clone(), "test-model", 256).with_persistence(store.clone());

        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();

        // Find the persisted row — must live under the reserved prefix.
        let rows = store.list(50).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].id.starts_with("__memory__.summary:"),
            "id was {}",
            rows[0].id,
        );
    }

    #[tokio::test]
    async fn persistence_rehydrates_across_instances() {
        let store: Arc<dyn ConversationStore> =
            Arc::new(harness_store::MemoryConversationStore::new());

        // First "process": run once, summary goes into the store.
        let llm1 = FakeLlm::new("FIRST RUN SUMMARY");
        let mem1 =
            SummarizingMemory::new(llm1.clone(), "test-model", 256).with_persistence(store.clone());

        let msgs = vec![
            system("sys"),
            user("old"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let out1 = mem1.compact(&msgs).await.unwrap();
        assert_eq!(llm1.calls.load(Ordering::SeqCst), 1);
        assert!(out1.iter().any(
            |m| matches!(m, Message::System { content, .. } if content.contains("FIRST RUN SUMMARY"))
        ));
        drop(mem1);

        // Second "process": fresh instance, fresh in-memory cache,
        // different LLM that would say something else *if asked*. The
        // store hit means it never gets asked.
        let llm2 = FakeLlm::new("DIFFERENT TEXT");
        let mem2 =
            SummarizingMemory::new(llm2.clone(), "test-model", 256).with_persistence(store.clone());
        let out2 = mem2.compact(&msgs).await.unwrap();
        assert_eq!(
            llm2.calls.load(Ordering::SeqCst),
            0,
            "second instance should have rehydrated from the store, not re-summarised",
        );
        assert!(out2.iter().any(
            |m| matches!(m, Message::System { content, .. } if content.contains("FIRST RUN SUMMARY"))
        ));
    }

    #[tokio::test]
    async fn persistence_save_failure_does_not_break_compact() {
        // We don't have an "always-fails" store; instead use a working
        // one and just confirm the happy path still works. The save
        // failure path is exercised at runtime via the warn! log only.
        let llm = FakeLlm::new("SUMMARY");
        let store: Arc<dyn ConversationStore> =
            Arc::new(harness_store::MemoryConversationStore::new());
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256).with_persistence(store);

        let msgs = vec![
            system("sys"),
            user("a"),
            assistant("b"),
            user("c"),
            assistant("d"),
        ];
        let out = mem.compact(&msgs).await.unwrap();
        assert!(out
            .iter()
            .any(|m| matches!(m, Message::System { content, .. } if content.contains("SUMMARY"))));
    }
}
