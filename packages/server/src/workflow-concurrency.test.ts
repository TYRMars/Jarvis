import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WorkflowRunGate,
  DEFAULT_WORKFLOW_MAX_CONCURRENT,
} from "./workflow-concurrency.ts";

test("capacity is clamped to at least one", () => {
  assert.equal(new WorkflowRunGate(0).capacity(), 1);
  assert.equal(new WorkflowRunGate(-3).capacity(), 1);
  assert.equal(new WorkflowRunGate(5).capacity(), 5);
});

test("default capacity matches the auto loop default", () => {
  assert.equal(new WorkflowRunGate().capacity(), DEFAULT_WORKFLOW_MAX_CONCURRENT);
});

test("tryAcquire bounds concurrency and reopens slots on release", () => {
  const gate = new WorkflowRunGate(1);
  const first = gate.tryAcquire();
  assert.ok(first, "first slot must be admitted");
  assert.equal(gate.available(), 0);

  // Over-cap → undefined so the route can 429.
  assert.equal(gate.tryAcquire(), undefined, "second slot must be rejected at capacity 1");

  // Releasing the permit frees the slot again.
  first.release();
  assert.equal(gate.available(), 1);
  assert.ok(gate.tryAcquire(), "slot reopens after release");
});

test("permit release is idempotent (a double release doesn't over-credit)", () => {
  const gate = new WorkflowRunGate(1);
  const permit = gate.tryAcquire();
  assert.ok(permit);
  permit.release();
  permit.release(); // no-op
  assert.equal(gate.available(), 1, "capacity must not exceed the configured cap");
});

test("inflight guard marks and clears liveness", () => {
  const gate = new WorkflowRunGate(2);
  assert.equal(gate.isActive("r1"), false);
  const guard = gate.markInflight("r1");
  assert.equal(gate.isActive("r1"), true);
  assert.equal(gate.activeCount(), 1);
  guard.clear();
  assert.equal(gate.isActive("r1"), false);
  assert.equal(gate.activeCount(), 0);
  // Idempotent.
  guard.clear();
  assert.equal(gate.activeCount(), 0);
});

test("cancel aborts a registered controller and is one-shot", () => {
  const gate = new WorkflowRunGate(2);
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener("abort", () => {
    aborted = true;
  });

  gate.registerController("r1", controller);
  assert.equal(gate.cancel("r1"), true, "registered controller must report cancelled");
  assert.equal(aborted, true, "the signal observes the abort");

  // A second cancel finds nothing.
  assert.equal(gate.cancel("r1"), false);
});

test("cancel of an unknown run is false", () => {
  const gate = new WorkflowRunGate(2);
  assert.equal(gate.cancel("nope"), false);
});

test("clearing the inflight guard also drops the abort controller", () => {
  const gate = new WorkflowRunGate(2);
  const controller = new AbortController();
  gate.registerController("r1", controller);
  const guard = gate.markInflight("r1");
  guard.clear();
  // The controller was removed alongside the liveness record.
  assert.equal(gate.cancel("r1"), false);
});
