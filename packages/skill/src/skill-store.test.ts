import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SkillActivationEvent, SkillStore } from "./store.ts";
import { JsonFileSkillStore, MemorySkillStore } from "./skill-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-skillstore-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function contract(name: string, make: (dir: string) => Promise<SkillStore>): void {
  test(`${name}: activate creates a record; activeNames + get reflect it`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.deepEqual(await store.activeNames("s1"), []);
      assert.equal(await store.get("s1"), undefined);

      assert.equal(await store.activate("s1", "code-review"), true);
      assert.deepEqual(await store.activeNames("s1"), ["code-review"]);
      const rec = await store.get("s1");
      assert.equal(rec?.scope, "s1");
      assert.deepEqual(rec?.names, ["code-review"]);
      assert.ok(rec?.created_at);
      assert.ok(rec?.updated_at);
    });
  });

  test(`${name}: activate is idempotent (false when already on, names sorted+deduped)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      assert.equal(await store.activate("s1", "zeta"), true);
      assert.equal(await store.activate("s1", "alpha"), true);
      assert.equal(await store.activate("s1", "zeta"), false); // already on → no change
      assert.deepEqual(await store.activeNames("s1"), ["alpha", "zeta"]); // sorted
    });
  });

  test(`${name}: deactivate removes a name; false when not active`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.activate("s1", "a");
      await store.activate("s1", "b");
      assert.equal(await store.deactivate("s1", "a"), true);
      assert.deepEqual(await store.activeNames("s1"), ["b"]);
      assert.equal(await store.deactivate("s1", "a"), false); // already gone
      assert.equal(await store.deactivate("ghost", "a"), false); // unknown scope
    });
  });

  test(`${name}: deactivating the last name leaves an empty record; clear removes it`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.activate("s1", "only");
      assert.equal(await store.deactivate("s1", "only"), true);
      assert.deepEqual(await store.activeNames("s1"), []);
      // Empty record still present.
      assert.deepEqual((await store.get("s1"))?.names, []);
      assert.equal(await store.clear("s1"), true);
      assert.equal(await store.get("s1"), undefined);
      assert.equal(await store.clear("s1"), false); // idempotent
    });
  });

  test(`${name}: scopes are isolated`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.activate("s1", "x");
      await store.activate("s2", "y");
      assert.deepEqual(await store.activeNames("s1"), ["x"]);
      assert.deepEqual(await store.activeNames("s2"), ["y"]);
    });
  });

  test(`${name}: list returns every scope newest-updated first, capped at limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      // Stagger updated_at so the lexicographic RFC-3339 sort is meaningful.
      await store.activate("first", "a");
      await new Promise((r) => setTimeout(r, 5));
      await store.activate("second", "b");
      await new Promise((r) => setTimeout(r, 5));
      await store.activate("third", "c");

      const all = await store.list(100);
      assert.deepEqual(all.map((r) => r.scope), ["third", "second", "first"]);
      assert.deepEqual((await store.list(2)).map((r) => r.scope), ["third", "second"]);
    });
  });

  test(`${name}: list reflects an updated_at bump on re-activation`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.activate("a", "x");
      await new Promise((r) => setTimeout(r, 5));
      await store.activate("b", "y");
      // Touch `a` again → it should jump to the front.
      await new Promise((r) => setTimeout(r, 5));
      await store.activate("a", "z");
      assert.deepEqual((await store.list(10)).map((r) => r.scope), ["a", "b"]);
    });
  });

  test(`${name}: events fire on real changes only`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: SkillActivationEvent[] = [];
      const off = store.subscribe((e) => seen.push(e));

      await store.activate("s1", "x"); // activated
      await store.activate("s1", "x"); // no-op → no event
      await store.deactivate("s1", "x"); // deactivated
      await store.deactivate("s1", "x"); // no-op → no event
      await store.activate("s1", "y"); // activated
      await store.clear("s1"); // cleared
      await store.clear("s1"); // no-op → no event

      assert.deepEqual(seen, [
        { type: "activated", scope: "s1", name: "x" },
        { type: "deactivated", scope: "s1", name: "x" },
        { type: "activated", scope: "s1", name: "y" },
        { type: "cleared", scope: "s1" },
      ]);

      off();
      await store.activate("s1", "z");
      assert.equal(seen.length, 4, "no events after unsubscribe");
    });
  });

  test(`${name}: a returned record is a copy (mutating it doesn't reach the store)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.activate("s1", "x");
      const rec = await store.get("s1");
      rec?.names.push("injected");
      assert.deepEqual(await store.activeNames("s1"), ["x"]);
    });
  });
}

contract("json-file", (dir) => JsonFileSkillStore.open(dir));
contract("memory", () => Promise.resolve(new MemorySkillStore()));

// JSON-file persistence across reopen.
test("json-file: state survives a reopen", async () => {
  await withTempDir(async (dir) => {
    const a = await JsonFileSkillStore.open(dir);
    await a.activate("s1", "code-review");
    await a.activate("s1", "doc");
    const b = await JsonFileSkillStore.open(dir);
    assert.deepEqual(await b.activeNames("s1"), ["code-review", "doc"]);
  });
});

// `:`-bearing scope keys (e.g. namespaced ids) survive the filename encode.
test("json-file: a scope key with reserved chars round-trips", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileSkillStore.open(dir);
    const scope = "session:abc/def";
    await store.activate(scope, "x");
    const reopened = await JsonFileSkillStore.open(dir);
    assert.deepEqual(await reopened.activeNames(scope), ["x"]);
  });
});
