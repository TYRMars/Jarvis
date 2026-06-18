import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveProject,
  automationIsDefault,
  defaultKanbanColumns,
  defaultProjectAutomation,
  deriveSlug,
  newProject,
  newProjectWorkspace,
  projectToWire,
  setProjectName,
  unarchiveProject,
  validateColumnId,
  validateSlug,
  type Project,
} from "./project.ts";

test("newProject mints a uuid, empty slug, and matching timestamps", () => {
  const p = newProject("Customer Support", "be terse");
  assert.equal(p.id.length, 36);
  assert.equal(p.name, "Customer Support");
  assert.equal(p.instructions, "be terse");
  assert.equal(p.slug, "");
  assert.equal(p.archived, false);
  assert.equal(p.created_at, p.updated_at);
  assert.deepEqual(p.automation, defaultProjectAutomation());
});

test("setProjectName bumps updated_at", () => {
  const p = newProject("x", "y");
  p.created_at = "2020-01-01T00:00:00.000Z";
  p.updated_at = "2020-01-01T00:00:00.000Z";
  setProjectName(p, "z");
  assert.ok(p.updated_at > "2020-01-01T00:00:00.000Z");
  assert.equal(p.name, "z");
});

test("archive is idempotent and does not re-bump after first call", () => {
  const p = newProject("x", "y");
  archiveProject(p);
  assert.equal(p.archived, true);
  const stamp = p.updated_at;
  // Pin then re-archive: no mutation → no touch.
  p.updated_at = stamp;
  archiveProject(p);
  assert.equal(p.updated_at, stamp);
  unarchiveProject(p);
  assert.equal(p.archived, false);
});

test("deriveSlug basics", () => {
  assert.equal(deriveSlug("Customer Support"), "customer-support");
  assert.equal(deriveSlug("  Hello, World!  "), "hello-world");
  assert.equal(deriveSlug("MULTI___under_scores"), "multi-under-scores");
  assert.equal(deriveSlug("v1.2.3"), "v1-2-3");
});

test("deriveSlug caps length at 64 and falls back when empty", () => {
  assert.ok(deriveSlug("a".repeat(200)).length <= 64);
  const fallback = deriveSlug("中文 ::: !!!");
  assert.ok(fallback.length > 0);
  assert.ok(/^[0-9a-f-]+$/.test(fallback));
});

test("validateSlug rejects bad inputs", () => {
  assert.equal(validateSlug("ok-slug"), null);
  assert.equal(validateSlug("a"), null);
  assert.notEqual(validateSlug(""), null);
  assert.notEqual(validateSlug("-leading"), null);
  assert.notEqual(validateSlug("trailing-"), null);
  assert.notEqual(validateSlug("UPPER"), null);
  assert.notEqual(validateSlug("with space"), null);
  assert.notEqual(validateSlug("a".repeat(65)), null);
});

test("validateColumnId rules", () => {
  assert.equal(validateColumnId("backlog"), null);
  assert.equal(validateColumnId("in_progress"), null);
  assert.equal(validateColumnId("custom-1"), null);
  assert.equal(validateColumnId("a"), null);
  assert.notEqual(validateColumnId(""), null);
  assert.notEqual(validateColumnId("UPPER"), null);
  assert.notEqual(validateColumnId("with space"), null);
  assert.notEqual(validateColumnId("中文"), null);
  assert.notEqual(validateColumnId("a".repeat(65)), null);
});

test("defaultKanbanColumns match legacy ids and all set kind", () => {
  const cols = defaultKanbanColumns();
  assert.deepEqual(
    cols.map((c) => c.id),
    ["backlog", "in_progress", "review", "done"],
  );
  for (const c of cols) {
    assert.notEqual(c.kind, undefined);
  }
});

test("wire shape: description / columns omitted when unset", () => {
  const p = newProject("n", "i");
  const json = JSON.stringify(p);
  assert.ok(!json.includes("description"));
  assert.ok(!json.includes("columns"));
});

test("wire shape: default automation is skipped (skip_serializing_if)", () => {
  // The serde contract skips `automation` when it equals the default;
  // projectToWire mirrors that.
  const p = newProject("n", "i");
  assert.ok(automationIsDefault(defaultProjectAutomation()));
  const json = JSON.stringify(projectToWire(p));
  assert.ok(!json.includes("automation"));
});

test("wire shape: projectToWire keeps non-default automation", () => {
  const p = newProject("n", "i");
  p.automation = { auto_mode_enabled: false };
  const json = JSON.stringify(projectToWire(p));
  assert.ok(json.includes('"automation":{"auto_mode_enabled":false}'));
});

test("wire shape: disabled automation round-trips", () => {
  const p = newProject("n", "i");
  p.automation = { auto_mode_enabled: false };
  const json = JSON.stringify(p);
  assert.ok(json.includes("automation"));
  const back = JSON.parse(json) as Project;
  assert.equal(back.automation?.auto_mode_enabled, false);
});

test("workspace name is omitted when absent", () => {
  const ws = newProjectWorkspace("/c");
  const json = JSON.stringify(ws);
  assert.ok(!json.includes("name"));
});

test("legacy json without workspaces/columns/automation still parses", () => {
  const legacy = {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "legacy",
    name: "Legacy",
    instructions: "be terse",
    tags: [],
    archived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const p = JSON.parse(JSON.stringify(legacy)) as Project;
  // Fields simply absent (undefined) — matching serde defaults semantics.
  assert.equal(p.workspaces, undefined);
  assert.equal(p.columns, undefined);
  assert.equal(p.automation, undefined);
});
