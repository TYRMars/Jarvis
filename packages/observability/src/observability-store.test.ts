import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ObservabilityStore, ObservedRun, ObservedOutcome, ObservedRunKind } from "./index.ts";
import { JsonFileObservabilityStore, MemoryObservabilityStore } from "./index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-obs-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(
  id: string,
  opts: {
    startedAt?: string;
    kind?: ObservedRunKind;
    name?: string;
    outcome?: ObservedOutcome;
    durationMs?: number;
    projectId?: string;
  } = {},
): ObservedRun {
  const r: ObservedRun = {
    id,
    kind: opts.kind ?? "agent",
    name: opts.name ?? "turn",
    started_at: opts.startedAt ?? "2026-01-01T00:00:00.000Z",
    outcome: opts.outcome ?? "success",
    attributes: null,
    metrics: null,
  };
  if (opts.durationMs !== undefined) r.duration_ms = opts.durationMs;
  if (opts.projectId !== undefined) r.project_id = opts.projectId;
  return r;
}

function contract(name: string, make: (dir: string) => Promise<ObservabilityStore>): void {
  test(`${name}: append_run then list round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendRun(run("r1"));
      const rows = await store.listRuns({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "r1");
      assert.equal(rows[0].attributes, null);
      assert.equal(rows[0].metrics, null);
      assert.equal(rows[0].artifact_ids, undefined);
    });
  });

  test(`${name}: listRuns is newest-first by started_at and respects limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendRun(run("a", { startedAt: "2026-01-01T00:00:00.000Z" }));
      await store.appendRun(run("b", { startedAt: "2026-01-02T00:00:00.000Z" }));
      await store.appendRun(run("c", { startedAt: "2026-01-03T00:00:00.000Z" }));
      const all = await store.listRuns({});
      assert.deepEqual(all.map((r) => r.id), ["c", "b", "a"]);
      const capped = await store.listRuns({ limit: 2 });
      assert.deepEqual(capped.map((r) => r.id), ["c", "b"]);
    });
  });

  test(`${name}: listRuns filters by kind / name / outcome / project_id`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendRun(run("agent-ok", { kind: "agent", name: "turn", outcome: "success", projectId: "p1" }));
      await store.appendRun(run("tool-err", { kind: "tool", name: "fs.write", outcome: "error", projectId: "p2" }));
      await store.appendRun(run("agent-err", { kind: "agent", name: "turn", outcome: "error", projectId: "p1" }));

      assert.deepEqual((await store.listRuns({ kind: "tool" })).map((r) => r.id), ["tool-err"]);
      assert.deepEqual(
        (await store.listRuns({ name: "turn" })).map((r) => r.id).sort(),
        ["agent-err", "agent-ok"],
      );
      assert.deepEqual((await store.listRuns({ outcome: "success" })).map((r) => r.id), ["agent-ok"]);
      assert.deepEqual(
        (await store.listRuns({ project_id: "p1" })).map((r) => r.id).sort(),
        ["agent-err", "agent-ok"],
      );
      // Compound filter.
      assert.deepEqual(
        (await store.listRuns({ kind: "agent", outcome: "error" })).map((r) => r.id),
        ["agent-err"],
      );
    });
  });

  test(`${name}: appendRun overwrites by id (last write wins)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendRun(run("dup", { name: "first" }));
      await store.appendRun(run("dup", { name: "second" }));
      const rows = await store.listRuns({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, "second");
    });
  });

  test(`${name}: span + metric appends don't surface in listRuns`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendSpanSummary({
        id: "s1",
        trace_id: "t1",
        span_id: "sp1",
        name: "span",
        started_at: "2026-01-01T00:00:00.000Z",
        outcome: "success",
        attributes: null,
      });
      await store.appendMetricPoint({
        id: "m1",
        name: "latency",
        kind: "gauge",
        timestamp: "2026-01-01T00:00:00.000Z",
        value: 12.5,
        attributes: null,
      });
      assert.equal((await store.listRuns({})).length, 0);
    });
  });

  test(`${name}: dashboard aggregates counts, success rate, p95, by_kind/by_name`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.appendRun(run("r1", { kind: "agent", name: "turn", outcome: "success", durationMs: 100 }));
      await store.appendRun(run("r2", { kind: "agent", name: "turn", outcome: "success", durationMs: 200 }));
      await store.appendRun(run("r3", { kind: "tool", name: "fs.read", outcome: "error", durationMs: 1000 }));

      const snap = await store.dashboard({ label: "24h" });
      assert.equal(snap.total_runs, 3);
      assert.equal(snap.successful_runs, 2);
      assert.equal(snap.failed_runs, 1);
      assert.equal(snap.run_success_rate, 2 / 3);
      // p95 over [100,200,1000]: idx = ceil((3-1)*0.95) = ceil(1.9) = 2 → 1000.
      assert.equal(snap.p95_latency_ms, 1000);
      assert.equal(snap.window.label, "24h");
      assert.ok(typeof snap.generated_at === "string" && snap.generated_at.endsWith("Z"));
      // by_kind keys use the Rust Debug repr (PascalCase variant names).
      assert.deepEqual(snap.by_kind, { Agent: 2, Tool: 1 });
      assert.deepEqual(snap.by_name, { "fs.read": 1, turn: 2 });
    });
  });

  test(`${name}: dashboard on an empty store omits rate + p95`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const snap = await store.dashboard({ label: "24h" });
      assert.equal(snap.total_runs, 0);
      assert.equal(snap.successful_runs, 0);
      assert.equal(snap.failed_runs, 0);
      assert.equal(snap.run_success_rate, undefined);
      assert.equal(snap.p95_latency_ms, undefined);
      assert.deepEqual(snap.by_kind, {});
      assert.deepEqual(snap.by_name, {});
    });
  });
}

contract("json-file", (dir) => JsonFileObservabilityStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryObservabilityStore()));

// ---------- JSON-file-specific ----------

test("json-file: runs land under <base>/runs/<id>.json", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileObservabilityStore.open(dir);
    await store.appendRun(run("layout-run"));
    const files = await readdir(path.join(dir, "runs"));
    assert.ok(files.includes("layout-run.json"));
  });
});

test("json-file: a colon in the id is percent-encoded in the filename", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileObservabilityStore.open(dir);
    await store.appendRun(run("eval:case:1"));
    const files = await readdir(path.join(dir, "runs"));
    assert.ok(files.includes("eval%3Acase%3A1.json"));
    // Still listable through the API.
    assert.deepEqual((await store.listRuns({})).map((r) => r.id), ["eval:case:1"]);
  });
});

test("json-file: withMaxRuns prunes oldest beyond the cap + slack", async () => {
  await withTempDir(async (dir) => {
    // cap 10, slack = floor(10/10) = 1 → prune only once size > 11.
    const store = (await JsonFileObservabilityStore.open(dir)).withMaxRuns(10);
    for (let i = 0; i < 12; i += 1) {
      // Stagger so mtimes are distinguishable; pad ids for stable ordering.
      await store.appendRun(run(`run-${String(i).padStart(3, "0")}`));
      await new Promise((r) => setTimeout(r, 2));
    }
    const files = await readdir(path.join(dir, "runs"));
    const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".json.tmp"));
    assert.equal(jsonFiles.length, 10, "pruned down to the cap once over cap+slack");
    // The two oldest should be gone.
    assert.ok(!jsonFiles.includes("run-000.json"));
    assert.ok(!jsonFiles.includes("run-001.json"));
    assert.ok(jsonFiles.includes("run-011.json"));
  });
});

test("json-file: withMaxRuns(0) keeps the just-written run (no total wipe)", async () => {
  await withTempDir(async (dir) => {
    // A `0` cap is a misconfig (distinct from `null`); it must never delete
    // everything. Regression guard for #322.
    const store = (await JsonFileObservabilityStore.open(dir)).withMaxRuns(0);
    await store.appendRun(run("a"));
    await store.appendRun(run("b"));
    const rows = await store.listRuns({});
    assert.equal(rows.length, 1, "clamped to a floor of 1, not wiped to empty");
    assert.equal(rows[0].id, "b", "newest run retained");
  });
});

// ---------- memory-specific ----------

test("memory: listRuns returns clones (mutating a copy doesn't leak back)", async () => {
  const store = new MemoryObservabilityStore();
  await store.appendRun(run("clone", { name: "orig" }));
  const rows = await store.listRuns({});
  rows[0].name = "mutated";
  const reread = await store.listRuns({});
  assert.equal(reread[0].name, "orig");
});

test("memory: withMaxRuns evicts oldest-appended runs", async () => {
  const store = new MemoryObservabilityStore().withMaxRuns(2);
  await store.appendRun(run("a", { startedAt: "2026-01-01T00:00:00.000Z" }));
  await store.appendRun(run("b", { startedAt: "2026-01-02T00:00:00.000Z" }));
  await store.appendRun(run("c", { startedAt: "2026-01-03T00:00:00.000Z" }));
  const ids = (await store.listRuns({})).map((r) => r.id).sort();
  assert.deepEqual(ids, ["b", "c"], "oldest-appended 'a' evicted");
});

test("memory: withMaxRuns(0) keeps the just-written run (no total wipe)", async () => {
  // Regression guard for #322 — `0` must not evict every run.
  const store = new MemoryObservabilityStore().withMaxRuns(0);
  await store.appendRun(run("a"));
  await store.appendRun(run("b"));
  const rows = await store.listRuns({});
  assert.equal(rows.length, 1, "clamped to a floor of 1, not wiped to empty");
  assert.equal(rows[0].id, "b", "newest run retained");
});
