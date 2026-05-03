# Prompt caching

**Status:** Adopted. Beyond the original Anthropic-focused scope,
the OpenAI / Codex follow-up has also landed:

- Hygiene subset (sorted `ToolRegistry::specs()`, byte-stable
  `SlidingWindowMemory` marker).
- `CacheHint` field on **every `Message` variant** (`System` /
  `User` / `Assistant` / `Tool`); `Tool::cacheable()` flag.
- Anthropic `cache_control` emission for `system`, the tools list,
  and **mid-conversation breakpoints** on `User` / `Assistant` /
  `Tool` (the converter promotes user `content` to a block array,
  attaches `cache_control` to the last block of an assistant
  message, and to the targeted `tool_result` block).
- `LlmChunk::Usage` / `AgentEvent::Usage` event live; OpenAI Chat
  Completions and Responses extract `cached_tokens` into
  `Usage::cached_prompt_tokens`. `UsageBadge` renders cached count +
  hit-rate %.
- **`prompt_cache_key`** auto-derived from `(model, system, tools)`
  on every OpenAI / Responses / Codex request (override via
  `OpenAiConfig::with_prompt_cache_key` /
  `ResponsesConfig::with_prompt_cache_key` /
  `OPENAI_PROMPT_CACHE_KEY` env). Stable across processes by
  hashing the post-sort, post-sanitise wire shape.
- **Cache-aware compaction**: `SlidingWindowMemory` and
  `SummarizingMemory` consult `cache_breakpoint_indices()` when any
  message carries an explicit `CacheHint`; turns at-or-before the
  highest breakpoint are kept unconditionally so cache anchors
  survive eviction.
- **`response_id` / `previous_response_id` chaining** for the
  Responses API: `LlmChunk::Finish` and `ChatResponse` carry
  `response_id`; the agent loop captures it onto
  `Conversation::last_response_id` + `last_response_chain_origin`.
  When `ResponsesConfig::chain_responses` is on (default for `codex`,
  off for `openai_responses`), the next request sends only the
  post-anchor delta + `previous_response_id` and forces `store=true`.
  Chain breakers handled: WS Reset (via `Conversation::default()`),
  resume from store (id explicitly cleared), out-of-bounds
  `chain_origin` (provider falls back to full history). Compaction
  is skipped when chaining is active so the chain stays aligned.

**Touches:** `harness-core` (new fields on `ChatRequest`,
`ChatResponse`, `LlmChunk::Finish`, `Conversation`;
`cache_breakpoint_indices` helper), `harness-llm::anthropic`
(consume the cache field), `harness-llm::openai` (prefix discipline +
`prompt_cache_key`), `harness-llm::responses` (`prompt_cache_key`,
`response_id` capture, chaining + delta-mode),
`harness-llm::cache_key` (new), `harness-memory` (cache-aware
compaction in `sliding` / `summarizing`), `harness-server::routes`
(resume chain breaker), `apps/jarvis::serve` (env override).

## Motivation

For capability-heavy agent turns that send a 5-15 KB system prompt +
a long tool catalogue, prompt caching cuts both latency and cost
**dramatically**. Coding is the most obvious case today, but the same
pressure will show up in Work runs, Doc research/drafting, and any
Chat session with many enabled capability packs:

- **Anthropic:** ~90% off cached input tokens, ~80%+ latency
  reduction on long prompts. Up to 4 cache breakpoints per request,
  5 min TTL on `ephemeral` cache, 1 hour on the new `persistent`
  setting (when GA in your account).
- **OpenAI:** prefix-prefix automatic cache, no API surface needed.
  Triggers when the same prefix recurs ≥1024 tokens. Cost is roughly
  half the uncached price after the first hit. No client work needed
  *except* keeping the prefix byte-stable.
- **Google Gemini:** has explicit context caching (`cachedContents`
  resource) but the API is a separate plane; treat as future work.

Cache hits happen automatically when the **prefix bytes are
identical**. The harness already keeps the system prompt + tool list
stable across iterations within a turn, but two practices break
caching that we could avoid:

1. Reordering tools in the registry (HashMap iteration order
   non-deterministic). Today `ToolRegistry::specs` returns whatever
   `HashMap::values` yields → output order varies between processes.
2. The summarising-memory turn marker (`[N earlier turn(s) omitted
   ...]`) changes its `N` constantly, busting the cache for everything
   after it.

So this proposal has two halves: **a hint API for explicit cache
breakpoints (Anthropic)** and **stability hygiene for prefix caching
(OpenAI / generally)**.

## Product alignment

Prompt caching is cross-product infrastructure:

- **Chat:** keeps provider/model/tool prefixes stable across normal
  conversations.
- **Work:** makes fresh sessions per Work unit cheaper when they share
  the same capability pack and tool catalogue.
- **Doc:** benefits research and drafting flows that repeatedly use
  source, citation, and export tools.

Capability packs should avoid per-turn mutation of system prompts.
Dynamic product context should be injected after the stable cached
prefix, usually as a user/context message or manifest payload.

## Anthropic: explicit cache breakpoints

API surface (in `harness-core`):

```rust
// crates/harness-core/src/message.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Message {
    System {
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache: Option<CacheHint>,
    },
    // ... other variants similarly extended
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheHint {
    /// 5-minute ephemeral cache breakpoint.
    Ephemeral,
    /// 1-hour persistent cache breakpoint (Anthropic only, where GA).
    Persistent,
}
```

Conversion in `harness-llm/src/anthropic.rs`:

- `Message::System { cache: Some(_), ... }` → emit content as a block
  array `[{type:text, text:"...", cache_control:{type:"ephemeral"}}]`
  rather than a plain string. Anthropic accepts this only when the
  block is the last in its semantic group (system / tools / specific
  user blocks), so the converter has to be careful where it places
  the marker.
- Tool definitions: a top-level `tools: [...]` array can have
  `cache_control` on its **last** element to cache the whole tools
  list. Add `Tool::cacheable(&self) -> bool` (default `false`); when
  any tool sets it true and the tool is last in spec order, mark the
  list cacheable.

OpenAI ignores `CacheHint` (it's automatic on prefix), so the field
is no-op for that provider.

## Stability hygiene

These are independently valuable even before adding the hint field:

### Tool order

`ToolRegistry::specs` should return tools in a **deterministic order**
— alphabetical by name is fine. One-line fix:

```rust
pub fn specs(&self) -> Vec<ToolSpec> {
    let mut specs: Vec<_> = self.tools.values().map(|t| ToolSpec {
        name: t.name().to_string(),
        description: t.description().to_string(),
        parameters: t.parameters(),
    }).collect();
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}
```

Without this, two processes ship different cache keys for identical
tool sets. Free win.

### Summary marker

`SlidingWindowMemory` inserts `[N earlier turn(s) omitted to fit
context]`; the value of `N` changes turn-to-turn, busting the cache.
Mitigation:

- Drop the marker entirely (simplest), **or**
- Move it after the leading systems (it already is) and accept the
  cache miss only on the first message past the marker — Anthropic's
  4-breakpoint allowance covers this if the marker is between two
  cache_control breakpoints, but it's still a moving target.

Recommended: change the marker to a constant string ("[earlier turns
omitted]") without the count. Information loss is small; cache
preservation is large.

`SummarizingMemory` is fine — its summary is content-addressed by
fingerprint, so the *same* prior conversation produces the *same*
summary text.

### System prompt

If the binary builds a system prompt at startup and never changes it,
the bytes are already stable. Document this expectation in the
`AgentConfig::with_system_prompt` doc. If a future feature needs
per-turn system tweaks, surface them as a *separate* user message so
the cached system prefix survives.

## Cache-aware compaction

`SummarizingMemory` and `SlidingWindowMemory` already preserve leading
system messages — that's the cache-friendly side. But they currently
have no way to **prefer** dropping turns that come after a cache
breakpoint vs. before. Future enhancement (gated on real Anthropic
usage data):

- `Memory::compact` could accept a `cache_breakpoints: &[usize]`
  hint listing message indices marked cacheable. The compactor
  prefers to drop only between breakpoints.
- For v0 of this proposal: skip. The default windowing already keeps
  systems and rolls turns from the tail, which fits the common case.

## Implementation cuts

1. **Stability hygiene.** Sorted `ToolRegistry::specs`, constant
   marker text in `SlidingWindowMemory`. ~30 LOC + tests for sort.
2. **CacheHint type.** Add to `harness-core`; default-skip serialise
   so the wire shape doesn't change unless used. ~50 LOC.
3. **Anthropic conversion.** `convert_messages` recognises
   `cache: Some(_)` and emits the appropriate block-array shape.
   Tool list trailing `cache_control` when any registered tool opts
   in. Tests: round-trip JSON, verify block shape, verify the
   non-hint case still serialises as plain text. ~120 LOC.
4. **`Tool::cacheable` flag.** Default `false`; built-in tools opt in
   selectively (probably yes for `code.grep`, `time.now`, `echo`,
   `http.fetch` — small, stable schemas; consider for `fs.*`).
   ~20 LOC.
5. *(Future)* **Cache-aware compaction.** When real usage shows it
   matters.

## Risks / open questions

- **Anthropic-only field on a shared type.** `CacheHint` lives on
  `Message`, ignored by OpenAI / Google. Could be argued for a
  separate request-level `cache_breakpoints: Vec<MessageIndex>` field
  instead, keeping `Message` provider-agnostic. Trade-off: harder for
  callers to keep the marker attached when reordering messages.
  **Decision:** keep on `Message`, document that non-Anthropic
  providers ignore it.
- **TTL drift.** Ephemeral cache expires in 5 min. A user who pauses
  for 10 minutes between turns pays full price on the next turn. Not
  much we can do — this is just billing reality.
- **Block-array vs string.** Anthropic accepts both, but
  `cache_control` only attaches to blocks. The converter has to flip
  to the array form whenever any block in the group needs caching,
  which means the wire shape diverges. Test coverage needs to span
  both.
- **Cost reporting.** We don't surface usage stats today
  (`{cached_input_tokens, ...}`). A follow-up could add a
  `LlmChunk::Usage` event so the UI / CLI can show savings.

## Out of scope

- Google Gemini context caching (`cachedContents` resource — separate
  API plane; design later when usage warrants).
- Automatic detection of "this prompt is worth caching" via heuristics.
  Caller decides.
- Cache-warming / preloading.
