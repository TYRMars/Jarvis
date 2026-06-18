import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  newDocDraft,
  newDocProject,
  type DocEvent,
  type DocStore,
} from "@jarvis/project";
import { JsonFileDocStore, MemoryDocStore } from "./doc-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-doc-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Stagger `updated_at` so RFC-3339 strings sort deterministically. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

// A shared contract both backends must satisfy.
export function contractTests(name: string, make: (dir: string) => Promise<DocStore>): void {
  test(`${name}: project upsert/get round-trips`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = newDocProject("/repo", "weekly review");
      p.kind = "report";
      await store.upsertProject(p);
      const got = await store.getProject(p.id);
      assert.deepEqual(got, p);
      assert.equal(await store.getProject("missing"), undefined);
    });
  });

  test(`${name}: listProjects scopes by workspace, newest-first`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const a1 = newDocProject("/r-a", "alpha-1");
      await store.upsertProject(a1);
      await tick();
      const a2 = newDocProject("/r-a", "alpha-2");
      await store.upsertProject(a2);
      await tick();
      const b1 = newDocProject("/r-b", "beta-1");
      await store.upsertProject(b1);

      const rowsA = await store.listProjects("/r-a");
      assert.deepEqual(rowsA.map((p) => p.id), [a2.id, a1.id]);
      const rowsB = await store.listProjects("/r-b");
      assert.deepEqual(rowsB.map((p) => p.id), [b1.id]);
      assert.deepEqual(await store.listProjects("/nowhere"), []);
    });
  });

  test(`${name}: drafts list newest-first + latestDraft head`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = newDocProject("/r", "doc");
      await store.upsertProject(p);
      const d1 = newDocDraft(p.id, "v1");
      await store.upsertDraft(d1);
      await tick();
      const d2 = newDocDraft(p.id, "v2");
      await store.upsertDraft(d2);

      const drafts = await store.listDrafts(p.id);
      assert.deepEqual(drafts.map((d) => d.id), [d2.id, d1.id]);
      const latest = await store.latestDraft(p.id);
      assert.equal(latest?.id, d2.id);
      assert.equal(latest?.content, "v2");
      assert.equal(await store.latestDraft("no-such-project"), undefined);
    });
  });

  test(`${name}: draft upsert overwrites by id`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = newDocProject("/r", "doc");
      await store.upsertProject(p);
      const d = newDocDraft(p.id, "first");
      await store.upsertDraft(d);
      d.content = "second";
      await store.upsertDraft(d);
      const drafts = await store.listDrafts(p.id);
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]?.content, "second");
    });
  });

  test(`${name}: deleteProject cascades drafts + returns true/false`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const p = newDocProject("/r", "doc");
      await store.upsertProject(p);
      await store.upsertDraft(newDocDraft(p.id, "a"));
      await store.upsertDraft(newDocDraft(p.id, "b"));

      assert.equal(await store.deleteProject(p.id), true);
      assert.equal(await store.getProject(p.id), undefined);
      assert.deepEqual(await store.listDrafts(p.id), []);
      // Idempotent: already gone.
      assert.equal(await store.deleteProject(p.id), false);
    });
  });

  test(`${name}: subscribe sees project + draft mutations`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const events: DocEvent[] = [];
      const off = store.subscribe((e) => events.push(e));

      const p = newDocProject("/r", "doc");
      await store.upsertProject(p);
      const d = newDocDraft(p.id, "body");
      await store.upsertDraft(d);
      await store.deleteProject(p.id);

      off();
      // Mutation after unsubscribe must not be delivered.
      await store.upsertProject(newDocProject("/r", "after"));

      assert.deepEqual(events.map((e) => e.type), [
        "project_upserted",
        "draft_upserted",
        "project_deleted",
      ]);
      const upserted = events[0];
      assert.equal(upserted?.type, "project_upserted");
      if (upserted?.type === "project_upserted") assert.equal(upserted.id, p.id);
      const deleted = events[2];
      assert.equal(deleted?.type, "project_deleted");
      if (deleted?.type === "project_deleted") {
        assert.equal(deleted.workspace, "/r");
        assert.equal(deleted.id, p.id);
      }
    });
  });

  test(`${name}: deleteProject on absent emits no event`, async () => {
    await withTempDir(async (dir) => {
      const store = await make(dir);
      const events: DocEvent[] = [];
      store.subscribe((e) => events.push(e));
      assert.equal(await store.deleteProject("ghost"), false);
      assert.deepEqual(events, []);
    });
  });
}

contractTests("json-file", (dir) => JsonFileDocStore.open(dir));
contractTests("memory", () => Promise.resolve(new MemoryDocStore()));

// ---------- JSON-file-specific ----------

test("json-file: drafts nest under per-project subdir", async () => {
  await withTempDir(async (dir) => {
    const store = await JsonFileDocStore.open(dir);
    const p = newDocProject("/r", "doc");
    await store.upsertProject(p);
    await store.upsertDraft(newDocDraft(p.id, "body"));

    const projectFiles = await readdir(path.join(dir, "docs", "projects"));
    assert.ok(projectFiles.includes(`${p.id}.json`));
    const draftFiles = await readdir(path.join(dir, "docs", "drafts", p.id));
    assert.equal(draftFiles.length, 1);
  });
});

test("json-file: survives reopen (durable)", async () => {
  await withTempDir(async (dir) => {
    const s1 = await JsonFileDocStore.open(dir);
    const p = newDocProject("/r", "persisted");
    await s1.upsertProject(p);
    await s1.upsertDraft(newDocDraft(p.id, "x"));

    const s2 = await JsonFileDocStore.open(dir);
    assert.equal((await s2.getProject(p.id))?.title, "persisted");
    assert.equal((await s2.listDrafts(p.id)).length, 1);
  });
});
