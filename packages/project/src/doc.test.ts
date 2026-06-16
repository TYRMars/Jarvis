import { test } from "node:test";
import assert from "node:assert/strict";
import {
  docEventWorkspace,
  docKindFromWire,
  newDocDraft,
  newDocProject,
  touchDocProject,
  type DocDraft,
  type DocEvent,
  type DocProject,
} from "./doc.ts";

test("docKind enum<->wire mapping", () => {
  for (const k of ["note", "research", "report", "design", "guide"] as const) {
    assert.equal(docKindFromWire(k), k);
  }
  assert.equal(docKindFromWire("nonsense"), undefined);
  assert.equal(JSON.stringify({ kind: "research" }), '{"kind":"research"}');
});

test("newDocProject defaults to note + matching timestamps", () => {
  const p = newDocProject("/repo", "weekly review");
  assert.equal(p.id.length, 36);
  assert.equal(p.workspace, "/repo");
  assert.equal(p.title, "weekly review");
  assert.equal(p.kind, "note");
  assert.deepEqual(p.tags, []);
  assert.equal(p.pinned, false);
  assert.equal(p.archived, false);
  assert.equal(p.created_at, p.updated_at);
});

test("touchDocProject bumps updated_at", () => {
  const p = newDocProject("/r", "x");
  p.updated_at = "2020-01-01T00:00:00.000Z";
  touchDocProject(p);
  assert.ok(p.updated_at > "2020-01-01T00:00:00.000Z");
});

test("newDocDraft defaults to markdown format", () => {
  const d = newDocDraft("p-1", "# hi\n");
  assert.equal(d.format, "markdown");
  assert.equal(d.project_id, "p-1");
  assert.ok(d.content.startsWith("# hi"));
});

test("doc project / draft round-trip + wire keys present", () => {
  const p = newDocProject("/repo", "design doc");
  p.kind = "design";
  p.tags = ["q3", "ship-ready"];
  p.pinned = true;
  const pback = JSON.parse(JSON.stringify(p)) as DocProject;
  assert.deepEqual(pback, p);
  const pobj = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  for (const key of [
    "id",
    "workspace",
    "title",
    "kind",
    "created_at",
    "updated_at",
    "tags",
    "pinned",
    "archived",
  ]) {
    assert.ok(key in pobj, `missing project wire key: ${key}`);
  }
  const d = newDocDraft("p", "body");
  const dobj = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  for (const key of ["id", "project_id", "format", "content", "created_at", "updated_at"]) {
    assert.ok(key in dobj, `missing draft wire key: ${key}`);
  }
});

test("DocEvent workspace helper: present for project events, undefined for draft", () => {
  const p = newDocProject("/r", "x");
  const up: DocEvent = { type: "project_upserted", ...p };
  assert.equal(docEventWorkspace(up), "/r");
  assert.ok(JSON.stringify(up).includes('"type":"project_upserted"'));
  const del: DocEvent = { type: "project_deleted", workspace: "/other", id: p.id };
  assert.equal(docEventWorkspace(del), "/other");
  const d: DocDraft = newDocDraft(p.id, "");
  const dup: DocEvent = { type: "draft_upserted", ...d };
  assert.equal(docEventWorkspace(dup), undefined);
});
