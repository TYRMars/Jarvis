// Value-type + due-computation tests. Ports the Rust unit tests in
// crates/harness-automation/src/lib.rs and adds wire-shape coverage.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AutomationTask,
  type ScheduleSpec,
  isDueAt,
  isStaleRunning,
  markFinished,
  markManualRunStarted,
  markRunning,
  markStaleReclaimed,
  newAutomationTask,
  recomputeNextRun,
  scheduleInterval,
  scheduleNextAfter,
  scheduleOnce,
} from "./task.ts";

// ---------- scheduleNextAfter (ScheduleSpec::next_after) -------------------

test("interval skips missed ticks", () => {
  const schedule: ScheduleSpec = { interval: { every_seconds: 60, start_at: "2026-01-01T00:00:00Z" } };
  const now = "2026-01-01T00:03:30Z";
  const next = scheduleNextAfter(schedule, undefined, now);
  assert.equal(next, "2026-01-01T00:04:00.000Z");
});

test("interval first tick from start_at when on a boundary in the future", () => {
  const schedule = scheduleInterval(60, "2026-01-01T00:05:00Z");
  const next = scheduleNextAfter(schedule, undefined, "2026-01-01T00:00:00Z");
  assert.equal(next, "2026-01-01T00:05:00.000Z");
});

test("interval without start_at fires now + interval", () => {
  const next = scheduleNextAfter(scheduleInterval(30), undefined, "2026-01-01T00:00:00Z");
  assert.equal(next, "2026-01-01T00:00:30.000Z");
});

test("interval clamps every_seconds to at least 1", () => {
  const next = scheduleNextAfter(scheduleInterval(0), undefined, "2026-01-01T00:00:00Z");
  assert.equal(next, "2026-01-01T00:00:01.000Z");
});

test("once has no next after run", () => {
  const schedule = scheduleOnce("2026-01-01T00:00:00Z");
  const now = "2026-01-01T00:00:01Z";
  assert.equal(scheduleNextAfter(schedule, now, now), undefined);
});

test("once before run yields run_at", () => {
  const schedule = scheduleOnce("2026-01-01T01:00:00Z");
  assert.equal(scheduleNextAfter(schedule, undefined, "2026-01-01T00:00:00Z"), "2026-01-01T01:00:00.000Z");
});

test("unparseable timestamps yield undefined", () => {
  assert.equal(scheduleNextAfter(scheduleOnce("not-a-date"), undefined, "2026-01-01T00:00:00Z"), undefined);
});

// ---------- newAutomationTask wire shape ----------------------------------

test("newAutomationTask seeds defaults and omits unset optionals", () => {
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleOnce("2026-01-01T01:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );
  assert.match(task.id, /^[0-9a-f-]{36}$/);
  assert.equal(task.status, "enabled");
  assert.equal(task.run_count, 0);
  assert.equal(task.created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(task.updated_at, "2026-01-01T00:00:00.000Z");
  assert.equal(task.next_run_at, "2026-01-01T01:00:00.000Z");
  // Unset optionals are absent (not present-as-undefined) so JSON omits them.
  const wire = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
  assert.ok(!("provider" in wire));
  assert.ok(!("model" in wire));
  assert.ok(!("conversation_id" in wire));
  assert.ok(!("last_run_at" in wire));
  assert.ok(!("last_run_status" in wire));
  assert.ok(!("last_error" in wire));
  // Defaulted-but-always-present serde fields are on the wire.
  assert.ok("status" in wire);
  assert.ok("run_count" in wire);
});

test("newAutomationTask carries through provided optionals + status", () => {
  const task = newAutomationTask(
    {
      title: "t",
      prompt: "p",
      schedule: scheduleInterval(60),
      status: "paused",
      provider: "anthropic",
      model: "claude",
      conversation_id: "conv-1",
    },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(task.status, "paused");
  assert.equal(task.provider, "anthropic");
  assert.equal(task.model, "claude");
  assert.equal(task.conversation_id, "conv-1");
});

// ---------- isDueAt --------------------------------------------------------

test("isDueAt gates on enabled + not-running + next_run_at <= now", () => {
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleOnce("2026-01-01T01:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(isDueAt(task, "2026-01-01T00:59:59Z"), false); // before
  assert.equal(isDueAt(task, "2026-01-01T01:00:00Z"), true); // at the boundary
  // paused → never due
  const paused: AutomationTask = { ...task, status: "paused" };
  assert.equal(isDueAt(paused, "2026-01-01T01:00:00Z"), false);
  // running → never due
  const running: AutomationTask = { ...task, last_run_status: "running" };
  assert.equal(isDueAt(running, "2026-01-01T01:00:00Z"), false);
});

test("isDueAt false when next_run_at absent", () => {
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleOnce("not-a-date") },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(task.next_run_at, undefined);
  assert.equal(isDueAt(task, "2026-01-01T01:00:00Z"), false);
});

// ---------- stale-running detection / reclaim -----------------------------

function intervalTask(): AutomationTask {
  return newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleInterval(60) },
    "2026-01-01T00:00:00.000Z",
  );
}

test("stale running detected only after timeout", () => {
  const task = intervalTask();
  markRunning(task, "2026-01-01T00:00:00Z");
  assert.equal(isStaleRunning(task, "2026-01-01T00:00:30Z", 60_000), false); // under budget
  assert.equal(isStaleRunning(task, "2026-01-01T00:02:00Z", 60_000), true); // past budget
});

test("non-running status is never stale", () => {
  const task = intervalTask();
  markFinished(task, "2026-01-01T00:00:00Z");
  assert.equal(isStaleRunning(task, "2026-02-01T00:00:00Z", 1), false);
});

test("running with no start timestamp is reclaimable", () => {
  const task: AutomationTask = { ...intervalTask(), last_run_status: "running", last_run_at: undefined };
  assert.equal(isStaleRunning(task, "2026-01-01T00:00:00Z", 60_000), true);
});

test("reclaiming stale running reschedules interval", () => {
  const task = intervalTask();
  const started = "2026-01-01T00:00:00Z";
  markRunning(task, started);
  markStaleReclaimed(task, "2026-01-01T01:00:00Z");
  assert.equal(task.last_run_status, "failed");
  assert.ok(task.last_error !== undefined);
  // Cleared the running flag with a future next_run_at → schedulable again.
  const next = task.next_run_at;
  assert.ok(next !== undefined && next > started);
  assert.equal(isDueAt(task, "2026-01-01T01:00:00Z"), false);
});

test("reclaiming stale running once does not reschedule", () => {
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleOnce("2026-01-01T00:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );
  markRunning(task, "2026-01-01T00:00:00Z");
  markStaleReclaimed(task, "2026-01-01T01:00:00Z");
  assert.equal(task.next_run_at, undefined);
  assert.equal(isDueAt(task, "2026-01-01T01:00:00Z"), false);
});

// ---------- manual-run bookkeeping ----------------------------------------

test("manual run clears next_run_at for once task", () => {
  const task = newAutomationTask(
    { title: "once", prompt: "do it", schedule: scheduleOnce("2026-01-01T01:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(task.next_run_at, "2026-01-01T01:00:00.000Z");

  markManualRunStarted(task, "2026-01-01T00:30:00Z");
  markFinished(task, "2026-01-01T00:30:00Z");

  // A once-task that already ran has no next run, so it never re-fires.
  assert.equal(task.next_run_at, undefined);
  assert.equal(isDueAt(task, "2026-01-01T01:00:00Z"), false);
});

test("manual run advances next_run_at for interval task", () => {
  const task = newAutomationTask(
    { title: "interval", prompt: "do it", schedule: scheduleInterval(60, "2026-01-01T00:00:00Z") },
    "2026-01-01T00:00:00.000Z",
  );

  markManualRunStarted(task, "2026-01-01T00:00:00Z");
  markFinished(task, "2026-01-01T00:00:00Z");

  // next_run_at advanced one interval into the future → not due immediately.
  assert.equal(task.next_run_at, "2026-01-01T00:01:00.000Z");
  assert.equal(isDueAt(task, "2026-01-01T00:00:00Z"), false);
  assert.equal(isDueAt(task, "2026-01-01T00:01:00Z"), true);
});

// ---------- markFinished / recomputeNextRun -------------------------------

test("markFinished records failure with error and bumps run_count", () => {
  const task = intervalTask();
  markRunning(task, "2026-01-01T00:00:00Z");
  markFinished(task, "2026-01-01T00:00:05Z", "boom");
  assert.equal(task.last_run_status, "failed");
  assert.equal(task.last_error, "boom");
  assert.equal(task.run_count, 1);
  // A subsequent success clears the error.
  markFinished(task, "2026-01-01T00:01:05Z");
  assert.equal(task.last_run_status, "succeeded");
  assert.equal(task.last_error, undefined);
  assert.equal(task.run_count, 2);
});

test("recomputeNextRun reseeds from schedule as if never run", () => {
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleInterval(60) },
    "2026-01-01T00:00:00.000Z",
  );
  recomputeNextRun(task, "2026-01-01T00:05:00Z");
  assert.equal(task.next_run_at, "2026-01-01T00:06:00.000Z");
  // updated_at is normalised to the canonical millis+Z wire form (mirrors Rust's
  // to_rfc3339), NOT stored verbatim — so a `…00Z` input becomes `…00.000Z`.
  assert.equal(task.updated_at, "2026-01-01T00:05:00.000Z");
});

test("timestamp writes are normalised to canonical millis+Z (Rust to_rfc3339)", () => {
  // newAutomationTask: created_at/updated_at normalised even when `now` lacks millis.
  const task = newAutomationTask(
    { title: "t", prompt: "p", schedule: scheduleInterval(60) },
    "2026-01-01T00:00:00Z",
  );
  assert.equal(task.created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(task.updated_at, "2026-01-01T00:00:00.000Z");

  // markRunning stamps last_run_at + updated_at in canonical form.
  markRunning(task, "2026-01-01T00:01:00Z");
  assert.equal(task.last_run_at, "2026-01-01T00:01:00.000Z");
  assert.equal(task.updated_at, "2026-01-01T00:01:00.000Z");

  // markFinished normalises updated_at too.
  markFinished(task, "2026-01-01T00:02:00Z");
  assert.equal(task.updated_at, "2026-01-01T00:02:00.000Z");

  // markManualRunStarted likewise.
  markManualRunStarted(task, "2026-01-01T00:03:00Z");
  assert.equal(task.last_run_at, "2026-01-01T00:03:00.000Z");
  assert.equal(task.updated_at, "2026-01-01T00:03:00.000Z");

  // markStaleReclaimed normalises updated_at.
  markStaleReclaimed(task, "2026-01-01T00:10:00Z");
  assert.equal(task.updated_at, "2026-01-01T00:10:00.000Z");
});
