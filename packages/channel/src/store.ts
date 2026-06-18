// Persistence traits for channel rows.
//
// Ported from crates/harness-channel/src/store.rs. Two distinct lifecycles,
// two distinct stores:
// - {@link ChannelInstanceStore} — operator-configured rows ("I set up a WeCom
//   group robot in Settings").
// - {@link ChannelBindingStore} — runtime per-chat mapping rows ("this WeCom
//   group maps to conversation X"), written at message-arrival time.
//
// Neither Rust trait carries a broadcast channel, so — unlike the
// @jarvis/project stores — there are no events / EventSource here. Async
// `Result<T, BoxError>` methods map to `Promise<T>` that reject on IO error.
// Backends (JsonFile + Memory) live in the sibling backend modules of this
// package.
import type { ChannelBinding } from "./binding.ts";
import type { ChannelInstance } from "./instance.ts";

/**
 * Persistence operations on {@link ChannelBinding} rows. The
 * `(channel, channel_chat_id)` pair is the unique key.
 *
 * Channel adapter plugins call this on every inbound message to answer "is
 * there already a Jarvis conversation for this chat?". Stores don't touch
 * `updated_at` — callers use {@link touchChannelBinding} to bump it before
 * `upsert`.
 */
export interface ChannelBindingStore {
  /** Insert or overwrite a binding. Idempotent on the `(channel, channel_chat_id)` key. */
  upsert(binding: ChannelBinding): Promise<void>;
  /**
   * Look up by `(channel, channel_chat_id)`. Resolves `undefined` when no
   * binding exists — adapters use this to decide "create a new conversation"
   * vs "resume an existing one".
   */
  lookup(channel: string, channelChatId: string): Promise<ChannelBinding | undefined>;
  /** All bindings owned by `channel`, newest-first by `updated_at`. */
  listForChannel(channel: string): Promise<ChannelBinding[]>;
  /** Hard-delete a single binding. Resolves `true` if a row was removed. */
  delete(channel: string, channelChatId: string): Promise<boolean>;
  /**
   * Hard-delete every binding pointing at `conversationId` (called when the
   * underlying conversation is deleted). Resolves the number of rows removed.
   */
  deleteForConversation(conversationId: string): Promise<number>;
}

/**
 * Persistence operations on user-configured {@link ChannelInstance} rows.
 * Sibling to {@link ChannelBindingStore}. `id` is a server-minted UUID (set by
 * {@link newChannelInstance}); the store does not enforce uniqueness on
 * `display_name`. Stores don't touch `updated_at` — callers use
 * {@link touchChannelInstance} before `upsert`.
 */
export interface ChannelInstanceStore {
  /** Insert or overwrite a row keyed by `id`. */
  upsert(instance: ChannelInstance): Promise<void>;
  /** Look up by stable id. Resolves `undefined` when absent. */
  get(id: string): Promise<ChannelInstance | undefined>;
  /** All rows ordered newest-first by `updated_at`. */
  list(): Promise<ChannelInstance[]>;
  /** Hard-delete by id. Resolves `true` if a row was removed. */
  delete(id: string): Promise<boolean>;
}
