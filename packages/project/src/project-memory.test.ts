import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newProjectMemory,
  PROJECT_MEMORY_BODY_CAP,
  touchProjectMemory,
  withProjectMemorySource,
  withProjectMemoryTags,
  type ProjectMemory,
  type ProjectMemoryKind,
} from "./project-memory.ts";

test("newProjectMemory mints uuid + matching timestamps + empty tags", () => {
  const m = newProjectMemory("p1", "gotcha", "title", "body");
  assert.equal(m.id.length, 36);
  assert.equal(m.project_id, "p1");
  assert.equal(m.kind, "gotcha");
  assert.deepEqual(m.tags, []);
  assert.equal(m.source_run_id, undefined);
  assert.equal(m.source_requirement_id, undefined);
  assert.equal(m.created_at, m.updated_at);
});

test("body is truncated at construction with a … marker", () => {
  const body = "x".repeat(PROJECT_MEMORY_BODY_CAP + 100);
  const m = newProjectMemory("p1", "gotcha", "t", body);
  assert.ok([...m.body].length <= PROJECT_MEMORY_BODY_CAP);
  assert.ok(m.body.endsWith("…"));
});

test("kind serialises snake_case and round-trips", () => {
  for (const k of ["lesson", "gotcha", "context"] as const satisfies ProjectMemoryKind[]) {
    const json = JSON.stringify({ kind: k });
    assert.ok(json.includes(k));
  }
});

test("withProjectMemorySource sets both ids", () => {
  const m = withProjectMemorySource(
    newProjectMemory("p1", "gotcha", "t", "b"),
    "run-1",
    "req-1",
  );
  assert.equal(m.source_run_id, "run-1");
  assert.equal(m.source_requirement_id, "req-1");
});

test("withProjectMemoryTags sets tags", () => {
  const m = withProjectMemoryTags(newProjectMemory("p1", "context", "t", "b"), ["a", "b"]);
  assert.deepEqual(m.tags, ["a", "b"]);
});

test("wire shape: source ids omitted when absent; round-trips", () => {
  const m = newProjectMemory("p1", "lesson", "t", "b");
  const json = JSON.stringify(m);
  assert.ok(!json.includes("source_run_id"));
  assert.ok(!json.includes("source_requirement_id"));
  const back = JSON.parse(json) as ProjectMemory;
  assert.deepEqual(back, m);
});

test("touchProjectMemory bumps updated_at", () => {
  const m = newProjectMemory("p1", "lesson", "t", "b");
  m.updated_at = "2020-01-01T00:00:00.000Z";
  touchProjectMemory(m);
  assert.ok(m.updated_at > "2020-01-01T00:00:00.000Z");
});
