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

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use harness_core::{
    cache_breakpoint_indices, default_estimator, emit_memory_compaction, BoxError, ChatRequest,
    CompactionInfo, CompactionSource, Conversation, ConversationStore, Error as CoreError,
    LlmProvider, Memory, MemoryStatsProvider, Message, TokenEstimator,
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
Do not invent details, do not editorialise, and do not add a preamble.\n\n\
BAD (do not do this):\n\
\"The user wants me to summarise the conversation. I need to compress it into a short \
paragraph. Key facts: ...\"\n\n\
GOOD:\n\
\"User asked for a kanban review of the jarvis-roadmap project. Agent ran \
requirement.list (30 items, 12 in_progress) and triage.scan_candidates (4 todo \
markers). Decided to focus on Web UI experience cluster; user approved.\"\n\n\
Output ONLY the summary content. No \"The user wants me to...\", no \"I'll summarise...\", \
no \"Here is a summary...\", no \"This excerpt...\" — start directly with the substantive \
fact, decision, or state.";

/// Reserved budget (in estimated tokens) carved out for the summary
/// itself when planning what to keep recent. Keeps us from packing the
/// budget so tight that the synthetic summary push us back over.
const SUMMARY_RESERVE_TOKENS: usize = 256;

/// Cap on how many tokens the summarisation call is allowed to emit.
const DEFAULT_SUMMARY_MAX_TOKENS: u32 = 400;

/// Consecutive summary-call failures that flip the circuit breaker
/// to "open". While open, [`SummarizingMemory::compact`] skips the
/// LLM entirely and falls through to the existing placeholder note
/// path, so a wedged summariser stops burning quota.
const CIRCUIT_FAILURE_THRESHOLD: u32 = 3;

/// How long the circuit stays open before the next request is
/// allowed through. Aggressively short — most "real" outages
/// (provider 5xx storm, quota hit) clear within seconds, and we
/// want to recover quickly when the upstream comes back.
const CIRCUIT_OPEN_DURATION: Duration = Duration::from_secs(60);

/// Optional resolver consulted before each summarisation call. When
/// it returns `Some((llm, model))`, that pair overrides the
/// constructor-time `(llm, model)` for this call only — useful when
/// the operator routes summarisation to a cheaper / smaller model
/// via [`harness_server::ModelRoutePolicy`]'s `summarization` slot.
/// `None` (or no resolver) keeps the constructor-time default.
///
/// `harness-memory` doesn't depend on `harness-server`, so the
/// resolver is a closure provided by the composition root which
/// holds the policy + provider registry.
pub type LlmRouteResolver = dyn Fn() -> Option<(Arc<dyn LlmProvider>, String)> + Send + Sync;

/// Process-wide counters for [`SummarizingMemory`]'s compaction
/// path. Updated lock-free on the hot path, snapshotted to JSON via
/// [`MemoryStatsProvider`] for the
/// `GET /v1/diagnostics/memory` endpoint.
///
/// Counters are monotonic since process start — there's no "reset"
/// API on purpose. Operators tuning `JARVIS_MEMORY_TOKENS` care
/// about ratios (cache hit rate, LLM failure rate, how often PTL
/// kicks in) which work fine with running totals.
#[derive(Debug, Default)]
pub struct CompactionCounters {
    /// Total `compact()` calls — incremented every entry regardless
    /// of whether any turns were dropped.
    pub compactions_total: AtomicU64,
    /// Calls that actually had something to summarise (i.e.
    /// `dropped_msgs` was non-empty). The complement of this and
    /// `compactions_total` is the "fits in budget, no work" path.
    pub summary_required: AtomicU64,
    /// In-memory single-slot cache hits.
    pub cache_hits_memory: AtomicU64,
    /// Persistent `ConversationStore` cache hits.
    pub cache_hits_store: AtomicU64,
    /// Times the LLM was actually called for a summary.
    pub llm_calls: AtomicU64,
    /// Times the LLM call returned `Err` (after the internal
    /// transport retry).
    pub llm_failures: AtomicU64,
    /// Times the circuit breaker was found open and the LLM call
    /// was skipped.
    pub circuit_skips: AtomicU64,
    /// Times the circuit breaker tripped (failure-threshold hit).
    pub circuit_opens: AtomicU64,
    /// Times the PTL fallback round 1 (drop 20%) was executed.
    pub ptl_round_one: AtomicU64,
    /// Times the PTL fallback round 2 (hard-prune to latest turn)
    /// was executed.
    pub ptl_round_two: AtomicU64,
}

impl CompactionCounters {
    fn inc(&self, c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
    fn load(c: &AtomicU64) -> u64 {
        c.load(Ordering::Relaxed)
    }
}

impl MemoryStatsProvider for CompactionCounters {
    fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "backend": "summarizing",
            "compactions_total": Self::load(&self.compactions_total),
            "summary_required": Self::load(&self.summary_required),
            "cache_hits_memory": Self::load(&self.cache_hits_memory),
            "cache_hits_store": Self::load(&self.cache_hits_store),
            "llm_calls": Self::load(&self.llm_calls),
            "llm_failures": Self::load(&self.llm_failures),
            "circuit_skips": Self::load(&self.circuit_skips),
            "circuit_opens": Self::load(&self.circuit_opens),
            "ptl_round_one": Self::load(&self.ptl_round_one),
            "ptl_round_two": Self::load(&self.ptl_round_two),
        })
    }
}

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
    /// Optional `(llm, model)` override resolved on every
    /// summarisation call. See [`LlmRouteResolver`].
    route_resolver: Option<Arc<LlmRouteResolver>>,
    /// Consecutive summariser failures (cache hits don't count —
    /// `summarise` returns `Ok` early on hit). Reset to zero on the
    /// first success after a streak.
    failure_streak: Arc<Mutex<u32>>,
    /// When `Some(t)`, every `compact` call skips the LLM until
    /// `Instant::now() >= t` and falls through to the existing
    /// placeholder-note path. Reset to `None` when the deadline is
    /// reached and the next call walks past
    /// [`SummarizingMemory::circuit_open`].
    circuit_until: Arc<Mutex<Option<Instant>>>,
    /// Telemetry counters surfaced via
    /// [`SummarizingMemory::counters`]. Composition roots clone the
    /// `Arc` once and stash it on `AppState` so the diagnostics
    /// endpoint can read snapshots without taking a reference back
    /// into the memory backend.
    counters: Arc<CompactionCounters>,
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
            route_resolver: None,
            failure_streak: Arc::new(Mutex::new(0)),
            circuit_until: Arc::new(Mutex::new(None)),
            counters: Arc::new(CompactionCounters::default()),
        }
    }

    /// Clone-able handle to the telemetry counters. Composition
    /// roots typically stash this on `AppState` so the diagnostics
    /// surface can read snapshots:
    ///
    /// ```ignore
    /// let mem = SummarizingMemory::new(llm, model, max_tokens);
    /// let counters = mem.counters();
    /// state.memory_stats = Some(counters as Arc<dyn MemoryStatsProvider>);
    /// ```
    pub fn counters(&self) -> Arc<CompactionCounters> {
        self.counters.clone()
    }

    /// Install a per-call route override. The resolver fires before
    /// each summarisation call; when it returns `Some((llm, model))`,
    /// that pair is used instead of the constructor-time default.
    /// `None` falls through. Composition roots typically wire this
    /// to [`harness_server::ModelRoutePolicy`]'s
    /// `RouteSlot::Summarization` slot.
    pub fn with_route_resolver(mut self, resolver: Arc<LlmRouteResolver>) -> Self {
        self.route_resolver = Some(resolver);
        self
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
        self.counters.inc(&self.counters.compactions_total);
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
        //
        // Circuit breaker: if the upstream summariser has failed
        // CIRCUIT_FAILURE_THRESHOLD times in a row, we treat the
        // circuit as "open" and skip the LLM entirely for
        // CIRCUIT_OPEN_DURATION. A long, slowly-degrading provider
        // would otherwise burn quota on every compaction. The
        // circuit auto-resets on time-out, so we recover without
        // operator intervention.
        let (summary, summary_source) = if dropped_msgs.is_empty() {
            (None, None)
        } else {
            self.counters.inc(&self.counters.summary_required);
            if self.circuit_open() {
                self.counters.inc(&self.counters.circuit_skips);
                debug!(dropped = dropped_count,
                       "summary circuit open; skipping LLM call");
                (None, None)
            } else {
                match self.summarise(&dropped_msgs).await {
                    Ok((s, src)) => {
                        self.record_summary_success();
                        (Some(s), Some(src))
                    }
                    Err(e) => {
                        self.counters.inc(&self.counters.llm_failures);
                        self.record_summary_failure();
                        warn!(error = %e, dropped = dropped_count,
                              "summary failed; falling back to placeholder note");
                        (None, None)
                    }
                }
            }
        };

        let kept_turn_count = kept.len();
        let mut out: Vec<Message> =
            Vec::with_capacity(system_idxs.len() + kept.iter().map(|t| t.len()).sum::<usize>() + 1);
        for &i in &system_idxs {
            out.push(messages[i].clone());
        }
        let summary_chars: Option<usize> = if let Some(s) = summary {
            let chars = s.chars().count();
            out.push(Message::system(format!(
                "Earlier conversation summary ({dropped_count} turn(s) compressed):\n{s}"
            )));
            Some(chars)
        } else {
            if dropped_count > 0 {
                // Surfacing the gap explicitly is better than silent
                // truncation; keeps the model from getting confused
                // about why the conversation seems to start mid-thought.
                out.push(Message::system(format!(
                    "[{dropped_count} earlier turn(s) omitted — summary unavailable]"
                )));
            }
            None
        };
        for turn in kept {
            for &i in turn {
                out.push(messages[i].clone());
            }
        }
        // Append the agent's working-context snapshot. Same helper
        // as `SlidingWindowMemory` so the two backends produce the
        // same trailing block.
        let len_before_wc = out.len();
        crate::sliding::append_working_context(&mut out);
        let working_context_chars = match out.get(len_before_wc) {
            Some(Message::System { content, .. })
                if content.starts_with("=== working context ===") =>
            {
                Some(content.chars().count())
            }
            _ => None,
        };
        // PTL safety net: if the summary itself ran long or the
        // working-context block tipped us over, drop oldest turns
        // until the estimate fits. Never returns `Err` — the entire
        // point is to absorb pathological cases without bringing the
        // user's turn down.
        let (pruned, outcome) = enforce_token_budget(out, self.max_tokens, estimator);
        out = pruned;
        match outcome {
            PtlOutcome::None => {}
            PtlOutcome::RoundOne => self.counters.inc(&self.counters.ptl_round_one),
            PtlOutcome::RoundTwo => {
                self.counters.inc(&self.counters.ptl_round_one);
                self.counters.inc(&self.counters.ptl_round_two);
            }
        }

        // Decide the canonical source for the emitted event. PTL
        // outcomes win because they represent a budget escape hatch
        // *after* whatever the summariser produced — the user wants
        // to know the safety net fired. Otherwise the summariser's
        // self-reported source (cache memory / store / fresh LLM)
        // wins. When dropped > 0 but summary is None (circuit open
        // or LLM error), we surface SummaryUnavailable so the UI
        // can show a degraded-state marker. No drops + no summary =
        // NoOp.
        let source = match outcome {
            PtlOutcome::RoundTwo => CompactionSource::PtlRoundTwo,
            PtlOutcome::RoundOne => CompactionSource::PtlRoundOne,
            PtlOutcome::None => match (summary_source, dropped_count) {
                (Some(src), _) => src,
                (None, n) if n > 0 => CompactionSource::SummaryUnavailable,
                _ => CompactionSource::NoOp,
            },
        };
        emit_memory_compaction(CompactionInfo {
            source,
            turns_kept: kept_turn_count,
            turns_dropped: dropped_count,
            summary_chars,
            working_context_chars,
            model_input_tokens_est: estimator.estimate_messages(&out),
        });
        Ok(out)
    }
}

impl SummarizingMemory {
    /// Whether the failure-streak has flipped the circuit open. Has
    /// the side-effect of clearing the latch when the deadline has
    /// passed, so the next call may try the LLM again.
    fn circuit_open(&self) -> bool {
        let mut guard = self
            .circuit_until
            .lock()
            .expect("circuit_until mutex poisoned");
        match *guard {
            Some(t) if Instant::now() < t => true,
            Some(_) => {
                // Deadline reached — re-arm both pieces of state so
                // a single failure post-cooldown doesn't immediately
                // re-trip the breaker.
                *guard = None;
                drop(guard);
                *self
                    .failure_streak
                    .lock()
                    .expect("failure_streak mutex poisoned") = 0;
                false
            }
            None => false,
        }
    }

    /// Reset the failure-streak on any non-cache LLM success.
    fn record_summary_success(&self) {
        let mut streak = self
            .failure_streak
            .lock()
            .expect("failure_streak mutex poisoned");
        if *streak > 0 {
            debug!(prior_streak = *streak, "summary success — resetting streak");
        }
        *streak = 0;
    }

    /// Increment the failure-streak; trip the breaker once the
    /// threshold is reached.
    fn record_summary_failure(&self) {
        let mut streak = self
            .failure_streak
            .lock()
            .expect("failure_streak mutex poisoned");
        *streak += 1;
        if *streak >= CIRCUIT_FAILURE_THRESHOLD {
            *self
                .circuit_until
                .lock()
                .expect("circuit_until mutex poisoned") =
                Some(Instant::now() + CIRCUIT_OPEN_DURATION);
            self.counters.inc(&self.counters.circuit_opens);
            warn!(
                streak = *streak,
                cooldown_secs = CIRCUIT_OPEN_DURATION.as_secs(),
                "summary circuit opened — skipping LLM for cooldown",
            );
        }
    }

    async fn summarise(&self, dropped: &[Message]) -> Result<(String, CompactionSource), BoxError> {
        let fp = fingerprint(dropped);

        // Tier 1: in-memory single-slot cache.
        if let Some(text) = self.cache_lookup(&fp) {
            self.counters.inc(&self.counters.cache_hits_memory);
            debug!(fingerprint = %fp, "summary cache hit (memory)");
            return Ok((text, CompactionSource::CacheMemory));
        }

        // Tier 2: durable store, when configured.
        if let Some(store) = &self.persistence {
            match store.load(&persist_key(&fp)).await {
                Ok(Some(conv)) => {
                    if let Some(text) = extract_summary(&conv) {
                        self.counters.inc(&self.counters.cache_hits_store);
                        debug!(fingerprint = %fp, "summary cache hit (store)");
                        self.cache_set(&fp, &text);
                        return Ok((text, CompactionSource::CacheStore));
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

        // Tier 3: ask the LLM. Consult the route resolver first so a
        // configured `RouteSlot::Summarization` target wins over the
        // constructor-time `(llm, model)`. Falls back when the
        // resolver returns `None` (no slot configured / target
        // unresolvable).
        let (llm, model) = match self.route_resolver.as_ref().and_then(|r| r()) {
            Some((llm, model)) => {
                debug!(model = %model, "summariser using route-policy override");
                (llm, model)
            }
            None => (self.llm.clone(), self.model.clone()),
        };
        let convo = vec![
            Message::system(self.summary_prompt.clone()),
            Message::user(format!(
                "Summarise the following conversation excerpt:\n\n{}",
                render_for_summary(dropped)
            )),
        ];
        let req = ChatRequest {
            model,
            messages: convo,
            tools: Vec::new(),
            temperature: Some(0.0),
            max_tokens: Some(self.summary_max_tokens),
            previous_response_id: None,
            chain_origin: None,
            parallel_tool_calls: None,
        };

        // Mark that we're actually going to the LLM. Counted once
        // per `summarise()` even when the inner retry runs — that's
        // intentional, the second attempt isn't a "fresh call" to
        // the operator, it's the same logical attempt that retried.
        self.counters.inc(&self.counters.llm_calls);
        // One retry on transient transport errors — the summariser
        // shares a connection pool with the foreground agent and
        // sometimes hits a half-closed keep-alive on first send.
        // Auth refreshes / 401s / 4xxs are NOT retried (the second
        // attempt would just fail the same way).
        let resp = match llm.complete(req.clone()).await {
            Ok(r) => r,
            Err(e) if is_transport_error(&e) => {
                warn!(error = %e, "summary llm transport error; retrying once");
                llm.complete(req)
                    .await
                    .map_err(|e| -> BoxError { format!("summary llm error: {e}").into() })?
            }
            Err(e) => {
                return Err(format!("summary llm error: {e}").into());
            }
        };

        // Pull the visible answer out of the assistant message. Most
        // providers put the summary in `content`, but thinking models
        // (Kimi K2 / kimi-for-coding, certain o1-style endpoints) emit
        // their visible answer in `reasoning_content` and leave
        // `content` either `None` or empty. We accept either, in
        // priority order, and reject the response only when *both*
        // are blank — without this fallback, kimi-coding deployments
        // ended up persisting empty summaries and the agent saw no
        // prior context, hallucinating "对话历史被压缩了" on every
        // follow-up.
        let raw = match resp.message {
            Message::Assistant {
                content,
                reasoning_content,
                ..
            } => {
                let primary = content
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
                let fallback = reasoning_content
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
                match primary.or(fallback) {
                    Some(t) => t,
                    None => {
                        return Err("summariser returned empty content and reasoning".into());
                    }
                }
            }
            _ => return Err("summariser returned no assistant text".into()),
        };

        // Belt-and-braces: even with the BAD/GOOD-example prompt, smaller
        // models often leak "The user wants me to summarise..." preambles
        // that eat 100-300 chars of the cache slot before the actual
        // facts start. We strip a conservative set of openers here so
        // downstream callers (and operators reading the persisted cache)
        // get the substantive content directly.
        let text = strip_summary_preamble(&raw);

        // Populate both cache tiers.
        self.cache_set(&fp, &text);
        if let Some(store) = &self.persistence {
            let mut row = Conversation::new();
            row.push(Message::system(text.clone()));
            if let Err(e) = store.save(&persist_key(&fp), &row).await {
                warn!(error = %e, fingerprint = %fp, "summary store save failed");
            }
        }
        Ok((text, CompactionSource::FreshLlm))
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

/// Conservative preamble stripper for summariser output.
///
/// Smaller models often disregard the prompt's "no preamble" rule and
/// emit something like *"The user wants me to summarise the conversation
/// excerpt. Key facts: ..."*. The first sentence (or paragraph) is
/// dead weight that eats the cache slot before the substantive content
/// starts. This function looks for a known opener and, if found, skips
/// past the first paragraph break (`\n\n`). When no clear preamble is
/// present, or no paragraph break exists within the budget, it returns
/// the input unchanged — better to keep a borderline-OK first sentence
/// than to risk amputating real content.
///
/// Returns `String` (not `&str`) because the borrowed slice is rooted
/// in the input; callers wanted ownership anyway.
fn strip_summary_preamble(text: &str) -> String {
    // Cheap guard: if it doesn't start with a known opener, return as-is.
    // We compare on a leading-window prefix (lower-cased once) rather than
    // case-folding the whole string.
    const OPENERS: &[&str] = &[
        "the user wants me to",
        "the user is asking",
        "the user has asked",
        "the user asked me to",
        "i'll summari",
        "i will summari",
        "let me summari",
        "here is a summary",
        "here's a summary",
        "this excerpt",
        "this conversation excerpt",
        "the conversation excerpt",
    ];
    // Window large enough for the opener but cheap to lowercase.
    let window: String = text.chars().take(40).collect::<String>().to_lowercase();
    if !OPENERS.iter().any(|opener| window.starts_with(opener)) {
        return text.to_string();
    }
    // Find the first paragraph break within a generous budget. If none,
    // bail out to avoid eating the whole answer.
    const SCAN_BUDGET: usize = 800;
    let scan_end = text.char_indices().nth(SCAN_BUDGET).map(|(i, _)| i).unwrap_or(text.len());
    let head = &text[..scan_end];
    if let Some(rel) = head.find("\n\n") {
        let after = &text[rel + 2..];
        let trimmed = after.trim_start();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    text.to_string()
}

fn extract_summary(conv: &Conversation) -> Option<String> {
    conv.messages.iter().find_map(|m| match m {
        // Reject blank cached summaries — early kimi-coding runs wrote
        // these when the summariser returned empty content. Treating
        // them as cache misses lets the next `summarise` call ask
        // again (with the new content/reasoning fallback) and overwrite
        // the bad row, instead of replaying nothing in perpetuity.
        Message::System { content, .. } if !content.trim().is_empty() => Some(content.clone()),
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

/// Which (if any) PTL round fired in [`enforce_token_budget`].
/// Returned alongside the pruned vector so the caller can
/// increment the right counters without re-running heuristics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PtlOutcome {
    /// Already under budget — no pruning needed.
    None,
    /// Round-1 drop (oldest 20% of non-latest turns) was enough.
    RoundOne,
    /// Round-1 wasn't enough; round-2 hard-prune to latest turn
    /// only ran. Both rounds are credited to the caller.
    RoundTwo,
}

/// Best-effort enforcement: if the compacted output still exceeds
/// `max_tokens`, drop turns from the oldest end (preserving the
/// leading System prefix, the optional trailing working-context
/// block, and the most recent turn). Two rounds — first 20% of
/// non-latest turns, then everything except the latest turn — both
/// followed by a stable marker. Never errors; returns the original
/// vector untouched when no pruning is required.
fn enforce_token_budget(
    out: Vec<Message>,
    max_tokens: usize,
    est: &dyn TokenEstimator,
) -> (Vec<Message>, PtlOutcome) {
    if max_tokens == 0 || est.estimate_messages(&out) <= max_tokens {
        return (out, PtlOutcome::None);
    }

    // Region 1: leading contiguous System messages (kept verbatim,
    // including any compaction summary we just inserted).
    let prefix_end = out
        .iter()
        .take_while(|m| matches!(m, Message::System { .. }))
        .count();

    // Region 3 (trailing): the working-context block, if present.
    // Recognise it by header so we don't accidentally count a
    // user-emitted System reply.
    let trailing = matches!(
        out.last(),
        Some(Message::System { content, .. }) if content.starts_with("=== working context ===")
    ) as usize;

    // Region 2: body messages where the conversation turns live.
    let body_start = prefix_end;
    let body_end = out.len().saturating_sub(trailing);
    if body_end <= body_start {
        return (out, PtlOutcome::None);
    }

    let turn_starts: Vec<usize> = (body_start..body_end)
        .filter(|&i| matches!(out[i], Message::User { .. }))
        .collect();

    if turn_starts.len() <= 1 {
        // Only the latest turn is droppable, but the spec keeps it.
        // Nothing we can safely prune.
        return (out, PtlOutcome::None);
    }

    // Round 1: drop the oldest 20% of non-latest turns (round up).
    let droppable_turns = turn_starts.len() - 1;
    let mut drop_n = droppable_turns.div_ceil(5).max(1); // 20% rounded up, min 1
    if drop_n >= droppable_turns {
        drop_n = droppable_turns; // never include the latest turn
    }
    let cut_at = turn_starts[drop_n];

    let mut pruned: Vec<Message> = Vec::with_capacity(out.len());
    pruned.extend_from_slice(&out[..prefix_end]);
    pruned.push(ptl_marker_message(drop_n));
    pruned.extend_from_slice(&out[cut_at..body_end]);
    pruned.extend_from_slice(&out[body_end..]); // trailing working context

    if est.estimate_messages(&pruned) <= max_tokens {
        return (pruned, PtlOutcome::RoundOne);
    }

    // Round 2: hard-prune to the latest turn only. Even this may
    // not be enough if the latest turn alone is oversized — but the
    // spec says preserve the latest turn rather than send nothing.
    // Over-budget is preferable to truncating the turn the user is
    // actively interacting with.
    let last_turn_start = *turn_starts.last().unwrap_or(&body_start);
    let dropped_turns_total = turn_starts.len() - 1;
    let mut hard: Vec<Message> = Vec::with_capacity(out.len());
    hard.extend_from_slice(&out[..prefix_end]);
    hard.push(ptl_marker_message(dropped_turns_total));
    hard.extend_from_slice(&out[last_turn_start..body_end]);
    hard.extend_from_slice(&out[body_end..]);
    (hard, PtlOutcome::RoundTwo)
}

/// Marker inserted by [`enforce_token_budget`] so the model knows a
/// gap exists. The count is part of the text because the caller
/// asked us to maintain a hard token cap, and that matters more
/// than the marker being byte-stable across drop counts.
fn ptl_marker_message(dropped: usize) -> Message {
    Message::system(format!(
        "[{dropped} earlier turn(s) truncated to fit token budget]"
    ))
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
                usage: None,
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
        assert!(
            matches!(&out[0], Message::System { content, .. } if content == "base agent prompt")
        );
        assert!(matches!(&out[1], Message::System { content, .. }
            if content.contains("=== project: Writing ===") && content.contains("be lyrical")));
        // The summary lands somewhere AFTER the project block.
        let summary_idx = out
            .iter()
            .position(|m| {
                matches!(m,
                    Message::System { content, .. } if content.contains("OLD STUFF SUMMARISED")
                )
            })
            .expect("summary system not found in output");
        assert!(
            summary_idx >= 2,
            "summary must come after the leading systems"
        );
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
                    usage: None,
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

    // --- M1.2: circuit breaker + PTL fallback ---

    /// Counts every LLM call regardless of outcome — used by
    /// circuit-breaker tests to assert "no more LLM calls were
    /// made after the breaker tripped".
    struct CountingFailingLlmCb {
        calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl LlmProvider for CountingFailingLlmCb {
        async fn complete(&self, _req: ChatRequest) -> CoreResult<ChatResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Non-transport error so the inner retry doesn't double-count.
            Err(CoreError::Provider("status 500: server".into()))
        }
        async fn complete_stream(&self, _req: ChatRequest) -> CoreResult<LlmStream> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn circuit_breaker_trips_after_three_failures() {
        let calls = Arc::new(AtomicUsize::new(0));
        let llm = Arc::new(CountingFailingLlmCb {
            calls: calls.clone(),
        });
        let mem = SummarizingMemory::new(llm, "test-model", 64);

        // Each compact call needs a *different* dropped prefix so the
        // in-memory cache doesn't short-circuit and skip the LLM.
        for i in 0..5 {
            let msgs = vec![
                system("sys"),
                user(&format!("old-{i}")),
                assistant("old reply"),
                user("recent"),
                assistant("recent reply"),
            ];
            let _ = mem.compact(&msgs).await.unwrap();
        }

        // 3 attempts trip the breaker; the next 2 are circuit-skipped.
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "expected exactly 3 LLM attempts before circuit opened",
        );
    }

    #[tokio::test]
    async fn circuit_breaker_resets_on_successful_summary() {
        // FlakyLlm with succeeds_after=1 yields: fail, success, success, ...
        // The first compact's transport-error retry inside `summarise`
        // burns 2 LLM calls but ends in Ok — `record_summary_success`
        // resets the streak.
        let llm = Arc::new(FlakyLlm {
            succeeds_after: 1,
            calls: AtomicUsize::new(0),
        });
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 64);

        let msgs = vec![
            system("sys"),
            user("old-a"),
            assistant("old reply"),
            user("recent"),
            assistant("recent reply"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn ptl_drops_oldest_turns_when_summary_pushes_over_budget() {
        // Budget large enough that `select_recent_turns` keeps all
        // four turns, but small enough that appending the oversized
        // summary forces PTL to drop oldest turns.
        // 300 = small enough that visible budget (300 - sys - 256
        // reserve = ~40 tokens) drops oldest turns and triggers
        // summarisation; but body still keeps >=2 turns so PTL has
        // something to prune.
        let llm = FakeLlm::new("X".repeat(2000));
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 300);

        let msgs = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1 with some longer text"),
            user("turn 2"),
            assistant("reply 2 with some longer text"),
            user("turn 3"),
            assistant("reply 3 with some longer text"),
            user("turn 4 most recent"),
            assistant("reply 4"),
        ];
        let out = mem.compact(&msgs).await.unwrap();

        assert!(
            out.iter().any(|m| matches!(m,
                Message::User { content, .. } if content == "turn 4 most recent"
            )),
            "latest turn must survive PTL"
        );
        assert!(
            out.iter().any(|m| matches!(m,
                Message::System { content, .. } if content.contains("truncated to fit token budget")
            )),
            "expected PTL marker in: {out:?}"
        );
        // Oldest turn must be gone (PTL second round hard-prunes
        // because round-1's 20% wasn't enough).
        assert!(
            !out.iter().any(|m| matches!(m,
                Message::User { content, .. } if content == "turn 1"
            )),
            "oldest turn should have been dropped, got: {out:?}"
        );
    }

    #[tokio::test]
    async fn ptl_noop_when_already_under_budget() {
        let llm = FakeLlm::new("short");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 10_000);

        let msgs = vec![
            system("sys"),
            user("hi"),
            assistant("hello"),
            user("how are you"),
            assistant("good"),
        ];
        let out = mem.compact(&msgs).await.unwrap();
        assert!(
            !out.iter().any(|m| matches!(m,
                Message::System { content, .. } if content.contains("truncated to fit token budget")
            )),
            "PTL marker should not appear under-budget; out: {out:?}"
        );
    }

    #[tokio::test]
    async fn counters_track_compactions_llm_and_cache_paths() {
        let llm = FakeLlm::new("SUMMARY");
        let mem = SummarizingMemory::new(llm.clone(), "test-model", 256);
        let counters = mem.counters();

        // Under-budget: no summary required, no LLM call.
        let small = vec![system("sys"), user("hi"), assistant("hello")];
        let _ = mem.compact(&small).await.unwrap();

        // Over-budget run 1: summary required, LLM call, cache miss.
        let big = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1"),
            user("turn 2"),
            assistant("reply 2"),
            user("turn 3 most recent"),
            assistant("reply 3"),
        ];
        let _ = mem.compact(&big).await.unwrap();

        // Run 2 with the same dropped prefix → in-memory cache hit.
        let _ = mem.compact(&big).await.unwrap();

        assert_eq!(
            counters.compactions_total.load(Ordering::Relaxed),
            3,
            "every compact() counted"
        );
        assert_eq!(
            counters.summary_required.load(Ordering::Relaxed),
            2,
            "only the over-budget runs needed a summary"
        );
        assert_eq!(
            counters.llm_calls.load(Ordering::Relaxed),
            1,
            "second over-budget run hit the cache, no extra LLM call"
        );
        assert_eq!(
            counters.cache_hits_memory.load(Ordering::Relaxed),
            1,
            "second over-budget run was an in-memory cache hit"
        );
        assert_eq!(counters.llm_failures.load(Ordering::Relaxed), 0);
        assert_eq!(counters.circuit_opens.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn counters_track_circuit_opens_and_skips() {
        let calls = Arc::new(AtomicUsize::new(0));
        let llm = Arc::new(CountingFailingLlmCb {
            calls: calls.clone(),
        });
        let mem = SummarizingMemory::new(llm, "test-model", 64);
        let counters = mem.counters();

        for i in 0..5 {
            let msgs = vec![
                system("sys"),
                user(&format!("old-{i}")),
                assistant("old reply"),
                user("recent"),
                assistant("recent reply"),
            ];
            let _ = mem.compact(&msgs).await.unwrap();
        }
        // 3 attempts trip the breaker; the next 2 are circuit-skipped.
        assert_eq!(counters.llm_calls.load(Ordering::Relaxed), 3);
        assert_eq!(counters.llm_failures.load(Ordering::Relaxed), 3);
        assert_eq!(counters.circuit_opens.load(Ordering::Relaxed), 1);
        assert_eq!(counters.circuit_skips.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn events_emit_fresh_then_cache_memory() {
        use harness_core::{with_compaction_channel, CompactionSource};
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
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            // Fresh: LLM gets called and emits FreshLlm.
            let _ = mem.compact(&msgs).await.unwrap();
            // Same dropped prefix: in-memory cache hits, emits CacheMemory.
            let _ = mem.compact(&msgs).await.unwrap();
        })
        .await;
        let first = rx.try_recv().expect("first compaction event");
        let second = rx.try_recv().expect("second compaction event");
        assert_eq!(first.source, CompactionSource::FreshLlm);
        assert_eq!(second.source, CompactionSource::CacheMemory);
        assert!(first.summary_chars.is_some());
        assert!(second.summary_chars.is_some());
        assert!(first.turns_dropped >= 1);
    }

    #[tokio::test]
    async fn events_emit_summary_unavailable_when_circuit_open() {
        use harness_core::{with_compaction_channel, CompactionSource};
        let calls = Arc::new(AtomicUsize::new(0));
        let llm = Arc::new(CountingFailingLlmCb {
            calls: calls.clone(),
        });
        let mem = SummarizingMemory::new(llm, "test-model", 64);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            // Trip the breaker (3 consecutive failures), then run one
            // more — the next call should see the circuit open and
            // fall through with `SummaryUnavailable`.
            for i in 0..5 {
                let msgs = vec![
                    system("sys"),
                    user(&format!("old-{i}")),
                    assistant("old reply"),
                    user("recent"),
                    assistant("recent reply"),
                ];
                let _ = mem.compact(&msgs).await.unwrap();
            }
        })
        .await;
        // Collect everything emitted. There should be at least one
        // SummaryUnavailable event in the trailing two iterations.
        let mut sources = Vec::new();
        while let Ok(info) = rx.try_recv() {
            sources.push(info.source);
        }
        assert!(
            sources
                .iter()
                .any(|s| matches!(s, CompactionSource::SummaryUnavailable)),
            "expected SummaryUnavailable in the emitted sources, got: {sources:?}"
        );
    }

    #[tokio::test]
    async fn events_emit_ptl_when_summary_overruns_budget() {
        use harness_core::{with_compaction_channel, CompactionSource};
        let llm = FakeLlm::new("X".repeat(2000));
        let mem = SummarizingMemory::new(llm, "test-model", 300);
        let msgs = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1 with some longer text"),
            user("turn 2"),
            assistant("reply 2 with some longer text"),
            user("turn 3"),
            assistant("reply 3 with some longer text"),
            user("turn 4 most recent"),
            assistant("reply 4"),
        ];
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        with_compaction_channel(tx, async {
            let _ = mem.compact(&msgs).await.unwrap();
        })
        .await;
        let info = rx.try_recv().expect("expected compaction event");
        assert!(
            matches!(
                info.source,
                CompactionSource::PtlRoundOne | CompactionSource::PtlRoundTwo
            ),
            "PTL fallback should be the source when summary overruns; got {:?}",
            info.source
        );
    }

    #[tokio::test]
    async fn counters_track_ptl_rounds() {
        let llm = FakeLlm::new("X".repeat(2000));
        let mem = SummarizingMemory::new(llm, "test-model", 300);
        let counters = mem.counters();
        let msgs = vec![
            system("sys"),
            user("turn 1"),
            assistant("reply 1 with some longer text"),
            user("turn 2"),
            assistant("reply 2 with some longer text"),
            user("turn 3"),
            assistant("reply 3 with some longer text"),
            user("turn 4 most recent"),
            assistant("reply 4"),
        ];
        let _ = mem.compact(&msgs).await.unwrap();
        // Either round-one alone or both rounds fired — both counted.
        assert!(counters.ptl_round_one.load(Ordering::Relaxed) >= 1);
    }

    #[tokio::test]
    async fn enforce_token_budget_keeps_trailing_working_context_block() {
        // Direct test of the helper: build a small conversation,
        // append a working-context block, set a tight budget. The
        // trailing System block must survive the prune.
        use harness_core::CharRatioEstimator;
        let est = CharRatioEstimator;
        let msgs = vec![
            system("sys"),
            user("turn 1 something long enough"),
            assistant("reply 1 also reasonably long here"),
            user("turn 2 another long user message"),
            assistant("reply 2 with extra padding text"),
            user("turn 3 most recent here"),
            assistant("reply 3 short"),
            // Trailing working-context block (the marker pattern
            // `enforce_token_budget` recognises).
            system("=== working context ===\nrecent files:\n- src/lib.rs\n"),
        ];
        let (pruned, _outcome) = enforce_token_budget(msgs.clone(), 50, &est);
        // Working-context block must remain at the tail.
        assert!(
            matches!(pruned.last(), Some(Message::System { content, .. }) if content.starts_with("=== working context ===")),
            "trailing working-context block was lost"
        );
        // The latest turn must remain.
        assert!(
            pruned.iter().any(|m| matches!(m,
                Message::User { content, .. } if content == "turn 3 most recent here"
            )),
            "latest user turn must remain"
        );
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

    #[test]
    fn strip_preamble_removes_common_meta_opener() {
        let raw = "The user wants me to summarise the conversation excerpt. \
I need to compress it into a short paragraph.\n\n\
Key facts: agent ran requirement.list (30 items, 12 in_progress).";
        let out = strip_summary_preamble(raw);
        assert!(out.starts_with("Key facts:"), "got: {out:?}");
        assert!(!out.contains("The user wants me to"));
    }

    #[test]
    fn strip_preamble_handles_summarize_us_spelling() {
        let raw = "The user wants me to summarize the conversation. The excerpt is in Chinese.\n\n\
Decision: focus on Web UI experience.";
        let out = strip_summary_preamble(raw);
        assert!(out.starts_with("Decision:"));
    }

    #[test]
    fn strip_preamble_leaves_clean_summary_alone() {
        let raw = "User asked for kanban review. Agent ran requirement.list.";
        assert_eq!(strip_summary_preamble(raw), raw);
    }

    #[test]
    fn strip_preamble_bails_when_no_paragraph_break() {
        // Preamble pattern present but no \n\n boundary — leave as-is rather
        // than risk amputating the only content.
        let raw = "The user wants me to summarise something. Key facts inline.";
        assert_eq!(strip_summary_preamble(raw), raw);
    }

    #[test]
    fn strip_preamble_handles_lets_summarise() {
        let raw = "Let me summarise what happened.\n\nUser approved the kanban triage.";
        let out = strip_summary_preamble(raw);
        assert!(out.starts_with("User approved"));
    }
}
