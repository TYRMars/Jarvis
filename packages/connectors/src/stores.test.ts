// Connector store + value-type tests. Deterministic, temp-dir backed, no
// network. Mirrors the Rust unit tests in connectors_stores.rs plus the
// value-type round trips from lib.rs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JsonFileConnectorAccountStore,
  JsonFileProjectBindingStore,
  JsonFileRequirementBindingStore,
  MemoryConnectorAccountStore,
  MemoryProjectBindingStore,
  MemoryRequirementBindingStore,
  newConnectorAccount,
  newProjectBinding,
  newRequirementBinding,
  type RequirementPush,
} from "./index.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-connectors-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- value-type constructors ----------

test("newConnectorAccount: auth_ref is a name, not a token; serialises it", () => {
  const a = newConnectorAccount("github", "personal", "GITHUB_TOKEN");
  assert.equal(a.connector, "github");
  assert.equal(a.auth_ref, "GITHUB_TOKEN");
  assert.match(JSON.stringify(a), /GITHUB_TOKEN/);
  assert.equal(a.created_at, a.updated_at);
});

test("RequirementPush wire shape round-trips", () => {
  const full = JSON.parse(`{"action":"close","comment":"done"}`) as RequirementPush;
  assert.equal(full.action, "close");
  assert.equal(full.comment, "done");
  const empty = JSON.parse("{}") as RequirementPush;
  assert.equal(empty.action, undefined);
  assert.equal(empty.comment, undefined);
});

// ---------- memory backends ----------

test("memory requirement-binding lookups + conflict-baseline update", async () => {
  const store = new MemoryRequirementBindingStore();
  const b = newRequirementBinding("github", "pb-1", "req-1", "42");
  await store.upsert(b);

  assert.ok(await store.findByRemote("pb-1", "42"));
  assert.equal(await store.findByRemote("pb-1", "43"), undefined);
  assert.ok(await store.findByRequirement("req-1"));

  b.remote_updated_at = "2026-06-10T00:00:00Z";
  await store.upsert(b);
  const got = await store.get(b.id);
  assert.equal(got?.remote_updated_at, "2026-06-10T00:00:00Z");

  assert.equal(await store.delete(b.id), true);
  assert.equal(await store.delete(b.id), false);
});

test("memory account + project-binding stores filter and sort", async () => {
  const accounts = new MemoryConnectorAccountStore();
  const a1 = { ...newConnectorAccount("github", "first", "T1"), created_at: "2026-01-01T00:00:00Z" };
  const a2 = {
    ...newConnectorAccount("github", "second", "T2"),
    created_at: "2026-01-02T00:00:00Z",
  };
  await accounts.upsert(a2);
  await accounts.upsert(a1);
  const list = await accounts.list();
  assert.deepEqual(
    list.map((a) => a.display_name),
    ["first", "second"],
    "ascending by created_at",
  );

  const bindings = new MemoryProjectBindingStore();
  await bindings.upsert(newProjectBinding("github", a1.id, "proj-1", "tyrmars/jarvis"));
  await bindings.upsert(newProjectBinding("github", a1.id, "proj-2", "tyrmars/other"));
  assert.equal((await bindings.list("proj-1")).length, 1);
  assert.equal((await bindings.list()).length, 2, "no filter lists everything");
  assert.equal((await bindings.list("nope")).length, 0);
});

test("memory store returns clones (no aliasing of internal rows)", async () => {
  const store = new MemoryRequirementBindingStore();
  const b = newRequirementBinding("github", "pb-1", "req-1", "42");
  await store.upsert(b);
  const got = await store.get(b.id);
  assert.ok(got);
  got.remote_task_id = "mutated";
  const again = await store.get(b.id);
  assert.equal(again?.remote_task_id, "42", "mutating a returned row must not affect the store");
});

// ---------- JSON-file backends ----------

test("json-file stores round-trip across the three kinds", async () => {
  await withTempDir(async (dir) => {
    const accounts = await JsonFileConnectorAccountStore.open(dir);
    const a = newConnectorAccount("github", "personal", "GITHUB_TOKEN");
    await accounts.upsert(a);
    assert.equal((await accounts.list()).length, 1);
    assert.equal((await accounts.get(a.id))?.auth_ref, "GITHUB_TOKEN");

    const bindings = await JsonFileProjectBindingStore.open(dir);
    const pb = newProjectBinding("github", a.id, "proj-1", "tyrmars/jarvis");
    await bindings.upsert(pb);
    assert.equal((await bindings.list("proj-1")).length, 1);
    assert.equal((await bindings.list("other")).length, 0);

    const reqs = await JsonFileRequirementBindingStore.open(dir);
    const rb = newRequirementBinding("github", pb.id, "req-1", "7");
    await reqs.upsert(rb);
    assert.ok(await reqs.findByRemote(pb.id, "7"));
    assert.ok(await reqs.findByRequirement("req-1"));
    assert.equal((await reqs.listForProjectBinding(pb.id)).length, 1);
    assert.equal(await reqs.delete(rb.id), true);
    assert.equal(await reqs.findByRemote(pb.id, "7"), undefined);
  });
});

test("json-file backend survives a reopen (atomic writes persist)", async () => {
  await withTempDir(async (dir) => {
    const first = await JsonFileConnectorAccountStore.open(dir);
    const a = newConnectorAccount("github", "persisted", "GITHUB_TOKEN");
    await first.upsert(a);

    const reopened = await JsonFileConnectorAccountStore.open(dir);
    const got = await reopened.get(a.id);
    assert.equal(got?.display_name, "persisted");
  });
});

test("json-file delete of an absent id is a graceful false", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileRequirementBindingStore.open(dir);
    assert.equal(await store.delete("does-not-exist"), false);
  });
});
