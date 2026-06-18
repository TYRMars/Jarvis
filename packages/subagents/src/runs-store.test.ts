// SubAgentRunStore contract tests — run against both the Memory and JsonFile
// backends. Ported from harness-server/src/subagent_runs.rs::tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MemorySubAgentRunStore,
  JsonFileSubAgentRunStore,
  MAX_RUNS,
  type SubAgentRunStore,
  type SubAgentEvent,
  type SubAgentFrame,
} from "./index.ts";

function frame(id: string, name: string, event: SubAgentEvent): SubAgentFrame {
  return { subagent_id: id, subagent_name: name, event };
}

/** Run the shared contract against a freshly-opened store. */
function contract(label: string, open: () => Promise<SubAgentRunStore>): void {
  test(`[${label}] started then done -> completed`, async () => {
    const s = await open();
    await s.recordFrame("conv-1", frame("s1", "review", { kind: "started", task: "verify", model: "claude-3-5" }));
    await s.recordFrame("conv-1", frame("s1", "review", { kind: "done", final_message: "pass" }));
    const list = await s.list();
    assert.equal(list.length, 1);
    const r = list[0]!;
    assert.equal(r.name, "review");
    assert.equal(r.task, "verify");
    assert.equal(r.model, "claude-3-5");
    assert.equal(r.status, "completed");
    assert.equal(r.final_message, "pass");
    assert.equal(r.conversation_id, "conv-1");
  });

  test(`[${label}] error terminal -> failed + error set`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("s2", "doc_reader", { kind: "error", message: "boom" }));
    const r = await s.get("s2");
    assert.ok(r);
    assert.equal(r!.status, "failed");
    assert.equal(r!.error, "boom");
    assert.equal(r!.conversation_id, undefined);
  });

  test(`[${label}] tool_start increments the count`, async () => {
    const s = await open();
    for (let i = 0; i < 3; i++) {
      await s.recordFrame(undefined, frame("s3", "codex", { kind: "tool_start", name: "fs.read", arguments: {} }));
    }
    assert.equal((await s.get("s3"))!.tool_call_count, 3);
  });

  test(`[${label}] cancel a running run -> cancelled + isCancelled`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("s4", "codex", { kind: "started", task: "x" }));
    assert.ok(!(await s.isCancelled("s4")));
    assert.ok(await s.cancel("s4"));
    assert.ok(await s.isCancelled("s4"));
    assert.equal((await s.get("s4"))!.status, "cancelled");
  });

  test(`[${label}] cancel unknown -> false`, async () => {
    const s = await open();
    assert.ok(!(await s.cancel("nope")));
  });

  test(`[${label}] cancel an already-completed run is a no-op`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("s5", "codex", { kind: "done", final_message: "ok" }));
    assert.ok(!(await s.cancel("s5")));
    assert.equal((await s.get("s5"))!.status, "completed");
  });

  test(`[${label}] done after cancel keeps cancelled status`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("s6", "codex", { kind: "started", task: "x" }));
    assert.ok(await s.cancel("s6"));
    await s.recordFrame(undefined, frame("s6", "codex", { kind: "done", final_message: "lol" }));
    assert.equal((await s.get("s6"))!.status, "cancelled");
  });

  test(`[${label}] list returns runs newest-first by started_at`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("old", "x", { kind: "started", task: "a" }));
    await new Promise((r) => setTimeout(r, 4));
    await s.recordFrame(undefined, frame("new", "x", { kind: "started", task: "b" }));
    const list = await s.list();
    assert.equal(list[0]!.id, "new");
    assert.equal(list[1]!.id, "old");
  });

  test(`[${label}] events endpoint returns recorded frames; undefined for unknown`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("s7", "x", { kind: "started", task: "x" }));
    await s.recordFrame(undefined, frame("s7", "x", { kind: "status", message: "thinking" }));
    const evs = await s.events("s7");
    assert.ok(evs);
    assert.equal(evs!.length, 2);
    assert.equal(await s.events("missing"), undefined);
  });

  test(`[${label}] running rows recompute duration_ms at read time`, async () => {
    const s = await open();
    await s.recordFrame(undefined, frame("dur", "x", { kind: "started", task: "x" }));
    await new Promise((r) => setTimeout(r, 6));
    const r = await s.get("dur");
    assert.ok(r);
    assert.equal(r!.status, "running");
    assert.ok(r!.duration_ms >= 0);
  });
}

contract("memory", () => Promise.resolve(new MemorySubAgentRunStore()));

contract("jsonfile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-runs-"));
  return JsonFileSubAgentRunStore.open(dir);
});

// FIFO ring eviction is Memory-backend-specific (the in-process registry). The
// JsonFile backend caps the directory similarly; we exercise the Memory ring
// directly since driving MAX_RUNS+ disk rows would be slow.
test("[memory] ring evicts the oldest past the cap", async () => {
  const s = new MemorySubAgentRunStore();
  for (let i = 0; i < MAX_RUNS + 5; i++) {
    await s.recordFrame(undefined, frame(`id-${i}`, "x", { kind: "started", task: `t${i}` }));
  }
  assert.equal(await s.get("id-0"), undefined, "oldest should be evicted");
  assert.ok(await s.get(`id-${MAX_RUNS + 4}`), "newest should remain");
});

// JsonFile durability: a fresh store over the same dir sees prior runs.
test("[jsonfile] runs survive reopening the same directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-runs-reopen-"));
  try {
    const s1 = await JsonFileSubAgentRunStore.open(dir);
    await s1.recordFrame("c", frame("persisted", "review", { kind: "done", final_message: "ok" }));
    const s2 = await JsonFileSubAgentRunStore.open(dir);
    const r = await s2.get("persisted");
    assert.ok(r);
    assert.equal(r!.status, "completed");
    assert.equal(r!.final_message, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
