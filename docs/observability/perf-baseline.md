# P8.3 — Node harness performance baseline

> Status: **complete** (2026-06-21). Rust is decommissioned, so there is no
> cross-runtime comparison to draw; this records the **Node harness's own
> overhead** so future changes have a reference point. Re-run with `make perf`
> (or `node --experimental-strip-types --expose-gc scripts/perf-baseline.ts`).

## What it measures

A deterministic in-process stub provider stands in for the LLM (no network, no
artificial delay), so the numbers isolate the harness — not model/network
latency, which dominates real usage by 3–6 orders of magnitude.

1. **Streaming throughput** — `Agent.runStream` relaying provider chunks to
   `AgentEvent`s: chunks/sec + time-to-first-token (TTFT).
2. **Blocking-loop latency** — `Agent.run` wall-time for a turn that does one
   tool call then stops (tool-dispatch + message plumbing).
3. **Memory** — RSS / heapUsed after the run.

`scripts/perf-baseline.ts` is parameterised by `PERF_STREAM_CHUNKS` /
`PERF_STREAM_ITERS` / `PERF_LOOP_ITERS`.

## Reference run

`node v22.22.2`, darwin/arm64, defaults (5000 chunks × 50 iters; 2000 loop iters):

| Metric | p50 | p95 | mean |
|--------|-----|-----|------|
| Streaming TTFT (ms) | 0.01 | 0.03 | 0.01 |
| Streaming throughput (chunks/sec) | ~4.29M | ~4.59M | ~3.96M |
| Blocking-loop turn latency (ms) | ~0 | 0.01 | ~0 |

Memory after the run: **RSS ≈ 80 MB**, heapUsed ≈ 8 MB, heapTotal ≈ 18 MB.

## Interpretation

- The agent loop adds **sub-microsecond** per-turn overhead and relays millions
  of stream chunks per second. End-to-end chat latency is therefore set almost
  entirely by the provider/network, not the harness — there is no harness-side
  throughput bottleneck to optimise for the streaming path.
- ~80 MB RSS is the idle Node + harness footprint (the SPA/static assets and any
  store backend are extra, measured separately when relevant).

These are a floor, not an SLA: real deployments add provider HTTP, persistence
I/O, and MCP subprocesses. Treat regressions in the streaming/loop numbers (e.g.
a 10× drop) as a signal that something in the hot path changed.
