import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  finishRequirementRun,
  newRequirementRun,
  type RequirementRun,
  type RequirementRunEvent,
  type RequirementRunStore,
  type VerificationResult,
} from "@jarvis/project";
import {
  classifyRunEvent,
  JsonFileRequirementRunStore,
  MemoryRequirementRunStore,
} from "./requirement-run-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-run-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function run(requirementId: string, conversationId = "c1"): RequirementRun {
  return newRequirementRun(requirementId, conversationId);
}

function contract(name: string, make: (dir: string) => Promise<RequirementRunStore>): void {
  test(`${name}: upsert/get round-trips; missing → undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r = run("req1");
      await store.upsert(r);
      assert.equal((await store.get(r.id))?.requirement_id, "req1");
      assert.equal(await store.get("missing"), undefined);
    });
  });

  test(`${name}: listForRequirement scopes + sorts newest-first by started_at`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = run("req1");
      await store.upsert(a);
      await tick();
      const b = run("req1");
      await store.upsert(b);
      await tick();
      const other = run("req2");
      await store.upsert(other);
      const rows = await store.listForRequirement("req1");
      assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
      assert.deepEqual((await store.listForRequirement("req2")).map((r) => r.id), [other.id]);
      assert.deepEqual(await store.listForRequirement("none"), []);
    });
  });

  test(`${name}: listAll spans requirements, newest-first, respects limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = run("req1");
      await store.upsert(a);
      await tick();
      const b = run("req2");
      await store.upsert(b);
      await tick();
      const c = run("req3");
      await store.upsert(c);
      assert.deepEqual((await store.listAll(2)).map((r) => r.id), [c.id, b.id]);
      assert.equal((await store.listAll(10)).length, 3);
    });
  });

  test(`${name}: upsert emits started on first insert (non-terminal)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementRunEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      await store.upsert(run("req1")); // status "pending" → started
      assert.deepEqual(seen.map((e) => e.type), ["started"]);
    });
  });

  test(`${name}: upsert emits finished when crossing into a terminal status`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementRunEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      const r = run("req1");
      await store.upsert(r); // started
      r.status = "running";
      await store.upsert(r); // non-terminal → non-terminal: no event
      finishRequirementRun(r, "completed");
      await store.upsert(r); // → terminal: finished
      assert.deepEqual(seen.map((e) => e.type), ["started", "finished"]);
    });
  });

  test(`${name}: a run inserted already-terminal emits finished, not started`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementRunEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      const r = run("req1");
      finishRequirementRun(r, "failed"); // terminal before first write
      await store.upsert(r);
      assert.deepEqual(seen.map((e) => e.type), ["finished"]);
    });
  });

  test(`${name}: re-upserting an already-terminal run emits no event`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r = run("req1");
      finishRequirementRun(r, "completed");
      await store.upsert(r);
      const seen: RequirementRunEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      r.summary = "tweaked after completion";
      await store.upsert(r); // terminal → terminal: silent
      assert.equal(seen.length, 0);
    });
  });

  test(`${name}: broadcast fans out a verified event WITHOUT a write`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementRunEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      const result: VerificationResult = { status: "passed", command_results: [] };
      store.broadcast({ type: "verified", run_id: "run-x", result });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.type, "verified");
      // Nothing was persisted by broadcast.
      assert.equal(await store.get("run-x"), undefined);
      assert.deepEqual(await store.listAll(10), []);
    });
  });

  test(`${name}: subscribe unsubscribe stops delivery`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementRunEvent[] = [];
      const off = store.subscribe((ev) => seen.push(ev));
      await store.upsert(run("req1"));
      off();
      await store.upsert(run("req2"));
      assert.equal(seen.length, 1);
    });
  });
}

contract("json-file", (dir) => JsonFileRequirementRunStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryRequirementRunStore()));

// ---------- classifyRunEvent unit table ----------

test("classifyRunEvent: transition rules", () => {
  const base = newRequirementRun("req1", "c1");

  // absent → non-terminal ⇒ started
  assert.equal(classifyRunEvent(undefined, { ...base, status: "pending" })?.type, "started");
  assert.equal(classifyRunEvent(undefined, { ...base, status: "running" })?.type, "started");

  // absent → terminal ⇒ finished (not started)
  assert.equal(classifyRunEvent(undefined, { ...base, status: "completed" })?.type, "finished");

  // non-terminal → terminal ⇒ finished
  assert.equal(
    classifyRunEvent({ ...base, status: "running" }, { ...base, status: "failed" })?.type,
    "finished",
  );

  // non-terminal → non-terminal ⇒ no event
  assert.equal(
    classifyRunEvent({ ...base, status: "pending" }, { ...base, status: "running" }),
    undefined,
  );

  // terminal → terminal ⇒ no event
  assert.equal(
    classifyRunEvent({ ...base, status: "completed" }, { ...base, status: "completed" }),
    undefined,
  );

  // present non-terminal → same non-terminal ⇒ no event (not re-started)
  assert.equal(
    classifyRunEvent({ ...base, status: "running" }, { ...base, status: "running" }),
    undefined,
  );
});
