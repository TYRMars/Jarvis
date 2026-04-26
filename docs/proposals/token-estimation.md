# Token estimation

**Status:** Adopted. `TokenEstimator` trait + `CharRatioEstimator`
fallback + `LlmProvider::estimator()` default, BPE-backed
`TiktokenEstimator` (cl100k / o200k), and per-provider overrides
(OpenAI / Responses pick by model; Anthropic = cl100k +20 % margin;
Google = cl100k +10 %) all landed. Memory backends accept
`with_estimator(...)`; `apps/jarvis` wires the provider's estimator
into both windowing and summarising modes. The Anthropic-tokeniser
JSON vendoring (option (a) under "Risks") and the
`AgentEvent::Usage` self-calibration loop remain follow-ups.
**Touches:** `harness-core` (refactor `estimate_tokens`),
`harness-llm::*` (each provider exposes its estimator),
`harness-memory` (consume per-provider estimator).

## Motivation

Today `harness_core::estimate_tokens` is a flat heuristic: `chars/4 +
4`. Cheap and provider-agnostic, but:

- Empirical drift on real prompts: 25-40% under-count for English,
  worse for code (which has more whitespace and short identifiers),
  *over*-count for CJK (each char often maps to multiple BPE tokens).
- `SlidingWindowMemory` and `SummarizingMemory` set their budgets in
  "tokens" using this estimator. A 30% under-count means a budget of
  8000 actually ships ~10000 tokens to the model — which silently
  blows past the model's window, gets truncated server-side, or
  costs more than expected.
- Anthropic and Google use BPE variants similar to but not the same
  as OpenAI's; one shared estimator is wrong for everyone.

The fix is straightforward: per-provider estimators behind a trait,
with the heuristic as the default fallback.

## Design

### Trait

```rust
// crates/harness-core/src/memory.rs (or new module `tokens.rs`)
pub trait TokenEstimator: Send + Sync {
    /// Tokens for a single message, including any role/separator
    /// overhead the model counts internally.
    fn estimate_message(&self, message: &Message) -> usize;

    /// Tokens for a slice. Default sums per-message; providers can
    /// override if they need to amortise overhead.
    fn estimate_messages(&self, messages: &[Message]) -> usize {
        messages.iter().map(|m| self.estimate_message(m)).sum()
    }

    /// Tokens for raw text (used by summarisers when crafting the
    /// summary prompt itself).
    fn estimate_text(&self, text: &str) -> usize;
}

/// Heuristic fallback. Today's `estimate_tokens` becomes this.
pub struct CharRatioEstimator;

impl TokenEstimator for CharRatioEstimator {
    // chars/4 + 4 per message, as today
}
```

The free functions `estimate_tokens` / `estimate_total_tokens` keep
working as thin wrappers around `CharRatioEstimator` so we don't break
existing callers in one shot.

### Provider-supplied estimators

Each `LlmProvider` impl exposes one:

```rust
// crates/harness-core/src/llm.rs
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(...) -> ...;
    async fn complete_stream(...) -> ...;

    /// Token estimator for this provider's models. Default: the
    /// char-ratio heuristic. Real providers override.
    fn estimator(&self) -> Arc<dyn TokenEstimator> {
        Arc::new(CharRatioEstimator)
    }
}
```

Each crate ships a real implementation:

- `harness-llm::openai::TiktokenEstimator` — wraps `tiktoken-rs`'s
  `cl100k_base` (good enough for `gpt-4o-mini`, `gpt-4o`, `o1`
  family). Per-model overhead constants from the OpenAI cookbook
  (`tokens_per_message`, `tokens_per_name`).
- `harness-llm::anthropic::AnthropicEstimator` — the official
  `tokenizers` JSON for `claude-3-5-sonnet` (vendored or fetched).
  No public crate as of writing; fall back to `tiktoken_rs::p50k_base`
  with a +20% safety margin if vendoring isn't acceptable.
- `harness-llm::google::GeminiEstimator` — Gemini exposes
  `countTokens` REST endpoint for exact counts but it costs a round
  trip. For local estimation, use `tiktoken_rs::cl100k_base` + 10%
  margin (Gemini's BPE is fairly close in this register). A real
  fix is to ship an offline tokeniser; flag as TODO.

### Memory wiring

`SummarizingMemory` and `SlidingWindowMemory` take an optional
estimator on construction; default to `CharRatioEstimator` if none.
`apps/jarvis` wires the agent's provider-supplied estimator in:

```rust
// apps/jarvis/src/main.rs
let estimator = llm.estimator();
let memory: Arc<dyn Memory> = match mode {
    "window" => Arc::new(SlidingWindowMemory::new(budget).with_estimator(estimator)),
    "summary" => Arc::new(SummarizingMemory::new(...).with_estimator(estimator)),
    ...
};
```

The estimator threads naturally through the existing builder pattern;
no new public surface beyond one method each.

## Performance

`tiktoken-rs` benchmarks at ~2-3 μs per kilobyte of text on a
modern laptop, well below network or LLM costs. Construct the encoder
once per provider instance (it's not cheap to create — internal
HashMaps for the BPE merges) and share it via `Arc`.

`estimate_messages` for a 30-message conversation is sub-millisecond
even with real BPE. No optimisation needed beyond the construction
caching above.

## Implementation cuts

1. **Trait + heuristic impl.** Add `TokenEstimator` to harness-core,
   re-implement existing `estimate_tokens` as
   `CharRatioEstimator::estimate_message`. Free functions stay as
   thin wrappers. ~80 LOC + tests.
2. **`LlmProvider::estimator()` default.** One default-method
   addition. No provider changes yet — they all inherit the
   heuristic. ~5 LOC.
3. **`SlidingWindowMemory.with_estimator`.** Accept the trait;
   use in `select_recent_turns`. ~30 LOC. Tests: pass a fake
   estimator that double-counts, verify the budget halves
   accordingly.
4. **`SummarizingMemory.with_estimator`.** Same. ~20 LOC.
5. **OpenAI estimator.** Add `tiktoken-rs` dep, implement, override
   `estimator()`. ~120 LOC + accuracy tests against known prompts.
6. **Anthropic estimator.** Pick approach (vendor JSON vs +safety
   margin). Implement. ~100 LOC.
7. **Google estimator.** Either offline approximation (`tiktoken_rs`
   + margin) or async `countTokens` round-trip. Async makes the
   estimator trait async, which is invasive — recommend the offline
   approximation for v0.
8. **`apps/jarvis` wiring.** Two-line patch.

## Risks / open questions

- **`tiktoken-rs` dep weight.** ~3 MB of BPE merges shipped with the
  binary. Acceptable. Use it gated under a `tiktoken` cargo feature
  if anyone screams.
- **Anthropic tokeniser availability.** No first-party Rust crate.
  Options: (a) ship the JSON file from
  `Xenova/claude-tokenizer` on Hugging Face (1.5 MB, stable enough);
  (b) call `countTokens` async (Anthropic doesn't have one — only
  Google does); (c) use `tiktoken-rs::cl100k_base` + 20% margin.
  Recommendation: (a) initially with `tokenizers` crate, fall back to
  (c) if (a) becomes a license / packaging headache.
- **Async estimator?** Google's `countTokens` is async but rarely
  worth the round trip for memory budgeting. Keeping the trait sync
  is the right call; if a user *really* wants exact Google counts
  they can build their own async wrapper.
- **Cache invalidation when model changes.** The estimator is a
  property of the provider, not the model. For OpenAI specifically,
  `gpt-4o` and `gpt-3.5-turbo` use different overhead constants. The
  `OpenAiProvider::estimator` should look at `JARVIS_MODEL` to pick
  the right constants. Document this carefully.

## Out of scope

- Tracking actual usage from provider responses
  (`response.usage.prompt_tokens`) for self-calibrating estimators.
  Worth doing eventually — the agent has the ground-truth right
  there — but a separate proposal.
- Token counts in event streams (`AgentEvent::Usage { prompt, completion }`)
  for the UI to display. Touches every transport; separate proposal.
