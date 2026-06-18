import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  EvalBaseline,
  EvalCaseResult,
  EvalStore,
  EvalSuiteKind,
  EvalSuiteRun,
  ObservedOutcome,
} from "./index.ts";
import { JsonFileEvalStore, MemoryEvalStore } from "./index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-eval-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function suiteRun(id: string): EvalSuiteRun {
  return {
    id,
    suite: "core",
    suite_kind: "capability",
    started_at: "2026-01-01T00:00:00.000Z",
    outcome: "success",
    attributes: null,
  };
}

function caseResult(
  id: string,
  opts: {
    suite?: string;
    suiteKind?: EvalSuiteKind;
    caseId?: string;
    outcome?: ObservedOutcome;
  } = {},
): EvalCaseResult {
  return {
    id,
    suite_run_id: "sr1",
    case_id: opts.caseId ?? "case-x",
    suite: opts.suite ?? "core",
    suite_kind: opts.suiteKind ?? "capability",
    scenario: "scenario",
    trial_index: 0,
    outcome: opts.outcome ?? "success",
    scores: null,
    attributes: null,
  };
}

function baseline(id: string): EvalBaseline {
  return {
    id,
    suite: "core",
    suite_kind: "capability",
    created_at: "2026-01-01T00:00:00.000Z",
    summary: null,
    cases: null,
  };
}

function contract(name: string, make: (dir: string) => Promise<EvalStore>): void {
  test(`${name}: saveBaseline / loadBaseline round-trips; missing → undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const b = baseline("b1");
      await store.saveBaseline(b);
      const loaded = await store.loadBaseline("b1");
      assert.equal(loaded?.id, "b1");
      assert.equal(loaded?.summary, null);
      assert.equal(loaded?.cases, null);
      assert.equal(await store.loadBaseline("missing"), undefined);
    });
  });

  test(`${name}: saveSuiteRun + saveCaseResult persist (case visible via list)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveSuiteRun(suiteRun("sr1"));
      await store.saveCaseResult(caseResult("c1"));
      const rows = await store.listCaseResults({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, "c1");
      assert.equal(rows[0].trial_index, 0);
      assert.equal(rows[0].grader_results, undefined);
    });
  });

  test(`${name}: listCaseResults sorts by id descending and respects limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveCaseResult(caseResult("c1"));
      await store.saveCaseResult(caseResult("c2"));
      await store.saveCaseResult(caseResult("c3"));
      const all = await store.listCaseResults({});
      assert.deepEqual(all.map((r) => r.id), ["c3", "c2", "c1"]);
      const capped = await store.listCaseResults({ limit: 2 });
      assert.deepEqual(capped.map((r) => r.id), ["c3", "c2"]);
    });
  });

  test(`${name}: listCaseResults filters by suite / suite_kind / case_id / outcome`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveCaseResult(caseResult("c1", { suite: "core", caseId: "k1", outcome: "success" }));
      await store.saveCaseResult(
        caseResult("c2", { suite: "ext", suiteKind: "regression", caseId: "k2", outcome: "error" }),
      );
      await store.saveCaseResult(caseResult("c3", { suite: "core", caseId: "k1", outcome: "error" }));

      assert.deepEqual((await store.listCaseResults({ suite: "ext" })).map((r) => r.id), ["c2"]);
      assert.deepEqual((await store.listCaseResults({ suite_kind: "regression" })).map((r) => r.id), ["c2"]);
      assert.deepEqual(
        (await store.listCaseResults({ case_id: "k1" })).map((r) => r.id),
        ["c3", "c1"],
      );
      assert.deepEqual(
        (await store.listCaseResults({ outcome: "error" })).map((r) => r.id),
        ["c3", "c2"],
      );
      // Compound.
      assert.deepEqual(
        (await store.listCaseResults({ suite: "core", outcome: "error" })).map((r) => r.id),
        ["c3"],
      );
    });
  });

  test(`${name}: save* overwrites by id (last write wins)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.saveCaseResult(caseResult("dup", { suite: "first" }));
      await store.saveCaseResult(caseResult("dup", { suite: "second" }));
      const rows = await store.listCaseResults({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].suite, "second");

      const b = baseline("bdup");
      b.git_ref = "v1";
      await store.saveBaseline(b);
      b.git_ref = "v2";
      await store.saveBaseline(b);
      assert.equal((await store.loadBaseline("bdup"))?.git_ref, "v2");
    });
  });
}

contract("json-file", (dir) => JsonFileEvalStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryEvalStore()));

// ---------- JSON-file-specific ----------

test("json-file: rows land under suites/ cases/ baselines/", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileEvalStore.open(dir);
    await store.saveSuiteRun(suiteRun("sr1"));
    await store.saveCaseResult(caseResult("c1"));
    await store.saveBaseline(baseline("b1"));
    assert.ok((await readdir(path.join(dir, "suites"))).includes("sr1.json"));
    assert.ok((await readdir(path.join(dir, "cases"))).includes("c1.json"));
    assert.ok((await readdir(path.join(dir, "baselines"))).includes("b1.json"));
  });
});

// ---------- memory-specific ----------

test("memory: loadBaseline + listCaseResults return clones", async () => {
  const store = new MemoryEvalStore();
  await store.saveBaseline(baseline("b1"));
  const loaded = await store.loadBaseline("b1");
  loaded!.suite = "mutated";
  assert.equal((await store.loadBaseline("b1"))?.suite, "core");

  await store.saveCaseResult(caseResult("c1", { suite: "orig" }));
  const rows = await store.listCaseResults({});
  rows[0].suite = "mutated";
  assert.equal((await store.listCaseResults({}))[0].suite, "orig");
});
