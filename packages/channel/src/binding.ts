// `ChannelBinding` value type.
//
// Ported from crates/harness-channel/src/binding.rs. Records the persistent
// mapping between a chat on an external messaging platform (Feishu / Lark,
// DingTalk, WeCom, Telegram, …) and a Jarvis `Conversation`. Lets a channel
// adapter answer "this user just spoke in WeCom group `wm…ABCD` — which Jarvis
// conversation should I drop their message into?" across adapter reconnects.

/**
 * Persistent binding from an external chat to a Jarvis conversation. Keyed by
 * `(channel, channel_chat_id)` — the unique pair every adapter needs to answer
 * "do I already have a conversation for this chat?".
 *
 * `channel_user_id` is informational — the platform-side sender id at
 * binding-creation time. `display_name` is best-effort and may be stale. Both
 * are `#[serde(default, skip_serializing_if = "Option::is_none")]` in Rust →
 * optional + absent from the wire when unset.
 */
export interface ChannelBinding {
  /** Adapter handle, e.g. `"wecom"` / `"feishu"` / `"dingtalk"`. */
  channel: string;
  /** Platform-side identifier for the chat (group id, DM userid, …). Adapter-defined. */
  channel_chat_id: string;
  /** Jarvis-internal conversation id. Same shape as everywhere else in the store layer. */
  conversation_id: string;
  /** RFC-3339 string. Set on insert, never touched on update. */
  created_at: string;
  /** RFC-3339 string. Bumped by {@link touchChannelBinding} on every inbound. */
  updated_at: string;
  /** Platform-side user id of the binding's "owner". Informational. Absent on the wire when unset. */
  channel_user_id?: string;
  /** Best-effort display name captured at binding creation. May drift. Absent on the wire when unset. */
  display_name?: string;
}

/**
 * Build a fresh binding with `created_at` === `updated_at` === now. Adapters
 * that don't carry a user id / display name pass `undefined`. Mirrors
 * `ChannelBinding::new`; matching the `skip_serializing_if` wire form, the
 * optional fields are only set on the row when provided.
 */
export function newChannelBinding(
  channel: string,
  channelChatId: string,
  conversationId: string,
  channelUserId?: string,
  displayName?: string,
): ChannelBinding {
  const now = new Date().toISOString();
  const binding: ChannelBinding = {
    channel,
    channel_chat_id: channelChatId,
    conversation_id: conversationId,
    created_at: now,
    updated_at: now,
  };
  if (channelUserId !== undefined) binding.channel_user_id = channelUserId;
  if (displayName !== undefined) binding.display_name = displayName;
  return binding;
}

/**
 * Bump `updated_at` to "now". Stores never mutate timestamps on the caller's
 * behalf. Mirrors `ChannelBinding::touch`.
 */
export function touchChannelBinding(binding: ChannelBinding): void {
  binding.updated_at = new Date().toISOString();
}
