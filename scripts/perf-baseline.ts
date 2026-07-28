// P8.3 — Node harness performance baseline.
//
// Rust is decommissioned, so there is no cross-runtime comparison to make; this
// establishes the *Node* baseline for the harness's own overhead, independent of
// any LLM/network latency (a deterministic in-process stub provider stands in
// for the model). It measures three things that matter for the streaming chat
// path:
//
//   1. streaming throughput — how fast Agent.runStream relays provider chunks
//      to AgentEvents (chunks/sec) + time-to-first-token (TTFT).
//   2. blocking-loop latency — Agent.run wall-time for a turn that does one tool
//      call then stops (the tool-dispatch + message-plumbing overhead).
//   3. memory — RSS + heapUsed after the run.
//
// Run: node --experimental-strip-types scripts/perf-baseline.ts
// Optional: PERF_STREAM_CHUNKS, PERF_STREAM_ITERS, PERF_LOOP_ITERS.
import { performance } from "node:perf_hooks";

// Relative import into the package source: this script runs from scripts/,
// which has no workspace node_modules to resolve the @jarvis/* alias.
import {
  Agent,
  ToolRegistry,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
  type Tool,
  type JsonValue,
} from "../packages/core/src/index.ts";

const STREAM_CHUNKS = intEnv("PERF_STREAM_CHUNKS", 5000);
const STREAM_ITERS = intEnv("PERF_STREAM_ITERS", 50);
const LOOP_ITERS = intEnv("PERF_LOOP_ITERS", 2000);

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Streams `chunks` content deltas then one finish — zero artificial delay, so
 * the measured time is pure harness overhead. */
class StreamStub implements LlmProvider {
  readonly chunks: number;
  constructor(chunks: number) {
    this.chunks = chunks;
  }
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve({ message: { role: "assistant", content: "done" }, finish_reason: "stop" });
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    for (let i = 0; i < this.chunks; i++) {
      yield { type: "content_delta", content: "x" };
    }
    yield {
      type: "finish",
      message: { role: "assistant", content: "x".repeat(this.chunks) },
      finish_reason: "stop",
    };
  }
}

/** One tool-call turn then a stop — exercises the blocking dispatch path. */
class ToolThenStop implements LlmProvider {
  private calls = 0;
  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    if (this.calls % 2 === 1) {
      return Promise.resolve({
        message: { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "noop", arguments: {} }] },
        finish_reason: "tool_calls",
      });
    }
    return Promise.resolve({ message: { role: "assistant", content: "done" }, finish_reason: "stop" });
  }
  completeStream(): AsyncIterable<LlmChunk> {
    throw new Error("unused");
  }
}

const noopTool: Tool = {
  name: "noop",
  description: "noop",
  category: "read",
  requiresApproval: false,
  parameters: { type: "object" } as JsonValue,
  invoke: () => Promise.resolve("ok"),
};

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function stats(xs: number[]): { p50: number; p95: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { p50: pct(s, 50), p95: pct(s, 95), mean };
}

async function benchStreaming(): Promise<{ ttftMs: ReturnType<typeof stats>; throughput: ReturnType<typeof stats> }> {
  const agent = new Agent(new StreamStub(STREAM_CHUNKS), defaultAgentConfig("perf-stub"));
  const ttft: number[] = [];
  const throughput: number[] = [];
  // warmup
  for (let w = 0; w < 3; w++) await drainStream(agent);
  for (let i = 0; i < STREAM_ITERS; i++) {
    const r = await drainStream(agent);
    ttft.push(r.ttftMs);
    throughput.push((STREAM_CHUNKS / r.totalMs) * 1000);
  }
  return { ttftMs: stats(ttft), throughput: stats(throughput) };
}

async function drainStream(agent: Agent): Promise<{ ttftMs: number; totalMs: number }> {
  const start = performance.now();
  let firstAt = -1;
  let deltas = 0;
  for await (const ev of agent.runStream({ messages: [{ role: "user", content: "go" }] })) {
    if (ev.type === "delta") {
      if (firstAt < 0) firstAt = performance.now();
      deltas++;
    }
  }
  const end = performance.now();
  void deltas;
  return { ttftMs: (firstAt < 0 ? end : firstAt) - start, totalMs: end - start };
}

async function benchLoop(): Promise<ReturnType<typeof stats>> {
  const tools = new ToolRegistry();
  tools.register(noopTool);
  const agent = new Agent(new ToolThenStop(), { ...defaultAgentConfig("perf-stub"), tools });
  const lat: number[] = [];
  for (let w = 0; w < 10; w++) await agent.run({ messages: [{ role: "user", content: "go" }] });
  for (let i = 0; i < LOOP_ITERS; i++) {
    const t0 = performance.now();
    await agent.run({ messages: [{ role: "user", content: "go" }] });
    lat.push(performance.now() - t0);
  }
  return stats(lat);
}

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function main(): Promise<void> {
  const stream = await benchStreaming();
  const loop = await benchLoop();
  if (global.gc) global.gc();
  const mem = process.memoryUsage();

  const report = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    config: { STREAM_CHUNKS, STREAM_ITERS, LOOP_ITERS },
    streaming: {
      ttft_ms: round(stream.ttftMs),
      throughput_chunks_per_sec: round(stream.throughput),
    },
    blocking_loop: { turn_latency_ms: round(loop) },
    memory_mb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal) },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function round(s: { p50: number; p95: number; mean: number }): { p50: number; p95: number; mean: number } {
  const r = (x: number) => Math.round(x * 100) / 100;
  return { p50: r(s.p50), p95: r(s.p95), mean: r(s.mean) };
}

main().catch((e) => {
  process.stderr.write(`perf-baseline failed: ${String(e)}\n`);
  process.exit(1);
});
