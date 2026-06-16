import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newLabel, touchLabel, type Label, type LabelEvent, type LabelStore } from "@jarvis/project";
import { JsonFileLabelStore, MemoryLabelStore } from "./label-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-label-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function label(projectId: string, name: string, colour = "#aabbcc"): Label {
  return newLabel(projectId, name, colour);
}

export function contract(name: string, make: (dir: string) => Promise<LabelStore>): void {
  test(`${name}: create then list-for-project, sorted case-insensitively by name`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.create(label("p1", "Zebra"));
      await store.create(label("p1", "apple"));
      await store.create(label("p1", "Mango"));
      const rows = await store.listForProject("p1");
      assert.deepEqual(rows.map((r) => r.name), ["apple", "Mango", "Zebra"]);
      assert.deepEqual(await store.listForProject("other"), []);
    });
  });

  test(`${name}: labels are scoped per project`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.create(label("p1", "shared"));
      await store.create(label("p2", "shared")); // same name, different project → OK
      assert.equal((await store.listForProject("p1")).length, 1);
      assert.equal((await store.listForProject("p2")).length, 1);
    });
  });

  test(`${name}: create rejects a case-insensitive duplicate name in the same project`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.create(label("p1", "Bug"));
      await assert.rejects(() => store.create(label("p1", "BUG")), /already exists in project/);
    });
  });

  test(`${name}: create broadcasts "created"`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const seen: LabelEvent[] = [];
      store.subscribe((e) => seen.push(e));
      const l = label("p1", "Feature");
      await store.create(l);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.type, "created");
      assert.equal((seen[0] as Label).id, l.id);
    });
  });

  test(`${name}: get walks projects; undefined when absent`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const l = label("p2", "Findable");
      await store.create(l);
      assert.equal((await store.get(l.id))?.name, "Findable");
      assert.equal(await store.get("ghost"), undefined);
    });
  });

  test(`${name}: update mutates name/colour/description, pins id+project+created_at; absent → false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const l = label("p1", "Old", "#111111");
      await store.create(l);
      const seen: LabelEvent[] = [];
      store.subscribe((e) => seen.push(e));
      const patch: Label = { ...l, name: "New", colour: "#222222", description: "desc" };
      touchLabel(patch);
      assert.equal(await store.update(patch), true);
      const got = await store.get(l.id);
      assert.equal(got?.name, "New");
      assert.equal(got?.colour, "#222222");
      assert.equal(got?.description, "desc");
      assert.equal(got?.created_at, l.created_at);
      assert.equal(seen.at(-1)?.type, "updated");

      const missing = label("p1", "Nope");
      assert.equal(await store.update(missing), false);
    });
  });

  test(`${name}: update with a mismatched project_id is a no-op (false, row untouched)`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const l = label("p1", "Keep", "#111111");
      await store.create(l);
      // Right id, wrong project_id — the store keys on (id, project_id), so this
      // must resolve to false and leave the row's name/colour intact.
      const patch: Label = { ...l, project_id: "WRONG", name: "Renamed", colour: "#222222" };
      assert.equal(await store.update(patch), false);
      const got = await store.get(l.id);
      assert.equal(got?.name, "Keep", "name must not change on a mismatched-project update");
      assert.equal(got?.colour, "#111111");
    });
  });

  test(`${name}: update rejects a name colliding with a different label`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = label("p1", "Alpha");
      const b = label("p1", "Beta");
      await store.create(a);
      await store.create(b);
      const patch: Label = { ...b, name: "ALPHA" };
      await assert.rejects(() => store.update(patch), /already exists in project/);
      // Renaming to its own current name (case change of itself) is fine.
      const selfPatch: Label = { ...a, name: "ALPHA" };
      assert.equal(await store.update(selfPatch), true);
    });
  });

  test(`${name}: delete removes the row and broadcasts; idempotent false after`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const l = label("p1", "Temp");
      await store.create(l);
      const seen: LabelEvent[] = [];
      store.subscribe((e) => seen.push(e));
      assert.equal(await store.delete("p1", l.id), true);
      assert.equal(await store.get(l.id), undefined);
      assert.equal(seen.at(-1)?.type, "deleted");
      assert.equal(await store.delete("p1", l.id), false);
    });
  });
}

contract("json-file", (dir) => JsonFileLabelStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryLabelStore()));
