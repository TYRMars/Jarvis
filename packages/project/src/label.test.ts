import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelEventProjectId,
  MAX_LABEL_NAME_LEN,
  newLabel,
  touchLabel,
  validateLabelColour,
  validateLabelName,
  type Label,
  type LabelEvent,
} from "./label.ts";

function unwrap(r: { ok: string } | { err: string }): string {
  assert.ok("ok" in r, "expected ok: " + JSON.stringify(r));
  return (r as { ok: string }).ok;
}

test("validateLabelName trims and rejects empty / long / control chars", () => {
  assert.equal(unwrap(validateLabelName("  bug  ")), "bug");
  assert.ok("err" in validateLabelName(""));
  assert.ok("err" in validateLabelName("   "));
  assert.ok("err" in validateLabelName("a".repeat(MAX_LABEL_NAME_LEN + 1)));
  assert.ok("err" in validateLabelName("bug\nfix"));
  assert.ok("err" in validateLabelName("bug\tfix"));
});

test("validateLabelColour accepts #rrggbb (case-insensitive), lowercases", () => {
  assert.equal(unwrap(validateLabelColour("#ABcdef")), "#abcdef");
  assert.equal(unwrap(validateLabelColour(" #112233 ")), "#112233");
  assert.ok("err" in validateLabelColour("red"));
  assert.ok("err" in validateLabelColour("#abc"));
  assert.ok("err" in validateLabelColour("rgb(0,0,0)"));
  assert.ok("err" in validateLabelColour("#zzzzzz"));
});

test("newLabel: uuid + matching timestamps, no description", () => {
  const l = newLabel("proj-1", "bug", "#ff0000");
  assert.equal(l.id.length, 36);
  assert.equal(l.project_id, "proj-1");
  assert.equal(l.name, "bug");
  assert.equal(l.colour, "#ff0000");
  assert.equal(l.description, undefined);
  assert.equal(l.created_at, l.updated_at);
});

test("wire shape: description omitted when absent; round-trips", () => {
  const l = newLabel("proj-1", "bug", "#ff0000");
  const json = JSON.stringify(l);
  assert.ok(!json.includes("description"));
  const back = JSON.parse(json) as Label;
  assert.deepEqual(back, l);
});

test("touchLabel bumps updated_at; created_at immutable", () => {
  const l = newLabel("proj-1", "bug", "#ff0000");
  l.created_at = "2020-01-01T00:00:00.000Z";
  l.updated_at = "2020-01-01T00:00:00.000Z";
  touchLabel(l);
  assert.notEqual(l.updated_at, "2020-01-01T00:00:00.000Z");
  assert.equal(l.created_at, "2020-01-01T00:00:00.000Z");
});

test("LabelEvent variants + project-id helper", () => {
  const l = newLabel("proj-7", "bug", "#ff0000");
  const created: LabelEvent = { type: "created", ...l };
  assert.ok(JSON.stringify(created).includes('"type":"created"'));
  assert.equal(labelEventProjectId(created), "proj-7");
  const deleted: LabelEvent = { type: "deleted", project_id: "proj-7", label_id: l.id };
  assert.equal(labelEventProjectId(deleted), "proj-7");
});
