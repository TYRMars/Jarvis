// Persistence surface for SummarizingMemory's cross-process cache tier.
//
// Kept as a tiny standalone interface so @jarvis/memory depends on
// @jarvis/core ONLY — the composition root implements this over a
// ConversationStore (writing a synthetic single-System-message
// Conversation under the reserved `__memory__.summary:<hash>` key) without
// @jarvis/memory ever naming @jarvis/store.
//
// Ported from the persistence tier of harness-memory/src/summarizing.rs,
// where the same role is played by an `Arc<dyn ConversationStore>` keyed by
// a BLAKE3 fingerprint. Here the key-namespacing + Conversation-row shaping
// is the composition root's job; this interface only exposes the
// content-addressed get/put the cache needs.

/**
 * Content-addressed summary cache. `hash` is the stable fingerprint of the
 * dropped slice (see {@link fingerprint}). Implementations decide how to key
 * and shape storage; the contract is only:
 *
 *  - `get` returns the previously-stored summary text for `hash`, or
 *    `undefined` on a miss.
 *  - `put` writes `summary` back for `hash`.
 *
 * Both may reject; {@link SummarizingMemory} treats rejection as a soft miss
 * (warn-and-continue), never failing compaction on a flaky backend.
 */
export interface SummaryStore {
  get(hash: string): Promise<string | undefined>;
  put(hash: string, summary: string): Promise<void>;
}
