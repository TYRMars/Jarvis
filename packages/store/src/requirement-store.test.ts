import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  newRequirement,
  type Requirement,
  type RequirementEvent,
  type RequirementStore,
  type TriageState,
} from "@jarvis/project";
import { JsonFileRequirementStore, MemoryRequirementStore } from "./requirement-store.ts";
import type { SqliteRequirementStore } from "./sqlite.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-requirement-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function requirement(projectId: string, title: string, triage?: TriageState): Requirement {
  const r = newRequirement(projectId, title);
  if (triage !== undefined) r.triage_state = triage;
  return r;
}

// Both backends are exercised through this shared contract. The two extra
// methods we test below (`subscribe`, `listByTriageState`) are present on both
// concrete classes even though only `subscribe` is on the trait, so the
// contract is typed against the concrete union.
type Backend = JsonFileRequirementStore | MemoryRequirementStore | SqliteRequirementStore;

export function contract(name: string, make: (dir: string) => Promise<Backend>): void {
  test(`${name}: upsert/get round-trips; missing → undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r = requirement("p1", "do a thing");
      await store.upsert(r);
      assert.equal((await store.get(r.id))?.title, "do a thing");
      assert.equal(await store.get("missing"), undefined);
    });
  });

  test(`${name}: list scopes to a project, newest-updated first`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = requirement("p1", "a");
      await store.upsert(a);
      await tick();
      const b = requirement("p1", "b");
      await store.upsert(b);
      await tick();
      const other = requirement("p2", "other");
      await store.upsert(other);
      const rows = await store.list("p1");
      assert.deepEqual(rows.map((r) => r.title), ["b", "a"], "newest-first, scoped to p1");
      assert.deepEqual((await store.list("p2")).map((r) => r.title), ["other"]);
      assert.deepEqual(await store.list("empty"), []);
    });
  });

  test(`${name}: listByTriageState filters; missing field counts as approved`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const approved = requirement("p1", "approved-explicit", "approved");
      const proposed = requirement("p1", "proposed", "proposed_by_agent");
      const legacy = requirement("p1", "legacy"); // newRequirement seeds "approved"
      delete legacy.triage_state; // simulate an older row with the field absent
      await store.upsert(approved);
      await store.upsert(proposed);
      await store.upsert(legacy);
      const approvedRows = await store.listByTriageState("p1", "approved");
      assert.deepEqual(
        approvedRows.map((r) => r.title).sort(),
        ["approved-explicit", "legacy"],
        "explicit + legacy(default) approved",
      );
      const proposedRows = await store.listByTriageState("p1", "proposed_by_agent");
      assert.deepEqual(proposedRows.map((r) => r.title), ["proposed"]);
      assert.deepEqual(await store.listByTriageState("p1", "proposed_by_scan"), []);
    });
  });

  test(`${name}: upsert overwrites in place (no duplicate row)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r = requirement("p1", "v1");
      await store.upsert(r);
      r.title = "v2";
      await store.upsert(r);
      const rows = await store.list("p1");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.title, "v2");
    });
  });

  test(`${name}: subscribe sees upserted + deleted; deleted only on the true path`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementEvent[] = [];
      const off = store.subscribe((ev) => seen.push(ev));
      const r = requirement("p1", "x");
      await store.upsert(r);
      assert.equal(await store.delete("never-existed"), false);
      assert.equal(await store.delete(r.id), true);
      assert.deepEqual(seen.map((e) => e.type), ["upserted", "deleted"], "no event for a no-op delete");
      // The deleted frame carries project_id + id.
      const del = seen[1];
      assert.equal(del.type === "deleted" && del.project_id, "p1");
      off();
      await store.upsert(requirement("p1", "after-off"));
      assert.equal(seen.length, 2, "unsubscribed listener stops receiving");
    });
  });

  test(`${name}: a throwing listener is isolated — mutation still resolves, later listeners still fire`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementEvent[] = [];
      // A listener registered *before* the good one throws on every event.
      store.subscribe(() => {
        throw new Error("subscriber boom");
      });
      store.subscribe((ev) => seen.push(ev));
      // The mutation must resolve (not reject) despite the throwing subscriber,
      // and the later-registered listener must still receive the event — the
      // fault must not propagate out of the already-committed write.
      await store.upsert(requirement("p1", "isolated"));
      assert.equal(seen.length, 1, "listener after the throwing one still fires");
      assert.equal(seen[0]?.type, "upserted");
    });
  });

  test(`${name}: upserted broadcast carries the WIRE shape (no skip/default fields)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: RequirementEvent[] = [];
      store.subscribe((ev) => seen.push(ev));
      const r = requirement("p1", "x"); // triage defaults to "approved"
      r.assignee_id = "someone";
      r.acceptance_policy = "human";
      await store.upsert(r);
      const json = JSON.stringify(seen[0]);
      assert.ok(!json.includes("assignee_id"), "skip field leaked into broadcast");
      assert.ok(!json.includes("acceptance_policy"), "skip field leaked into broadcast");
      assert.ok(!json.includes("triage_state"), "default triage_state leaked into broadcast");
    });
  });

  test(`${name}: delete is hard (get returns undefined afterwards)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const r = requirement("p1", "gone");
      await store.upsert(r);
      assert.equal(await store.delete(r.id), true);
      assert.equal(await store.get(r.id), undefined);
      assert.deepEqual(await store.list("p1"), []);
    });
  });
}

contract("json-file", (dir) => JsonFileRequirementStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryRequirementStore()));

// A RequirementStore is usable through the bare trait surface.
test("RequirementStore trait surface compiles for both backends", async () => {
  const mem: RequirementStore = new MemoryRequirementStore();
  const r = newRequirement("p1", "trait");
  await mem.upsert(r);
  assert.equal((await mem.get(r.id))?.title, "trait");
});
