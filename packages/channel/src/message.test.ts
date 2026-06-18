import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type SendOutcome,
  channelMessageFormatFromWire,
  isSent,
  outboundText,
  sendOutcomeFail,
  sendOutcomeFailRetryable,
  sendOutcomeSent,
} from "./message.ts";

test("channelMessageFormatFromWire round-trips known values, rejects unknown", () => {
  assert.equal(channelMessageFormatFromWire("text"), "text");
  assert.equal(channelMessageFormatFromWire("markdown"), "markdown");
  assert.equal(channelMessageFormatFromWire("nope"), undefined);
});

test("outboundText builds a plain text message with no mentions", () => {
  const m = outboundText("hi");
  assert.equal(m.text, "hi");
  assert.equal(m.format, "text");
  assert.deepEqual(m.mentions, []);
});

test("sendOutcome constructors set the discriminator + retryable correctly", () => {
  assert.ok(isSent(sendOutcomeSent()));

  const f = sendOutcomeFail("boom");
  assert.equal(f.outcome, "failed");
  assert.equal(f.outcome === "failed" && f.retryable, false);
  assert.ok(!isSent(f));

  const r = sendOutcomeFailRetryable("transient");
  assert.equal(r.outcome === "failed" && r.retryable, true);
});

test("sent outcome omits default booleans on the wire (skip_serializing_if parity)", () => {
  const s = sendOutcomeSent();
  const obj = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  assert.equal(obj["outcome"], "sent");
  // Default-valued + optional fields are absent, matching the Rust wire form.
  assert.equal("truncated" in obj, false);
  assert.equal("downgraded_format" in obj, false);
  assert.equal("message_id" in obj, false);
});

test("failed outcome serialises message + retryable, omits absent code", () => {
  const f: SendOutcome = sendOutcomeFail("config broken");
  const obj = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
  assert.deepEqual(obj, { outcome: "failed", message: "config broken", retryable: false });
  assert.equal("code" in obj, false);
});
