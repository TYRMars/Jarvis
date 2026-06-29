import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider, Message } from "@jarvis/core";
import { systemMessage, userMessage, assistantText, withCache } from "@jarvis/core";

import {
  SummarizingMemory,
  stripSummaryPreamble,
  fingerprint,
  renderForSummary,
  enforceTokenBudget,
  type SummaryStore,
} from "./summarizing.ts";
import { charRatioEstimator } from "./tokens.ts";

// ---------- fakes ----------

/** Records every ChatRequest and returns a canned assistant reply. */
class FakeLlm implements LlmProvider {
  calls = 0;
  captured: ChatRequest[] = [];
  readonly #reply: string;
  constructor(reply: string) {
    this.#reply = reply;
  }

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    this.captured.push(req);
    return Promise.resolve({
      message: assistantText(this.#reply),
      finish_reason: "stop",
    });
  }
  completeStream(_req: ChatRequest): AsyncIterable<LlmChunk> {
    throw new Error("not used in tests");
  }
}

/** Always rejects with a non-transport-style provider error. */
class FailingLlm implements LlmProvider {
  calls = 0;
  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return Promise.reject(new Error("status 500: nope"));
  }
  completeStream(_req: ChatRequest): AsyncIterable<LlmChunk> {
    throw new Error("not used in tests");
  }
}

/** In-memory SummaryStore for persistence tests. */
class FakeStore implements SummaryStore {
  readonly rows = new Map<string, string>();
  gets = 0;
  puts = 0;
  get(hash: string): Promise<string | undefined> {
    this.gets += 1;
    return Promise.resolve(this.rows.get(hash));
  }
  put(hash: string, summary: string): Promise<void> {
    this.puts += 1;
    this.rows.set(hash, summary);
    return Promise.resolve();
  }
}

/** A store whose get/put always reject — exercises graceful degradation. */
class FlakyStore implements SummaryStore {
  get(_hash: string): Promise<string | undefined> {
    return Promise.reject(new Error("db down"));
  }
  put(_hash: string, _summary: string): Promise<void> {
    return Promise.reject(new Error("db down"));
  }
}

// ---------- helpers ----------

const sys = systemMessage;
const user = userMessage;
const asst = assistantText;

const hasSystemContaining = (out: Message[], needle: string): boolean =>
  out.some((m) => m.role === "system" && m.content.includes(needle));
const hasUserExactly = (out: Message[], content: string): boolean =>
  out.some((m) => m.role === "user" && m.content === content);
const posOf = (out: Message[], needle: string): number =>
  out.findIndex((m) => {
    if (m.role === "system" || m.role === "user") return m.content.includes(needle);
    if (m.role === "assistant") return (m.content ?? "").includes(needle);
    return false;
  });

// ---------- core behaviour ----------

test("under budget skips the summariser", async () => {
  const llm = new FakeLlm("SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 10_000);
  const msgs = [sys("sys"), user("hi"), asst("hello")];
  const out = await mem.compact(msgs);
  assert.equal(out.length, msgs.length);
  assert.equal(llm.calls, 0);
});

test("over budget inserts the summary and keeps the latest turn", async () => {
  const llm = new FakeLlm("ALPHA AND BETA HAPPENED");
  const mem = new SummarizingMemory(llm, "test-model", 256);
  const msgs = [
    sys("sys"),
    user("turn 1"), asst("reply 1"),
    user("turn 2"), asst("reply 2"),
    user("turn 3 most recent"), asst("reply 3"),
  ];
  const out = await mem.compact(msgs);
  assert.equal(llm.calls, 1);
  assert.ok(hasSystemContaining(out, "ALPHA AND BETA HAPPENED"));
  assert.ok(hasUserExactly(out, "turn 3 most recent"));
});

test("breakpoint summary sits between cached prefix and recent tail", async () => {
  const llm = new FakeLlm("MIDDLE_SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 400);
  const big = "lorem ipsum dolor sit amet ".repeat(80); // ~2160 chars
  const msgs: Message[] = [
    sys("sys"),
    user("cached q1"),
    withCache(asst("cached a1"), "ephemeral"),
    user(`middle q2 ${big}`),
    asst(`middle a2 ${big}`),
    user(`middle q3 ${big}`),
    asst(`middle a3 ${big}`),
    user("recent q4"),
    asst("recent a4"),
  ];
  const out = await mem.compact(msgs);
  const cached = posOf(out, "cached a1");
  const summary = posOf(out, "MIDDLE_SUMMARY");
  const recent = posOf(out, "recent q4");
  assert.ok(cached >= 0 && summary >= 0 && recent >= 0, "all three landmarks present");
  assert.ok(cached < summary && summary < recent, `order: cached=${cached} summary=${summary} recent=${recent}`);
  assert.equal(posOf(out, "middle q2"), -1, "dropped middle turn should be gone");
});

test("leading system blocks survive; summary lands after them", async () => {
  const llm = new FakeLlm("OLD STUFF SUMMARISED");
  const mem = new SummarizingMemory(llm, "test-model", 256);
  const msgs = [
    sys("base agent prompt"),
    sys("=== project: Writing ===\nbe lyrical"),
    user("turn 1"), asst("reply 1"),
    user("turn 2"), asst("reply 2"),
    user("turn 3 most recent"), asst("reply 3"),
  ];
  const out = await mem.compact(msgs);
  assert.ok(out[0]!.role === "system" && out[0]!.content === "base agent prompt");
  assert.ok(out[1]!.role === "system" && out[1]!.content.includes("=== project: Writing ==="));
  const summaryIdx = out.findIndex((m) => m.role === "system" && m.content.includes("OLD STUFF SUMMARISED"));
  assert.ok(summaryIdx >= 2, "summary must come after the leading systems");
});

// ---------- caching ----------

test("in-memory cache dedupes an identical dropped prefix", async () => {
  const llm = new FakeLlm("SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 256);
  const msgs = [sys("sys"), user("old turn"), asst("old reply"), user("recent"), asst("recent reply")];
  await mem.compact(msgs);
  await mem.compact(msgs);
  assert.equal(llm.calls, 1, "same dropped prefix → one LLM call total");
});

test("cache invalidates when the dropped prefix changes", async () => {
  const llm = new FakeLlm("SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 256);
  const first = [sys("sys"), user("old turn"), asst("old reply"), user("recent"), asst("recent reply")];
  await mem.compact(first);
  const second = [
    sys("sys"),
    user("old turn"), asst("old reply"),
    user("middle"), asst("middle reply"),
    user("recent"), asst("recent reply"),
  ];
  await mem.compact(second);
  assert.equal(llm.calls, 2, "dropped prefix grew → a fresh summary call");
});

// ---------- soft-fail ----------

test("LLM failure falls back to a placeholder note, not a hard error", async () => {
  const mem = new SummarizingMemory(new FailingLlm(), "test-model", 64);
  const msgs = [sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")];
  const out = await mem.compact(msgs);
  assert.ok(hasSystemContaining(out, "summary unavailable"), `missing placeholder: ${JSON.stringify(out)}`);
  assert.ok(hasUserExactly(out, "recent"), "recent turn must survive the fallback");
});

test("a throwing estimator soft-fails to the input messages, not a hard error", async () => {
  // The estimator is injectable (withEstimator) — a tiktoken-backed impl may
  // throw on an unexpected message shape. The whole compact body must degrade,
  // not just the LLM sub-step, returning the input unchanged per the contract.
  const throwingEstimator = {
    estimateMessage(): number {
      throw new Error("boom: malformed message");
    },
    estimateText(): number {
      throw new Error("boom: malformed text");
    },
  };
  const mem = new SummarizingMemory(new FakeLlm("unused"), "test-model", 64).withEstimator(
    throwingEstimator,
  );
  const msgs = [sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")];
  const out = await mem.compact(msgs);
  assert.deepEqual(out, msgs, "compact must return the input messages unchanged on estimator throw");
});

// ---------- transport-error retry ----------

const DROP5 = [sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")];

test("a transient transport error is retried once then succeeds", async () => {
  // Provider error messages from @jarvis/llm carry a `transport:` marker for
  // connection-pool flakes (DNS, TLS, half-closed keep-alive). The first send
  // flakes; the retry succeeds — matches the Rust `summarise` retry.
  class FlakyOnce implements LlmProvider {
    calls = 0;
    complete(_req: ChatRequest): Promise<ChatResponse> {
      this.calls += 1;
      if (this.calls === 1) return Promise.reject(new Error("transport: connection reset"));
      return Promise.resolve({ message: assistantText("EVENTUAL SUMMARY"), finish_reason: "stop" });
    }
    completeStream(): AsyncIterable<LlmChunk> {
      throw new Error("unused");
    }
  }
  const llm = new FlakyOnce();
  const mem = new SummarizingMemory(llm, "test-model", 64);
  const out = await mem.compact(DROP5);
  assert.equal(llm.calls, 2, "expected exactly one retry");
  assert.ok(hasSystemContaining(out, "EVENTUAL SUMMARY"), "real summary after retry");
});

test("a persistent transport error retries once then soft-fails", async () => {
  class AlwaysTransport implements LlmProvider {
    calls = 0;
    complete(_req: ChatRequest): Promise<ChatResponse> {
      this.calls += 1;
      return Promise.reject(new Error("transport: dns error"));
    }
    completeStream(): AsyncIterable<LlmChunk> {
      throw new Error("unused");
    }
  }
  const llm = new AlwaysTransport();
  const mem = new SummarizingMemory(llm, "test-model", 64);
  const out = await mem.compact(DROP5);
  assert.equal(llm.calls, 2, "exactly one retry before falling back");
  assert.ok(hasSystemContaining(out, "summary unavailable"));
});

test("a non-transport error (4xx/5xx) is NOT retried", async () => {
  // FailingLlm rejects with `status 500: nope` — no `transport:` marker — so
  // the second attempt would fail identically and is skipped.
  const llm = new FailingLlm();
  const mem = new SummarizingMemory(llm, "test-model", 64);
  await mem.compact(DROP5);
  assert.equal(llm.calls, 1, "HTTP-level rejection should not retry");
});

// ---------- summary request shape ----------

test("summary request omits tools and pins temperature", async () => {
  const llm = new FakeLlm("ok");
  const mem = new SummarizingMemory(llm, "test-model", 256);
  await mem.compact([sys("sys"), user("a"), asst("b"), user("c"), asst("d")]);
  assert.equal(llm.captured.length, 1);
  const req = llm.captured[0]!;
  assert.equal(req.model, "test-model");
  assert.deepEqual(req.tools, []);
  assert.equal(req.temperature, 0);
  assert.ok(req.max_tokens !== undefined && req.max_tokens > 0);
});

// ---------- persistence ----------

test("a fresh LLM summary is written back to the store", async () => {
  const llm = new FakeLlm("REMEMBERED");
  const store = new FakeStore();
  const mem = new SummarizingMemory(llm, "test-model", 256).withPersistence(store);
  await mem.compact([sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")]);
  assert.equal(store.puts, 1);
  assert.equal([...store.rows.values()][0], "REMEMBERED");
});

test("persistence rehydrates across instances (no second LLM call)", async () => {
  const store = new FakeStore();

  const llm1 = new FakeLlm("FIRST RUN SUMMARY");
  const mem1 = new SummarizingMemory(llm1, "test-model", 256).withPersistence(store);
  const msgs = [sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")];
  const out1 = await mem1.compact(msgs);
  assert.equal(llm1.calls, 1);
  assert.ok(hasSystemContaining(out1, "FIRST RUN SUMMARY"));

  // Second "process": fresh instance + fresh in-memory cache. The store hit
  // means the (different) LLM is never asked.
  const llm2 = new FakeLlm("DIFFERENT TEXT");
  const mem2 = new SummarizingMemory(llm2, "test-model", 256).withPersistence(store);
  const out2 = await mem2.compact(msgs);
  assert.equal(llm2.calls, 0, "second instance rehydrates from the store");
  assert.ok(hasSystemContaining(out2, "FIRST RUN SUMMARY"));
});

test("blank persisted rows are treated as a miss and overwritten", async () => {
  const store = new FakeStore();
  // Pre-seed a blank row under the fingerprint the next compact will compute.
  const dropped = [user("old"), asst("old reply")];
  store.rows.set(fingerprint(dropped), "   ");
  const llm = new FakeLlm("REAL SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 256).withPersistence(store);
  const out = await mem.compact([sys("sys"), user("old"), asst("old reply"), user("recent"), asst("recent reply")]);
  assert.equal(llm.calls, 1, "blank row should not count as a hit");
  assert.ok(hasSystemContaining(out, "REAL SUMMARY"));
});

test("store get/put failures degrade gracefully", async () => {
  const llm = new FakeLlm("SUMMARY");
  const mem = new SummarizingMemory(llm, "test-model", 256).withPersistence(new FlakyStore());
  const out = await mem.compact([sys("sys"), user("a"), asst("b"), user("c"), asst("d")]);
  // Get rejected → fell through to LLM; put rejected → swallowed. Compact ok.
  assert.equal(llm.calls, 1);
  assert.ok(hasSystemContaining(out, "SUMMARY"));
});

// ---------- circuit breaker ----------

test("circuit breaker trips after three failures and skips the LLM", async () => {
  const llm = new FailingLlm();
  const mem = new SummarizingMemory(llm, "test-model", 64);
  // Each compact needs a *different* dropped prefix so the in-memory cache
  // doesn't short-circuit and skip the LLM.
  for (let i = 0; i < 5; i++) {
    await mem.compact([sys("sys"), user(`old-${i}`), asst("old reply"), user("recent"), asst("recent reply")]);
  }
  assert.equal(llm.calls, 3, "3 attempts trip the breaker; the next 2 are circuit-skipped");
});

test("a successful summary resets the failure streak", async () => {
  // Fails twice, then succeeds — the success must reset the streak so the
  // breaker never trips.
  class TwiceThenOk implements LlmProvider {
    calls = 0;
    complete(_req: ChatRequest): Promise<ChatResponse> {
      this.calls += 1;
      if (this.calls <= 2) return Promise.reject(new Error("status 500"));
      return Promise.resolve({ message: assistantText("EVENTUAL"), finish_reason: "stop" });
    }
    completeStream(): AsyncIterable<LlmChunk> {
      throw new Error("unused");
    }
  }
  const llm = new TwiceThenOk();
  const mem = new SummarizingMemory(llm, "test-model", 64);
  for (let i = 0; i < 5; i++) {
    await mem.compact([sys("sys"), user(`old-${i}`), asst("old reply"), user("recent"), asst("recent reply")]);
  }
  // Calls 1,2 fail (streak 1,2), call 3 succeeds (reset), 4 & 5 succeed.
  assert.equal(llm.calls, 5, "breaker never tripped because of the reset");
});

// ---------- PTL safety net ----------

test("PTL drops oldest turns when the summary pushes over budget", async () => {
  const llm = new FakeLlm("X".repeat(2000));
  const mem = new SummarizingMemory(llm, "test-model", 300);
  const msgs = [
    sys("sys"),
    user("turn 1"), asst("reply 1 with some longer text"),
    user("turn 2"), asst("reply 2 with some longer text"),
    user("turn 3"), asst("reply 3 with some longer text"),
    user("turn 4 most recent"), asst("reply 4"),
  ];
  const out = await mem.compact(msgs);
  assert.ok(hasUserExactly(out, "turn 4 most recent"), "latest turn must survive PTL");
  assert.ok(hasSystemContaining(out, "truncated to fit token budget"), "expected PTL marker");
  assert.ok(!hasUserExactly(out, "turn 1"), "oldest turn should have been dropped");
});

test("PTL is a no-op under budget", async () => {
  const llm = new FakeLlm("short");
  const mem = new SummarizingMemory(llm, "test-model", 10_000);
  const out = await mem.compact([sys("sys"), user("hi"), asst("hello"), user("how are you"), asst("good")]);
  assert.ok(!hasSystemContaining(out, "truncated to fit token budget"));
});

test("enforceTokenBudget keeps the trailing working-context block", () => {
  const msgs = [
    sys("sys"),
    user("turn 1 something long enough"), asst("reply 1 also reasonably long here"),
    user("turn 2 another long user message"), asst("reply 2 with extra padding text"),
    user("turn 3 most recent here"), asst("reply 3 short"),
    sys("=== working context ===\nrecent files:\n- src/lib.rs\n"),
  ];
  const { out } = enforceTokenBudget(msgs, 50, charRatioEstimator);
  const last = out[out.length - 1]!;
  assert.ok(last.role === "system" && last.content.startsWith("=== working context ==="), "trailing block lost");
  assert.ok(hasUserExactly(out, "turn 3 most recent here"), "latest user turn must remain");
});

// ---------- helpers: preamble stripper ----------

test("stripSummaryPreamble removes a common meta opener", () => {
  const raw =
    "The user wants me to summarise the conversation excerpt. " +
    "I need to compress it into a short paragraph.\n\n" +
    "Key facts: agent ran requirement.list (30 items, 12 in_progress).";
  const out = stripSummaryPreamble(raw);
  assert.ok(out.startsWith("Key facts:"), `got: ${out}`);
  assert.ok(!out.includes("The user wants me to"));
});

test("stripSummaryPreamble handles the US 'summarize' spelling", () => {
  const raw =
    "The user wants me to summarize the conversation. The excerpt is in Chinese.\n\n" +
    "Decision: focus on Web UI experience.";
  assert.ok(stripSummaryPreamble(raw).startsWith("Decision:"));
});

test("stripSummaryPreamble leaves a clean summary alone", () => {
  const raw = "User asked for kanban review. Agent ran requirement.list.";
  assert.equal(stripSummaryPreamble(raw), raw);
});

test("stripSummaryPreamble bails when there is no paragraph break", () => {
  const raw = "The user wants me to summarise something. Key facts inline.";
  assert.equal(stripSummaryPreamble(raw), raw);
});

test("stripSummaryPreamble handles 'Let me summarise'", () => {
  const raw = "Let me summarise what happened.\n\nUser approved the kanban triage.";
  assert.ok(stripSummaryPreamble(raw).startsWith("User approved"));
});

// ---------- helpers: fingerprint + render ----------

test("fingerprint is stable and content-sensitive", () => {
  const a = [user("hi"), asst("there")];
  const b = [user("hi"), asst("there")];
  const c = [user("hi"), asst("THERE")];
  assert.equal(fingerprint(a), fingerprint(b), "identical slices hash equal");
  assert.notEqual(fingerprint(a), fingerprint(c), "content change changes the hash");
});

test("renderForSummary flattens roles and tool calls", () => {
  const msgs: Message[] = [
    sys("be brief"),
    user("read the file"),
    { role: "assistant", content: "ok", tool_calls: [{ id: "c1", name: "fs.read", arguments: { path: "a.txt" } }] },
    { role: "tool", tool_call_id: "c1", content: "contents" },
  ];
  const text = renderForSummary(msgs);
  assert.ok(text.includes("[system] be brief"));
  assert.ok(text.includes("[user] read the file"));
  assert.ok(text.includes("<call fs.read("));
  assert.ok(text.includes('"path":"a.txt"'));
  assert.ok(text.includes("[tool c1] contents"));
});
