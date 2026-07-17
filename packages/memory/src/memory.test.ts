import { test } from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@jarvis/core";
import { systemMessage, userMessage, assistantText, toolResult, withCache } from "@jarvis/core";
import {
  charRatioEstimator,
  jsonAwareEstimator,
  estimateTokens,
  estimateText,
  cacheBreakpointIndices,
} from "./tokens.ts";
import { compact, SlidingWindowMemory } from "./sliding.ts";

const est = charRatioEstimator;
const tokens = (msgs: Message[]): number => msgs.reduce((a, m) => a + estimateTokens(m), 0);

function assistantCall(id: string, name: string): Message {
  return { role: "assistant", tool_calls: [{ id, name, arguments: {} }] };
}
const userTexts = (out: Message[]): string[] =>
  out.filter((m): m is Extract<Message, { role: "user" }> => m.role === "user").map((m) => m.content);
const hasOmittedMarker = (out: Message[]): boolean =>
  out.some((m) => m.role === "system" && m.content.includes("omitted"));

// ---------- estimator ----------

test("estimator: char-ratio is chars/4 + 4 overhead", () => {
  assert.equal(estimateText("0123456789abcdef"), 4); // 16/4
  assert.equal(estimateText(""), 0);
  assert.equal(estimateTokens(userMessage("0123456789abcdef")), 4 + 4); // chars/4 + overhead
});

test("estimator: json-aware exceeds char-ratio for dense tool payloads", () => {
  const payload = '{"branch":"main","head":"abc1234","dirty":false,"manifests":[{"path":"Cargo.toml"}]}';
  const tool = toolResult("call_ctx", payload);
  const cr = charRatioEstimator.estimateMessage(tool);
  const ja = jsonAwareEstimator.estimateMessage(tool);
  assert.ok(ja > cr, `json-aware ${ja} should exceed char-ratio ${cr}`);
  assert.ok(ja < cr * 2);
});

test("estimator: json-aware matches char-ratio for non-tool messages", () => {
  for (const m of [systemMessage("you are jarvis"), userMessage("hello"), assistantText("hi there")]) {
    assert.equal(jsonAwareEstimator.estimateMessage(m), charRatioEstimator.estimateMessage(m));
  }
});

test("cacheBreakpointIndices: finds hinted messages", () => {
  const msgs: Message[] = [
    systemMessage("sys"),
    userMessage("a"),
    withCache(userMessage("b"), "ephemeral"),
    userMessage("c"),
    withCache(userMessage("d"), "persistent"),
  ];
  assert.deepEqual(cacheBreakpointIndices(msgs), [2, 4]);
  assert.deepEqual(cacheBreakpointIndices([systemMessage("s"), userMessage("hi")]), []);
});

// ---------- sliding window ----------

test("under budget returns everything", () => {
  const msgs = [systemMessage("you are jarvis"), userMessage("hi"), assistantText("hello")];
  const { out } = compact(msgs, 10_000, true, est);
  assert.equal(out.length, msgs.length);
});

test("drops oldest turns over budget, keeps system + marker + recent two", () => {
  const msgs = [
    systemMessage("sys"),
    userMessage("turn 1 user"),
    assistantText("turn 1 reply"),
    userMessage("turn 2 user"),
    assistantText("turn 2 reply"),
    userMessage("turn 3 user"),
    assistantText("turn 3 reply"),
  ];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(3, 5)) + tokens(msgs.slice(5, 7));
  const { out } = compact(msgs, budget, true, est);

  assert.ok(out.some((m) => m.role === "system" && m.content === "sys"));
  assert.deepEqual(userTexts(out), ["turn 2 user", "turn 3 user"]);
  assert.ok(hasOmittedMarker(out));
});

test("always keeps latest turn even if oversized", () => {
  const big = "x".repeat(10_000);
  const msgs = [systemMessage("sys"), userMessage(big), assistantText(big)];
  const { out } = compact(msgs, 10, true, est);
  assert.ok(out.some((m) => m.role === "user" && m.content.startsWith("xxxx")));
});

test("keeps tool call with replies atomic", () => {
  const msgs = [
    systemMessage("sys"),
    userMessage("old"),
    assistantText("old reply"),
    userMessage("recent"),
    assistantCall("call_1", "fs.read"),
    toolResult("call_1", "file contents"),
    assistantText("done"),
  ];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(3, 7));
  const { out } = compact(msgs, budget, false, est);

  const hasCall = out.some((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
  const hasReply = out.some((m) => m.role === "tool" && m.tool_call_id === "call_1");
  assert.equal(hasCall, hasReply);
  assert.ok(hasCall, "expected the recent tool exchange to survive");
  assert.ok(!out.some((m) => m.role === "user" && m.content === "old"));
});

test("marker inserted only when dropping; disabled via flag", () => {
  const fits = [systemMessage("sys"), userMessage("a"), assistantText("b"), userMessage("c"), assistantText("d")];
  assert.ok(!hasOmittedMarker(compact(fits, 10_000, true, est).out));

  const msgs = [systemMessage("sys"), userMessage("turn 1"), assistantText("reply 1"), userMessage("turn 2"), assistantText("reply 2")];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(3, 5));
  assert.ok(!hasOmittedMarker(compact(msgs, budget, false, est).out)); // marker disabled
});

test("marker is byte-stable across drop counts", () => {
  const dropsOne = [systemMessage("sys"), userMessage("dropped 1"), assistantText("d1"), userMessage("recent"), assistantText("r")];
  const dropsThree = [
    systemMessage("sys"),
    userMessage("dropped 1"), assistantText("d1"),
    userMessage("dropped 2"), assistantText("d2"),
    userMessage("dropped 3"), assistantText("d3"),
    userMessage("recent"), assistantText("r"),
  ];
  const budget = tokens(dropsOne.slice(0, 1)) + tokens(dropsOne.slice(3, 5));
  const marker = (out: Message[]): string | undefined =>
    out.find((m) => m.role === "system" && m.content.includes("omitted"))?.content as string | undefined;
  assert.equal(marker(compact(dropsOne, budget, true, est).out), marker(compact(dropsThree, budget, true, est).out));
});

test("preserves chronological order", () => {
  const msgs = [
    systemMessage("sys"),
    userMessage("u1"), assistantText("a1"),
    userMessage("u2"), assistantText("a2"),
    userMessage("u3"), assistantText("a3"),
  ];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(3, 7));
  assert.deepEqual(userTexts(compact(msgs, budget, false, est).out), ["u2", "u3"]);
});

test("cache breakpoint protects pre-breakpoint turns over plain recency", () => {
  // sys + 3 turns; cache hint on turn 2's assistant. Budget fits ~2 turns.
  // Plain recency keeps turns 2+3; cache-aware keeps cached prefix (1+2) plus
  // the recent turn (recency invariant) → all three survive here.
  const msgs: Message[] = [
    systemMessage("sys"),
    userMessage("turn 1 user"), assistantText("turn 1 reply"),
    userMessage("turn 2 user"), withCache(assistantText("turn 2 reply"), "ephemeral"),
    userMessage("turn 3 user"), assistantText("turn 3 reply"),
  ];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(1, 3)) + tokens(msgs.slice(3, 5));
  const { out } = compact(msgs, budget, false, est);
  assert.ok(out.some((m) => m.role === "user" && m.content === "turn 1 user"), "cached turn 1 kept");
  assert.ok(out.some((m) => m.role === "user" && m.content === "turn 3 user"), "recent turn kept");
});

test("breakpoint path: omitted marker sits at the gap, not above the cached prefix", () => {
  // 5 turns; cache hint on turn 0's assistant → cached prefix is turn 0.
  // Budget keeps the cached prefix (T0) plus the recent tail (T3, T4),
  // dropping T1 and T2 — a NON-contiguous kept set with a hole in the middle.
  // The marker must land AT that hole (after T0, before T3), not above T0.
  const msgs: Message[] = [
    systemMessage("sys"),
    userMessage("turn 0 user"), withCache(assistantText("turn 0 reply"), "ephemeral"),
    userMessage("turn 1 user"), assistantText("turn 1 reply"),
    userMessage("turn 2 user"), assistantText("turn 2 reply"),
    userMessage("turn 3 user"), assistantText("turn 3 reply"),
    userMessage("turn 4 user"), assistantText("turn 4 reply"),
  ];
  const budget =
    tokens(msgs.slice(0, 1)) + tokens(msgs.slice(1, 3)) + tokens(msgs.slice(7, 9)) + tokens(msgs.slice(9, 11));
  const { out } = compact(msgs, budget, true, est);

  // Cached prefix + recent tail survive; the middle turns are dropped.
  assert.deepEqual(userTexts(out), ["turn 0 user", "turn 3 user", "turn 4 user"]);

  const markerIdx = out.findIndex((m) => m.role === "system" && m.content.includes("omitted"));
  const cachedIdx = out.findIndex((m) => m.role === "user" && m.content === "turn 0 user");
  const tailIdx = out.findIndex((m) => m.role === "user" && m.content === "turn 3 user");
  assert.ok(markerIdx !== -1, "marker present");
  assert.ok(cachedIdx < markerIdx, "marker sits AFTER the cached prefix, not above it");
  assert.ok(markerIdx < tailIdx, "marker sits BEFORE the recent tail (at the real gap)");
});

test("SlidingWindowMemory.compact applies the budget; withoutMarker suppresses the note", async () => {
  const msgs = [
    systemMessage("sys"),
    userMessage("turn 1"), assistantText("reply 1"),
    userMessage("turn 2"), assistantText("reply 2"),
    userMessage("turn 3"), assistantText("reply 3"),
  ];
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(3, 5)) + tokens(msgs.slice(5, 7));
  const withMarker = await new SlidingWindowMemory(budget).compact(msgs);
  assert.ok(hasOmittedMarker(withMarker));
  const noMarker = await new SlidingWindowMemory(budget).withoutMarker().compact(msgs);
  assert.ok(!hasOmittedMarker(noMarker));
  assert.deepEqual(userTexts(noMarker), ["turn 2", "turn 3"]);
});

test("custom estimator that doubles cost halves the effective budget", async () => {
  const doubling = { estimateMessage: (m: Message) => estimateTokens(m) * 2, estimateText };
  const msgs = [
    systemMessage("sys"),
    userMessage("turn 1"), assistantText("reply 1"),
    userMessage("turn 2"), assistantText("reply 2"),
  ];
  // Budget that fits both turns under char-ratio, but only the latest when doubled.
  const budget = tokens(msgs.slice(0, 1)) + tokens(msgs.slice(1, 3)) + tokens(msgs.slice(3, 5));
  const baseline = await new SlidingWindowMemory(budget).withoutMarker().compact(msgs);
  assert.deepEqual(userTexts(baseline), ["turn 1", "turn 2"]);
  const doubled = await new SlidingWindowMemory(budget).withEstimator(doubling).withoutMarker().compact(msgs);
  assert.deepEqual(userTexts(doubled), ["turn 2"]); // older turn dropped under doubled cost
});
