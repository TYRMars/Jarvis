import { strict as assert } from "node:assert";
import { test } from "node:test";

import { newWorkflowStep } from "./definition.ts";
import {
  WORKFLOW_RUN_STATUSES,
  finishWorkflowRun,
  newWorkflowRun,
  pushWorkflowStep,
  workflowRunStatusFromWire,
  workflowRunStatusIsTerminal,
  workflowStepResultFailed,
  workflowStepResultOk,
  type WorkflowRun,
} from "./run.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("newWorkflowRun defaults to running with fresh uuid + started_at", () => {
  const run = newWorkflowRun("wf-1", "req-1");
  assert.match(run.id, UUID_RE);
  assert.equal(run.workflow_id, "wf-1");
  assert.equal(run.requirement_id, "req-1");
  assert.equal(run.status, "running");
  assert.deepEqual(run.step_results, []);
  assert.equal(run.error, undefined);
  assert.ok(run.started_at.length > 0);
  assert.equal(run.finished_at, undefined);
});

test("run status wire round-trips and terminal flags", () => {
  for (const s of WORKFLOW_RUN_STATUSES) {
    assert.equal(workflowRunStatusFromWire(s), s);
  }
  assert.equal(workflowRunStatusFromWire("bogus"), undefined);
  assert.equal(workflowRunStatusIsTerminal("pending"), false);
  assert.equal(workflowRunStatusIsTerminal("running"), false);
  assert.equal(workflowRunStatusIsTerminal("succeeded"), true);
  assert.equal(workflowRunStatusIsTerminal("failed"), true);
  assert.equal(workflowRunStatusIsTerminal("cancelled"), true);
});

test("finishWorkflowRun: terminal status is sticky", () => {
  const run = newWorkflowRun("wf-1", "req-1");
  assert.equal(run.status, "running");
  finishWorkflowRun(run, "failed");
  const saved = run.status;
  assert.equal(saved, "failed");
  // Late finish must not overwrite terminal.
  finishWorkflowRun(run, "succeeded");
  assert.equal(run.status, saved);
  assert.notEqual(run.finished_at, undefined);
});

test("requirement_id skipped when absent (ad-hoc run)", () => {
  const run = newWorkflowRun("wf-1", undefined);
  assert.equal(run.requirement_id, undefined);
  const json = JSON.stringify(run);
  assert.equal(json.includes("requirement_id"), false, json);
});

test("running run omits finished_at / error in JSON", () => {
  const run = newWorkflowRun("wf-1", undefined);
  const json = JSON.stringify(run);
  assert.equal(json.includes("finished_at"), false, json);
  assert.equal(json.includes('"error"'), false, json);
});

test("pushWorkflowStep appends step results in order", () => {
  const run: WorkflowRun = newWorkflowRun("wf-1", undefined);
  const step = newWorkflowStep("s", { type: "agent", prompt: "p" });
  pushWorkflowStep(run, workflowStepResultOk(step, "c1", "first"));
  pushWorkflowStep(run, workflowStepResultFailed(step, undefined, "boom"));
  assert.equal(run.step_results.length, 2);
  assert.equal(run.step_results[0]?.output, "first");
  assert.equal(run.step_results[1]?.error, "boom");
});

test("step result constructors set status + payloads", () => {
  const step = newWorkflowStep("s", { type: "agent", prompt: "p" });

  const ok = workflowStepResultOk(step, "c1", "done");
  assert.equal(ok.step_id, step.id);
  assert.equal(ok.name, "s");
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.conversation_id, "c1");
  assert.equal(ok.output, "done");
  assert.equal(ok.error, undefined);

  const bad = workflowStepResultFailed(step, undefined, "boom");
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "boom");
  assert.equal(bad.output, undefined);
  assert.equal(bad.conversation_id, undefined);
});

test("step result omits absent optionals in JSON", () => {
  const step = newWorkflowStep("s", { type: "agent", prompt: "p" });
  // ok result: no error; failed result: no output; failed w/o conv: no conversation_id.
  const okJson = JSON.stringify(workflowStepResultOk(step, "c1", "done"));
  assert.equal(okJson.includes('"error"'), false, okJson);

  const failJson = JSON.stringify(workflowStepResultFailed(step, undefined, "boom"));
  assert.equal(failJson.includes('"output"'), false, failJson);
  assert.equal(failJson.includes("conversation_id"), false, failJson);
});
