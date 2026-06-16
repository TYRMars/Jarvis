// ChannelBindingStore backends — JsonFile + Memory.
//
// Ported from crates/harness-store/src/json_file.rs (JsonFileChannelBindingStore)
// + memory.rs (MemoryChannelBindingStore). Unlike the one-file-per-row project
// stores, the Rust channel stores use a SINGLE flat JSON array file
// (`channel_bindings.json`) under the base dir: bindings are tiny and total
// volume scales with chats × channels, not messages, so the whole file is
// rewritten atomically on every mutation. This port matches that layout.
//
// The unique key is the `(channel, channel_chat_id)` pair. `upsert` overwrites
// the row with the matching pair in place (else appends); `lookup` finds by the
// pair; `listForChannel` filters by `channel`, newest-first by `updated_at`;
// `delete` removes one pair; `deleteForConversation` removes every row pointing
// at a conversation id and returns the count.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDir } from "@jarvis/store";
import type { ChannelBinding } from "./binding.ts";
import type { ChannelBindingStore } from "./store.ts";

const FILE_NAME = "channel_bindings.json";

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** True when `a`/`b` are the same binding key. */
function sameKey(b: ChannelBinding, channel: string, channelChatId: string): boolean {
  return b.channel === channel && b.channel_chat_id === channelChatId;
}

/** Newest-first by `updated_at` (RFC-3339 strings sort lexicographically). */
function byUpdatedDesc(a: ChannelBinding, b: ChannelBinding): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

/**
 * On-disk {@link ChannelBindingStore}. Single flat-array JSON file at
 * `<baseDir>/channel_bindings.json`. The full array is held in memory and
 * rewritten atomically on every mutation (load-once on `open`); missing /
 * empty / corrupt files start as an empty registry — same degradation policy
 * as the Rust backend.
 */
export class JsonFileChannelBindingStore implements ChannelBindingStore {
  readonly #path: string;
  #state: ChannelBinding[];

  private constructor(filePath: string, initial: ChannelBinding[]) {
    this.#path = filePath;
    this.#state = initial;
  }

  /** Open or create the store under `baseDir` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileChannelBindingStore> {
    await ensureDir(baseDir);
    const filePath = path.join(baseDir, FILE_NAME);
    let initial: ChannelBinding[] = [];
    try {
      const bytes = await readFile(filePath, "utf8");
      if (bytes.length > 0) {
        try {
          const parsed = JSON.parse(bytes) as ChannelBinding[];
          if (Array.isArray(parsed)) initial = parsed;
        } catch {
          // Corrupt file → start empty (matches Rust's warn-and-continue).
        }
      }
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    return new JsonFileChannelBindingStore(filePath, initial);
  }

  async #flush(snapshot: ChannelBinding[]): Promise<void> {
    await atomicWrite(this.#path, JSON.stringify(snapshot, null, 2));
  }

  async upsert(binding: ChannelBinding): Promise<void> {
    // Build the next state, flush, and only commit the in-memory mutation once
    // the flush succeeds — a failed flush leaves memory and disk consistent.
    const next = this.#state.map((b) => ({ ...b }));
    const slot = next.findIndex((b) => sameKey(b, binding.channel, binding.channel_chat_id));
    if (slot !== -1) {
      next[slot] = { ...binding };
    } else {
      next.push({ ...binding });
    }
    await this.#flush(next);
    this.#state = next;
  }

  lookup(channel: string, channelChatId: string): Promise<ChannelBinding | undefined> {
    const row = this.#state.find((b) => sameKey(b, channel, channelChatId));
    return Promise.resolve(row ? { ...row } : undefined);
  }

  listForChannel(channel: string): Promise<ChannelBinding[]> {
    const rows = this.#state
      .filter((b) => b.channel === channel)
      .map((b) => ({ ...b }))
      .sort(byUpdatedDesc);
    return Promise.resolve(rows);
  }

  async delete(channel: string, channelChatId: string): Promise<boolean> {
    const next = this.#state.filter((b) => !sameKey(b, channel, channelChatId));
    if (next.length === this.#state.length) return false;
    await this.#flush(next);
    this.#state = next;
    return true;
  }

  async deleteForConversation(conversationId: string): Promise<number> {
    const next = this.#state.filter((b) => b.conversation_id !== conversationId);
    const removed = this.#state.length - next.length;
    if (removed === 0) return 0;
    await this.#flush(next);
    this.#state = next;
    return removed;
  }
}

/**
 * In-memory {@link ChannelBindingStore}. Backs tests + the server's no-DB
 * fallback. Same `(channel, channel_chat_id)` key + newest-first ordering as
 * the JSON-file backend.
 */
export class MemoryChannelBindingStore implements ChannelBindingStore {
  #rows: ChannelBinding[] = [];

  upsert(binding: ChannelBinding): Promise<void> {
    const slot = this.#rows.findIndex((b) => sameKey(b, binding.channel, binding.channel_chat_id));
    if (slot !== -1) {
      this.#rows[slot] = { ...binding };
    } else {
      this.#rows.push({ ...binding });
    }
    return Promise.resolve();
  }

  lookup(channel: string, channelChatId: string): Promise<ChannelBinding | undefined> {
    const row = this.#rows.find((b) => sameKey(b, channel, channelChatId));
    return Promise.resolve(row ? { ...row } : undefined);
  }

  listForChannel(channel: string): Promise<ChannelBinding[]> {
    const rows = this.#rows
      .filter((b) => b.channel === channel)
      .map((b) => ({ ...b }))
      .sort(byUpdatedDesc);
    return Promise.resolve(rows);
  }

  delete(channel: string, channelChatId: string): Promise<boolean> {
    const next = this.#rows.filter((b) => !sameKey(b, channel, channelChatId));
    if (next.length === this.#rows.length) return Promise.resolve(false);
    this.#rows = next;
    return Promise.resolve(true);
  }

  deleteForConversation(conversationId: string): Promise<number> {
    const next = this.#rows.filter((b) => b.conversation_id !== conversationId);
    const removed = this.#rows.length - next.length;
    if (removed === 0) return Promise.resolve(0);
    this.#rows = next;
    return Promise.resolve(removed);
  }
}
