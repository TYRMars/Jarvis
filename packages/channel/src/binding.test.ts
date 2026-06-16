import { test } from "node:test";
import assert from "node:assert/strict";

import { newChannelBinding, touchChannelBinding } from "./binding.ts";

test("newChannelBinding sets equal timestamps and omits absent optionals", () => {
  const b = newChannelBinding("wecom", "g1", "conv-1");
  assert.equal(b.channel, "wecom");
  assert.equal(b.channel_chat_id, "g1");
  assert.equal(b.conversation_id, "conv-1");
  assert.equal(b.created_at, b.updated_at);
  // Optional fields absent (skip_serializing_if = Option::is_none parity).
  const obj = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
  assert.equal("channel_user_id" in obj, false);
  assert.equal("display_name" in obj, false);
});

test("newChannelBinding carries the optional user id + display name when given", () => {
  const b = newChannelBinding("feishu", "f1", "conv-2", "u1", "Alice");
  assert.equal(b.channel_user_id, "u1");
  assert.equal(b.display_name, "Alice");
});

test("touchChannelBinding bumps updated_at, leaves created_at", () => {
  const b = newChannelBinding("wecom", "g1", "conv-1");
  b.created_at = "2020-01-01T00:00:00.000Z";
  b.updated_at = "2020-01-01T00:00:00.000Z";
  touchChannelBinding(b);
  assert.equal(b.created_at, "2020-01-01T00:00:00.000Z");
  assert.notEqual(b.updated_at, "2020-01-01T00:00:00.000Z");
});
