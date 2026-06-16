// summary-store.ts — the composition root's `SummaryStore` adapter over a
// `ConversationStore`, the cross-process tier of `SummarizingMemory`.
//
// `@jarvis/memory` deliberately depends on `@jarvis/core` ONLY and pushes the
// key-namespacing + Conversation-row shaping to the composition root (see the
// doc comment on `@jarvis/memory`'s `SummaryStore`). This module is that root:
// it implements `SummaryStore.get/put` over the persistent `ConversationStore`,
// storing each summary as a synthetic single-`System`-message `Conversation`
// under the reserved `__memory__.summary:<hash>` key — byte-for-byte the same
// shape the Rust `SummarizingMemory::with_persistence` writes (one `System`
// message whose `content` is the summary text). The `__memory__.` prefix is the
// reserved internal namespace the HTTP server filters out of public lists.
import { conversationWithSystem } from "@jarvis/core";
import type { ConversationStore } from "@jarvis/store";
import type { SummaryStore } from "@jarvis/memory";

/** The reserved key namespace (mirrors the Rust `PERSIST_KEY_PREFIX`). */
const PERSIST_KEY_PREFIX = "__memory__.summary:";

/** `__memory__.summary:<hash>` — the row key for a content-addressed summary. */
export function persistKey(hash: string): string {
  return `${PERSIST_KEY_PREFIX}${hash}`;
}

/**
 * A {@link SummaryStore} backed by a {@link ConversationStore}. The summary
 * text is stored as the single `System` message of a synthetic conversation,
 * content-addressed by the fingerprint `hash` the memory backend supplies. Both
 * operations are defensive — a malformed/missing row is a soft miss, never a
 * throw on the read path — but `put` lets the underlying store reject propagate
 * (SummarizingMemory wraps the `put` call site in its own warn-and-continue).
 */
export class ConversationSummaryStore implements SummaryStore {
  readonly #store: ConversationStore;

  constructor(store: ConversationStore) {
    this.#store = store;
  }

  async get(hash: string): Promise<string | undefined> {
    const conv = await this.#store.load(persistKey(hash));
    if (conv === undefined) return undefined;
    // The summary lives in the first `System` message's content. A row that
    // lost its system message (corruption / older shape) is treated as a miss.
    for (const m of conv.messages) {
      if (m.role === "system" && typeof m.content === "string" && m.content.trim() !== "") {
        return m.content;
      }
    }
    return undefined;
  }

  async put(hash: string, summary: string): Promise<void> {
    await this.#store.save(persistKey(hash), conversationWithSystem(summary));
  }
}
