import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityEventRequirementId,
  activityKindFromWire,
  newActivity,
  type ActivityActor,
  type ActivityEvent,
} from "./activity.ts";

test("newActivity mints a uuid and timestamp", () => {
  const a = newActivity("req-1", "status_change", { type: "human" }, {
    from: "backlog",
    to: "in_progress",
  });
  assert.equal(a.id.length, 36);
  assert.equal(a.requirement_id, "req-1");
  assert.equal(a.kind, "status_change");
});

test("activityKindFromWire maps known + rejects unknown", () => {
  for (const k of [
    "status_change",
    "run_started",
    "run_finished",
    "verification_finished",
    "assignee_change",
    "comment",
    "blocked",
    "unblocked",
    "connector_sync",
  ] as const) {
    assert.equal(activityKindFromWire(k), k);
  }
  assert.equal(activityKindFromWire("nope"), undefined);
});

test("ActivityActor: human serialises as a tagged object", () => {
  const actor: ActivityActor = { type: "human" };
  assert.equal(JSON.stringify(actor), '{"type":"human"}');
});

test("ActivityActor: agent carries profile_id", () => {
  const actor: ActivityActor = { type: "agent", profile_id: "prof-7" };
  const json = JSON.stringify(actor);
  assert.ok(json.includes('"type":"agent"'));
  assert.ok(json.includes('"profile_id":"prof-7"'));
  const back = JSON.parse(json) as ActivityActor;
  assert.deepEqual(back, actor);
});

test("ActivityEvent appended flattens activity fields + helper", () => {
  const a = newActivity("req-1", "status_change", { type: "human" }, {
    from: "backlog",
    to: "in_progress",
  });
  const ev: ActivityEvent = { type: "appended", ...a };
  const json = JSON.stringify(ev);
  assert.ok(json.includes('"type":"appended"'));
  assert.ok(json.includes('"kind":"status_change"'));
  assert.ok(json.includes('"actor":{"type":"human"}'));
  assert.equal(activityEventRequirementId(ev), "req-1");
});

test("run_finished body round-trips", () => {
  const a = newActivity("req", "run_finished", { type: "system" }, {
    run_id: "abc",
    status: "completed",
  });
  const back = JSON.parse(JSON.stringify(a));
  assert.deepEqual(back, a);
});
