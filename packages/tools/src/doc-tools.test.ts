// Unit tests for the `doc.*` tool family. Ported from the
// `#[cfg(test)] mod tests` block in crates/harness-tools/src/doc.rs.
//
// Uses MemoryDocStore from @jarvis/store as the fixture (the Rust tests use a
// hand-rolled in-memory DocStore; the Node port reuses the shared backend).
// Where draft ordering matters (`latestDraft` is sorted by `updated_at`
// descending, and millisecond-resolution timestamps can tie), the tests
// insert a small sleep between saves to keep the newest-wins assertion
// deterministic — mirroring the Rust `draft_save_bumps_parent` test which
// also sleeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { JsonValue, Tool } from "@jarvis/core";
import { toolRequiresApproval } from "@jarvis/core";
import type { DocStore } from "@jarvis/project";
import { MemoryDocStore } from "@jarvis/store";

import {
  DocCreateTool,
  DocDeleteTool,
  DocDraftGetTool,
  DocDraftSaveTool,
  DocGetTool,
  DocListTool,
  DocSearchTool,
  DocUpdateTool,
  DocUpsertTool,
} from "./doc-tools.ts";

// ---------- fixtures ----------

function store(): DocStore {
  return new MemoryDocStore();
}

/** Lexically-absolute default root, matching the Rust `std::env::temp_dir`. */
const ROOT = "/tmp";

function parse(out: string): { [k: string]: JsonValue } {
  return JSON.parse(out) as { [k: string]: JsonValue };
}

function idOf(out: string): string {
  const v = parse(out);
  const id = (v["id"] as string) ?? ((v["project"] as { id?: string } | undefined)?.id ?? "");
  return id;
}

// ---------- doc.create -----------------------------------------------------

test("create assigns default kind note", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const out = await create.invoke({ title: "weekly review", workspace: "/r" });
  const v = parse(out);
  assert.equal(v["kind"], "note");
  assert.equal(v["title"], "weekly review");
});

test("create rejects blank title", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  await assert.rejects(create.invoke({ title: "  ", workspace: "/r" }), /blank/);
});

test("create rejects unknown kind", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  await assert.rejects(create.invoke({ title: "x", kind: "blog", workspace: "/r" }), /unknown kind/);
});

// ---------- doc.list -------------------------------------------------------

test("list isolates by workspace", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const list = new DocListTool(s, ROOT);
  await create.invoke({ title: "alpha", workspace: "/a" });
  await create.invoke({ title: "beta", workspace: "/b" });

  const a = parse(await list.invoke({ workspace: "/a" }));
  assert.equal(a["count"], 1);
  assert.equal((a["items"] as { title: string }[])[0]?.title, "alpha");

  const b = parse(await list.invoke({ workspace: "/b" }));
  assert.equal(b["count"], 1);
});

test("list hides archived by default", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const update = new DocUpdateTool(s);
  const list = new DocListTool(s, ROOT);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  await update.invoke({ id, archived: true });

  const listed = parse(await list.invoke({ workspace: "/r" }));
  assert.equal(listed["count"], 0);

  const withArchived = parse(await list.invoke({ workspace: "/r", archived: true }));
  assert.equal(withArchived["count"], 1);
});

test("list pinned_only filters to pinned", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const list = new DocListTool(s, ROOT);
  await create.invoke({ title: "plain", workspace: "/r" });
  await create.invoke({ title: "fav", workspace: "/r", pinned: true });

  const pinned = parse(await list.invoke({ workspace: "/r", pinned_only: true }));
  assert.equal(pinned["count"], 1);
  assert.equal((pinned["items"] as { title: string }[])[0]?.title, "fav");
});

// ---------- doc.search -----------------------------------------------------

test("search matches title, tags, and latest content", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const update = new DocUpdateTool(s);
  const save = new DocDraftSaveTool(s);
  const search = new DocSearchTool(s, ROOT);
  const id = idOf(await create.invoke({ title: "季度复盘", workspace: "/r" }));
  await update.invoke({ id, tags: ["增长", "Q2"] });
  await save.invoke({ project_id: id, content: "本季度重点是自然语言 docs 工作流。" });

  const byTitle = parse(await search.invoke({ workspace: "/r", query: "复盘" }));
  assert.equal(byTitle["count"], 1);
  const item0 = (byTitle["items"] as { project: { id: string }; matched_fields: string[] }[])[0];
  assert.equal(item0?.project.id, id);
  assert.ok(item0?.matched_fields.includes("title"));

  const byContent = parse(await search.invoke({ workspace: "/r", query: "自然语言" }));
  assert.equal(byContent["count"], 1);
  const c0 = (byContent["items"] as { latest_draft: { snippet: string } }[])[0];
  assert.ok(c0?.latest_draft.snippet.includes("自然语言"));
});

test("search empty query returns recent docs with no matched fields excluded", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const search = new DocSearchTool(s, ROOT);
  await create.invoke({ title: "one", workspace: "/r" });
  await create.invoke({ title: "two", workspace: "/r" });

  const all = parse(await search.invoke({ workspace: "/r" }));
  assert.equal(all["count"], 2);
});

// ---------- doc.upsert -----------------------------------------------------

test("upsert creates and then updates by exact title", async () => {
  const s = store();
  const upsert = new DocUpsertTool(s, ROOT);
  const out1 = parse(
    await upsert.invoke({
      workspace: "/r",
      title: "Agent docs",
      kind: "guide",
      tags: ["docs", "docs", " agent "],
      content: "# v1",
    }),
  );
  assert.equal(out1["created"], true);
  const project1 = out1["project"] as { kind: string; tags: string[]; id: string };
  assert.equal(project1.kind, "guide");
  assert.deepEqual(project1.tags, ["docs", "agent"]);
  const id = project1.id;

  const out2 = parse(
    await upsert.invoke({
      workspace: "/r",
      title: "Agent docs",
      content: "# v2",
    }),
  );
  assert.equal(out2["created"], false);
  assert.equal((out2["project"] as { id: string }).id, id);
  assert.equal((out2["draft"] as { content: string }).content, "# v2");
  assert.equal((await s.listProjects("/r")).length, 1);
  assert.equal((await s.listDrafts(id)).length, 2);
});

test("upsert rejects ambiguous title matches", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const upsert = new DocUpsertTool(s, ROOT);
  await create.invoke({ title: "Same", workspace: "/r" });
  await create.invoke({ title: "Same", workspace: "/r" });

  await assert.rejects(
    upsert.invoke({ title: "Same", workspace: "/r", content: "x" }),
    /matched multiple docs/,
  );
});

test("upsert requires title when id absent", async () => {
  const s = store();
  const upsert = new DocUpsertTool(s, ROOT);
  await assert.rejects(upsert.invoke({ workspace: "/r", content: "x" }), /`title` is required/);
});

// ---------- doc.draft.save / doc.draft.get ---------------------------------

test("draft save appends a new revision", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const save = new DocDraftSaveTool(s);
  const get = new DocDraftGetTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  await save.invoke({ project_id: id, content: "v1" });
  await sleep(5);
  await save.invoke({ project_id: id, content: "v2" });

  const latest = parse(await get.invoke({ project_id: id }));
  assert.equal(latest["content"], "v2");

  const all = await s.listDrafts(id);
  assert.equal(all.length, 2, "save must append, not overwrite");
});

test("draft get returns null when no drafts", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const get = new DocDraftGetTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  const out = await get.invoke({ project_id: id });
  assert.equal(out, "null");
});

test("draft save bumps parent project updated_at", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const save = new DocDraftSaveTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  const before = (await s.getProject(id))?.updated_at ?? "";
  await sleep(5);
  await save.invoke({ project_id: id, content: "v1" });
  const after = (await s.getProject(id))?.updated_at ?? "";
  assert.ok(after > before);
});

test("draft save rejects orphan project_id", async () => {
  const s = store();
  const save = new DocDraftSaveTool(s);
  await assert.rejects(save.invoke({ project_id: "ghost", content: "x" }), /not found/);
});

test("draft save rejects oversize body", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const save = new DocDraftSaveTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  const big = "a".repeat(50 * 1024 + 1);
  await assert.rejects(save.invoke({ project_id: id, content: big }), /too large/);
});

// ---------- doc.delete -----------------------------------------------------

test("delete cascades drafts", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const save = new DocDraftSaveTool(s);
  const del = new DocDeleteTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  await save.invoke({ project_id: id, content: "v1" });
  const out = parse(await del.invoke({ id }));
  assert.equal(out["deleted"], true);

  assert.equal(await s.getProject(id), undefined);
  assert.equal((await s.listDrafts(id)).length, 0);
});

// ---------- doc.get --------------------------------------------------------

test("get with_draft includes latest", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const save = new DocDraftSaveTool(s);
  const get = new DocGetTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  await save.invoke({ project_id: id, content: "hello" });

  const withDraft = parse(await get.invoke({ id, with_draft: true }));
  assert.equal((withDraft["draft"] as { content: string }).content, "hello");
  assert.equal((withDraft["project"] as { title: string }).title, "x");

  const bare = parse(await get.invoke({ id }));
  assert.equal(bare["draft"], undefined);
});

test("get rejects missing id and unknown doc", async () => {
  const s = store();
  const get = new DocGetTool(s);
  await assert.rejects(get.invoke({}), /missing `id`/);
  await assert.rejects(get.invoke({ id: "ghost" }), /doc not found/);
});

// ---------- doc.update -----------------------------------------------------

test("update rejects blank title", async () => {
  const s = store();
  const create = new DocCreateTool(s, ROOT);
  const update = new DocUpdateTool(s);
  const id = idOf(await create.invoke({ title: "x", workspace: "/r" }));
  await assert.rejects(update.invoke({ id, title: "  " }), /must not be blank/);
});

// ---------- approval gating ------------------------------------------------

test("write tools require approval; read tools do not", () => {
  const s = store();
  // Read through the `Tool` interface so the optional `requiresApproval` is
  // visible on the read tools (whose classes don't declare it), matching the
  // Rust trait-default behaviour.
  const gate = (t: Tool): boolean => toolRequiresApproval(t);
  assert.equal(gate(new DocCreateTool(s, ROOT)), true);
  assert.equal(gate(new DocUpsertTool(s, ROOT)), true);
  assert.equal(gate(new DocUpdateTool(s)), true);
  assert.equal(gate(new DocDeleteTool(s)), true);
  assert.equal(gate(new DocDraftSaveTool(s)), true);
  assert.equal(gate(new DocListTool(s, ROOT)), false);
  assert.equal(gate(new DocSearchTool(s, ROOT)), false);
  assert.equal(gate(new DocGetTool(s)), false);
  assert.equal(gate(new DocDraftGetTool(s)), false);
});
