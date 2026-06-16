import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_ATTRIBUTES_CAP,
  SKILL_NAME_CAP,
  SkillUsageRejectionError,
  foldEventsIntoRows,
  sanitizeSkillUsageEvent,
  skillScopeProject,
  skillScopeUser,
  skillScopeWorkspace,
  viewedSkillUsageEvent,
  type SkillUsageAction,
  type SkillUsageEvent,
} from "./skill-usage.ts";

function ev(name: string, action: SkillUsageAction, ts: string): SkillUsageEvent {
  return {
    id: `${name}-${ts}`,
    skill_name: name,
    source: "workspace",
    action,
    scope: skillScopeWorkspace("/tmp/ws"),
    created_at: ts,
    attributes: null,
  };
}

// ---------- fold ----------

test("fold groups by skill and counts views/uses + newest last_used_at", () => {
  const rows = foldEventsIntoRows([
    ev("rust-debugger", "viewed", "2026-01-01T00:00:00Z"),
    ev("rust-debugger", "used", "2026-01-02T00:00:00Z"),
    ev("rust-debugger", "used", "2026-01-03T00:00:00Z"),
    ev("python-lint", "viewed", "2026-01-01T00:00:00Z"),
  ]);
  assert.equal(rows.length, 2);
  const rust = rows.find((r) => r.skill_name === "rust-debugger");
  assert.ok(rust);
  assert.equal(rust.view_count, 1);
  assert.equal(rust.use_count, 2);
  assert.equal(rust.last_used_at, "2026-01-03T00:00:00Z");
});

test("fold last_action is newest regardless of input order", () => {
  const ascending = foldEventsIntoRows([
    ev("s", "viewed", "2026-01-01T00:00:00Z"),
    ev("s", "patched", "2026-01-02T00:00:00Z"),
    ev("s", "used", "2026-01-03T00:00:00Z"),
  ]);
  assert.equal(ascending[0]?.last_action, "used");

  const descending = foldEventsIntoRows([
    ev("s", "used", "2026-01-03T00:00:00Z"),
    ev("s", "patched", "2026-01-02T00:00:00Z"),
    ev("s", "viewed", "2026-01-01T00:00:00Z"),
  ]);
  assert.equal(descending[0]?.last_action, "used");
});

test("fold separates scopes into distinct rows", () => {
  const a = ev("k", "used", "2026-01-01T00:00:00Z");
  a.scope = skillScopeUser();
  const b = ev("k", "used", "2026-01-01T00:00:00Z");
  b.scope = skillScopeProject("p1");
  const rows = foldEventsIntoRows([a, b]);
  assert.equal(rows.length, 2, "user and project scope are different rows");
});

test("fold counts patch-family actions into patch_count", () => {
  const rows = foldEventsIntoRows([
    ev("s", "patched", "2026-01-01T00:00:00Z"),
    ev("s", "created", "2026-01-02T00:00:00Z"),
    ev("s", "archived", "2026-01-03T00:00:00Z"),
    ev("s", "restored", "2026-01-04T00:00:00Z"),
  ]);
  assert.equal(rows[0]?.patch_count, 4);
  assert.equal(rows[0]?.view_count, 0);
  assert.equal(rows[0]?.use_count, 0);
});

test("fold output is sorted ascending by skill_name", () => {
  const rows = foldEventsIntoRows([
    ev("zebra", "viewed", "2026-01-01T00:00:00Z"),
    ev("alpha", "viewed", "2026-01-01T00:00:00Z"),
    ev("mango", "viewed", "2026-01-01T00:00:00Z"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.skill_name),
    ["alpha", "mango", "zebra"],
  );
});

// ---------- sanitize ----------

test("sanitize blanks client-supplied id and created_at", () => {
  const e = ev("rust", "used", "2099-12-31T00:00:00+05:00");
  e.id = "attacker-chosen";
  const out = sanitizeSkillUsageEvent(e);
  assert.equal(out.id, "", "client id is dropped, store re-stamps");
  assert.equal(out.created_at, "", "client created_at is dropped");
});

test("sanitize rejects empty skill_name after trim", () => {
  assert.throws(() => sanitizeSkillUsageEvent(ev("   ", "viewed", "2026-01-01T00:00:00Z")), (e) => {
    assert.ok(e instanceof SkillUsageRejectionError);
    assert.equal(e.rejection.reason, "empty_skill_name");
    return true;
  });
});

test("sanitize trims the skill_name", () => {
  const out = sanitizeSkillUsageEvent(ev("  rust  ", "viewed", "2026-01-01T00:00:00Z"));
  assert.equal(out.skill_name, "rust");
});

test("sanitize rejects oversized skill_name", () => {
  const long = "a".repeat(SKILL_NAME_CAP + 1);
  assert.throws(() => sanitizeSkillUsageEvent(ev(long, "viewed", "2026-01-01T00:00:00Z")), (e) => {
    assert.ok(e instanceof SkillUsageRejectionError);
    assert.equal(e.rejection.reason, "skill_name_too_long");
    return true;
  });
});

test("sanitize rejects oversized attributes", () => {
  const e = ev("rust", "used", "2026-01-01T00:00:00Z");
  e.attributes = { blob: "x".repeat(SKILL_ATTRIBUTES_CAP + 1) };
  assert.throws(() => sanitizeSkillUsageEvent(e), (err) => {
    assert.ok(err instanceof SkillUsageRejectionError);
    assert.equal(err.rejection.reason, "attributes_too_large");
    return true;
  });
});

test("sanitize accepts small attributes verbatim", () => {
  const e = ev("rust", "used", "2026-01-01T00:00:00Z");
  e.attributes = { duration_ms: 42 };
  const out = sanitizeSkillUsageEvent(e);
  assert.deepEqual(out.attributes, { duration_ms: 42 });
});

// ---------- viewed constructor ----------

test("viewed constructor sets action + leaves id/created_at for the store", () => {
  const e = viewedSkillUsageEvent("code-review", "bundled", skillScopeProject("p1"));
  assert.equal(e.action, "viewed");
  assert.equal(e.id, "", "id is filled by the store");
  assert.equal(e.created_at, "", "ts is filled by the store");
  assert.equal(e.attributes, null);
});
