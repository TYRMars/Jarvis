import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { newProject, type Project, type ProjectStore } from "@jarvis/project";
import { JsonFileProjectStore, MemoryProjectStore } from "./project-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-project-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function project(slug: string, name = slug): Project {
  const p = newProject(name, "instructions");
  p.slug = slug;
  return p;
}

// Stagger `updated_at` so newest-first ordering is observable (ISO strings
// sort lexicographically).
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function contract(name: string, make: (dir: string) => Promise<ProjectStore>): void {
  test(`${name}: save/load round-trips; missing → undefined`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = project("alpha");
      await store.save(p);
      const loaded = await store.load(p.id);
      assert.equal(loaded?.id, p.id);
      assert.equal(loaded?.slug, "alpha");
      assert.equal(await store.load("missing"), undefined);
    });
  });

  test(`${name}: findBySlug resolves the row, undefined when absent`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = project("beta");
      await store.save(p);
      assert.equal((await store.findBySlug("beta"))?.id, p.id);
      assert.equal(await store.findBySlug("nope"), undefined);
    });
  });

  test(`${name}: save rejects a duplicate slug owned by a different id`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      await store.save(project("dup"));
      await assert.rejects(() => store.save(project("dup")), /already in use/);
    });
  });

  test(`${name}: re-saving the SAME id with its slug is allowed`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = project("same");
      await store.save(p);
      p.name = "renamed";
      await store.save(p); // same id + slug → no collision
      assert.equal((await store.load(p.id))?.name, "renamed");
    });
  });

  test(`${name}: list is newest-updated first and respects limit`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a = project("a");
      await store.save(a);
      await tick();
      const b = project("b");
      await store.save(b);
      await tick();
      const c = project("c");
      await store.save(c);
      const rows = await store.list(false, 2);
      assert.deepEqual(rows.map((r) => r.slug), ["c", "b"]);
    });
  });

  test(`${name}: archive is a soft-delete; hidden by default, shown when asked; idempotent`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = project("arch");
      await store.save(p);
      assert.equal(await store.archive(p.id), true);
      assert.equal((await store.list(false, 10)).length, 0, "archived hidden by default");
      assert.equal((await store.list(true, 10)).length, 1, "shown with includeArchived");
      assert.equal((await store.load(p.id))?.archived, true);
      assert.equal(await store.archive(p.id), true, "archiving an archived row is idempotent-true");
      assert.equal(await store.archive("missing"), false);
    });
  });

  test(`${name}: delete is a hard remove; second delete is false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = project("del");
      await store.save(p);
      assert.equal(await store.delete(p.id), true);
      assert.equal(await store.load(p.id), undefined);
      assert.equal(await store.delete(p.id), false);
    });
  });
}

contract("json-file", (dir) => JsonFileProjectStore.open(dir));
contract("memory", () => Promise.resolve(new MemoryProjectStore()));

// ---------- JSON-file-specific ----------

test("json-file: projects land under <base>/projects/<id>.json", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileProjectStore.open(dir);
    const p = project("layout");
    await store.save(p);
    const files = await readdir(path.join(dir, "projects"));
    assert.ok(files.includes(`${p.id}.json`));
  });
});

test("memory: returned rows are clones (mutating a copy doesn't leak back)", async () => {
  const store = new MemoryProjectStore();
  const p = project("clone");
  await store.save(p);
  const loaded = await store.load(p.id);
  loaded!.name = "mutated";
  assert.equal((await store.load(p.id))?.name, p.name);
});
