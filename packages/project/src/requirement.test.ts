import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptancePolicyFromWire,
  acceptancePolicyIsDefault,
  ensureExecutionChecklist,
  executionChecklistFailedOrBlocked,
  executionChecklistIsDefaultSeeded,
  executionChecklistPassed,
  linkConversation,
  newRequirement,
  requirementDeletedEvent,
  requirementEventProjectId,
  requirementStatusFromWire,
  requirementToWire,
  requirementUpsertedEvent,
  requirementTodoCreatorFromWire,
  requirementTodoKindFromWire,
  requirementTodoStatusFromWire,
  triageStateFromWire,
  triageStateIsDefault,
  triageStateNeedsTriage,
  validateNoSelfDependency,
  type Requirement,
  type RequirementEvent,
} from "./requirement.ts";

test("newRequirement defaults: backlog, approved, subagent, empty conv list", () => {
  const r = newRequirement("proj-1", "ship the kanban");
  assert.equal(r.id.length, 36);
  assert.equal(r.project_id, "proj-1");
  assert.equal(r.title, "ship the kanban");
  assert.equal(r.status, "backlog");
  assert.deepEqual(r.conversation_ids, []);
  assert.equal(r.triage_state, "approved");
  assert.equal(r.acceptance_policy, "subagent");
  assert.equal(r.created_at, r.updated_at);
});

test("status enum<->wire mapping", () => {
  for (const s of ["backlog", "in_progress", "review", "done"] as const) {
    assert.equal(requirementStatusFromWire(s), s);
  }
  assert.equal(requirementStatusFromWire("nonsense"), undefined);
});

test("status serialises snake_case verbatim", () => {
  const r = newRequirement("p", "x");
  r.status = "in_progress";
  assert.ok(JSON.stringify(r).includes('"status":"in_progress"'));
});

test("triage state helpers", () => {
  assert.equal(triageStateFromWire("approved"), "approved");
  assert.equal(triageStateFromWire("proposed_by_agent"), "proposed_by_agent");
  assert.equal(triageStateFromWire("proposed_by_scan"), "proposed_by_scan");
  assert.equal(triageStateFromWire("nope"), undefined);
  assert.equal(triageStateIsDefault("approved"), true);
  assert.equal(triageStateIsDefault("proposed_by_scan"), false);
  assert.equal(triageStateNeedsTriage("approved"), false);
  assert.equal(triageStateNeedsTriage("proposed_by_agent"), true);
});

test("acceptance policy helpers", () => {
  assert.equal(acceptancePolicyFromWire("subagent"), "subagent");
  assert.equal(acceptancePolicyFromWire("human"), "human");
  assert.equal(acceptancePolicyFromWire("unknown"), undefined);
  assert.equal(acceptancePolicyIsDefault("subagent"), true);
  assert.equal(acceptancePolicyIsDefault("human"), false);
});

test("todo enum wire round-trips", () => {
  assert.equal(requirementTodoKindFromWire("deploy"), "deploy");
  assert.equal(requirementTodoKindFromWire("x"), undefined);
  assert.equal(requirementTodoStatusFromWire("blocked"), "blocked");
  assert.equal(requirementTodoStatusFromWire("x"), undefined);
  assert.equal(requirementTodoCreatorFromWire("agent"), "agent");
  assert.equal(requirementTodoCreatorFromWire("x"), undefined);
});

test("linkConversation appends uniquely and is idempotent", () => {
  const r = newRequirement("p", "x");
  r.updated_at = "2020-01-01T00:00:00.000Z";
  assert.equal(linkConversation(r, "c1"), true);
  assert.deepEqual(r.conversation_ids, ["c1"]);
  assert.ok(r.updated_at > "2020-01-01T00:00:00.000Z");
  const stamp = r.updated_at;
  assert.equal(linkConversation(r, "c1"), false);
  assert.deepEqual(r.conversation_ids, ["c1"]);
  assert.equal(r.updated_at, stamp, "no-op must not touch");
  assert.equal(linkConversation(r, "c2"), true);
  assert.deepEqual(r.conversation_ids, ["c1", "c2"]);
});

test("validateNoSelfDependency rejects self-listing", () => {
  assert.equal(validateNoSelfDependency("r1", ["r2", "r3"]), null);
  assert.notEqual(validateNoSelfDependency("r1", ["r2", "r1"]), null);
  assert.equal(validateNoSelfDependency("r1", []), null);
});

test("ensureExecutionChecklist seeds default trio when no plan", () => {
  const r = newRequirement("p", "x");
  assert.equal(ensureExecutionChecklist(r), true);
  assert.equal(r.todos?.length, 3);
  assert.ok(r.todos?.every((t) => t.created_by === "workflow"));
  // Second call is a no-op.
  assert.equal(ensureExecutionChecklist(r), false);
});

test("ensureExecutionChecklist derives todos from a verification plan", () => {
  const r = newRequirement("p", "x");
  r.verification_plan = {
    commands: ["cargo test", "  "],
    require_diff: true,
    require_tests: true,
  };
  ensureExecutionChecklist(r);
  // One ci todo (blank command filtered) + require_diff + require_tests.
  assert.equal(r.todos?.length, 3);
  const ci = r.todos?.find((t) => t.kind === "ci");
  assert.equal(ci?.command, "cargo test");
});

test("execution checklist passed / failed / default-seeded predicates", () => {
  const r = newRequirement("p", "x");
  assert.equal(executionChecklistPassed(r), false); // empty
  ensureExecutionChecklist(r);
  assert.equal(executionChecklistIsDefaultSeeded(r), true);
  assert.equal(executionChecklistPassed(r), false); // pending
  for (const t of r.todos ?? []) t.status = "passed";
  assert.equal(executionChecklistPassed(r), true);
  assert.equal(executionChecklistIsDefaultSeeded(r), false);
  if (r.todos) r.todos[0].status = "failed";
  assert.equal(executionChecklistFailedOrBlocked(r), true);
});

test("wire shape: skip fields omitted on a fresh requirement", () => {
  const r = newRequirement("p1", "x");
  const json = JSON.stringify(requirementToWire(r));
  // skip_serializing_if defaults / empties → absent
  assert.ok(!json.includes("description"));
  assert.ok(!json.includes("verification_plan"));
  assert.ok(!json.includes("todos"));
  assert.ok(!json.includes("triage_state")); // default approved
  assert.ok(!json.includes("depends_on"));
  assert.ok(!json.includes("label_ids"));
  assert.ok(!json.includes("workflow_id"));
  // #[serde(skip)] → never on the public wire shape
  assert.ok(!json.includes("assignee_id"));
  assert.ok(!json.includes("acceptance_policy"));
});

test("wire shape: requirementToWire strips skip fields but keeps the rest", () => {
  const r = newRequirement("p1", "title");
  r.assignee_id = "someone";
  r.acceptance_policy = "human";
  r.description = "body";
  const wire = requirementToWire(r);
  assert.ok(!("assignee_id" in wire));
  assert.ok(!("acceptance_policy" in wire));
  const obj = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
  for (const key of [
    "id",
    "project_id",
    "title",
    "description",
    "status",
    "conversation_ids",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(key in obj, `missing wire key: ${key}`);
  }
});

test("wire shape: non-default triage_state IS emitted", () => {
  const r = newRequirement("p1", "x");
  r.triage_state = "proposed_by_agent";
  const json = JSON.stringify(requirementToWire(r));
  assert.ok(json.includes('"triage_state":"proposed_by_agent"'));
});

test("RequirementEvent: upserted flattens fields, project_id helper works", () => {
  const r = newRequirement("p1", "x");
  const upserted: RequirementEvent = requirementUpsertedEvent(r);
  assert.equal(requirementEventProjectId(upserted), "p1");
  assert.ok(JSON.stringify(upserted).includes('"type":"upserted"'));
  const deleted: RequirementEvent = requirementDeletedEvent("p2", r.id);
  assert.equal(requirementEventProjectId(deleted), "p2");
});

test("RequirementEvent: upserted matches Rust serde wire (no skip / default fields)", () => {
  // Authoritative Rust output for a fresh requirement (captured from
  // RequirementEvent::Upserted serde_json):
  //   {"type":"upserted","id":..,"project_id":"p1","title":"x",
  //    "status":"backlog","conversation_ids":[],"created_at":..,"updated_at":..}
  const r = newRequirement("p1", "x");
  r.assignee_id = "someone"; // set the skip fields in-memory…
  r.acceptance_policy = "human";
  const ev = requirementUpsertedEvent(r);
  const obj = JSON.parse(JSON.stringify(ev)) as Record<string, unknown>;
  // …they must NOT survive onto the broadcast wire.
  assert.ok(!("assignee_id" in obj), "assignee_id is #[serde(skip)] — must be absent");
  assert.ok(!("acceptance_policy" in obj), "acceptance_policy is #[serde(skip)] — must be absent");
  assert.ok(!("triage_state" in obj), "default triage_state must be skipped");
  assert.deepEqual(Object.keys(obj).sort(), [
    "conversation_ids",
    "created_at",
    "id",
    "project_id",
    "status",
    "title",
    "type",
    "updated_at",
  ]);
});

test("wire shape: optional Requirement fields round-trip when set", () => {
  const r = newRequirement("p", "x");
  r.workflow_id = "wf-123";
  r.depends_on = ["r2"];
  r.label_ids = ["l1"];
  const json = JSON.stringify(requirementToWire(r));
  const back = JSON.parse(json) as Requirement;
  assert.equal(back.workflow_id, "wf-123");
  assert.deepEqual(back.depends_on, ["r2"]);
  assert.deepEqual(back.label_ids, ["l1"]);
});
