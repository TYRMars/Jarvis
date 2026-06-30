import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finishRequirementRun,
  newRequirementRun,
  pushRequirementRunLog,
  requirementRunEventRunId,
  requirementRunStatusFromWire,
  requirementRunStatusIsTerminal,
  type RequirementRun,
  type RequirementRunEvent,
  type VerificationPlan,
} from "./requirement-run.ts";

test("run status enum<->wire mapping and terminal classification", () => {
  for (const s of ["pending", "running", "completed", "failed", "cancelled"] as const) {
    assert.equal(requirementRunStatusFromWire(s), s);
  }
  assert.equal(requirementRunStatusFromWire("nonsense"), undefined);
  assert.equal(requirementRunStatusIsTerminal("pending"), false);
  assert.equal(requirementRunStatusIsTerminal("running"), false);
  assert.equal(requirementRunStatusIsTerminal("completed"), true);
  assert.equal(requirementRunStatusIsTerminal("failed"), true);
  assert.equal(requirementRunStatusIsTerminal("cancelled"), true);
});

test("newRequirementRun mints uuid and pending status", () => {
  const r = newRequirementRun("req-1", "conv-1");
  assert.equal(r.id.length, 36);
  assert.equal(r.requirement_id, "req-1");
  assert.equal(r.conversation_id, "conv-1");
  assert.equal(r.status, "pending");
  assert.equal(r.finished_at, undefined);
});

test("finish sets terminal status + finished_at; terminal is sticky", () => {
  const r = newRequirementRun("req", "conv");
  finishRequirementRun(r, "completed");
  assert.equal(r.status, "completed");
  assert.notEqual(r.finished_at, undefined);

  const r2 = newRequirementRun("req", "conv");
  finishRequirementRun(r2, "failed");
  const saved = r2.status;
  const savedFinishedAt = r2.finished_at;
  finishRequirementRun(r2, "completed");
  assert.equal(r2.status, saved, "late finish must not overwrite a terminal status");
  assert.equal(
    r2.finished_at,
    savedFinishedAt,
    "late finish must not re-stamp finished_at (would inflate run duration)",
  );
});

test("pushRequirementRunLog lazily creates the logs array", () => {
  const r = newRequirementRun("req", "conv");
  const startsEmpty = r.logs === undefined;
  assert.equal(startsEmpty, true);
  pushRequirementRunLog(r, "info", "started");
  const afterFirst = r.logs ?? [];
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].level, "info");
  assert.equal(afterFirst[0].data, undefined);
  pushRequirementRunLog(r, "error", "boom", { code: 1 });
  const afterSecond = r.logs ?? [];
  assert.equal(afterSecond.length, 2);
  assert.deepEqual(afterSecond[1].data, { code: 1 });
});

test("wire shape: empty logs + unset options omitted on a fresh run", () => {
  const r = newRequirementRun("req", "conv");
  const json = JSON.stringify(r);
  assert.ok(!json.includes("logs"));
  assert.ok(!json.includes("summary"));
  assert.ok(!json.includes("error"));
  assert.ok(!json.includes("verification"));
  assert.ok(!json.includes("worktree_path"));
  assert.ok(!json.includes("usage"));
  assert.ok(!json.includes("model"));
  assert.ok(!json.includes("finished_at"));
  // Required fields present.
  assert.ok(json.includes('"status":"pending"'));
  assert.ok(json.includes('"started_at"'));
});

test("VerificationPlan: default flags omitted, commands present", () => {
  const plan: VerificationPlan = { commands: ["cargo test"] };
  const json = JSON.stringify(plan);
  assert.ok(!json.includes("require_diff"));
  assert.ok(!json.includes("require_tests"));
  assert.ok(!json.includes("require_human_review"));
  assert.ok(json.includes('"commands"'));
});

test("full run record round-trips through JSON", () => {
  const r = newRequirementRun("req-7", "conv-7");
  r.summary = "changed serializer";
  r.status = "completed";
  r.verification = {
    status: "passed",
    command_results: [
      { command: "cargo test", exit_code: 0, stdout: "ok", duration_ms: 1234 },
    ],
    diff_summary: " 1 file changed",
  };
  r.finished_at = "2026-04-30T01:23:45+00:00";
  const back = JSON.parse(JSON.stringify(r)) as RequirementRun;
  assert.deepEqual(back, r);
});

test("RequirementRunEvent: started/finished flatten the run; verified carries run_id", () => {
  const r = newRequirementRun("req-1", "conv-1");
  const started: RequirementRunEvent = { type: "started", ...r };
  assert.ok(JSON.stringify(started).includes('"type":"started"'));
  assert.equal(requirementRunEventRunId(started), r.id);

  finishRequirementRun(r, "completed");
  const finished: RequirementRunEvent = { type: "finished", ...r };
  assert.ok(JSON.stringify(finished).includes('"status":"completed"'));

  const verified: RequirementRunEvent = {
    type: "verified",
    run_id: "run-7",
    result: { status: "passed", command_results: [] },
  };
  assert.equal(requirementRunEventRunId(verified), "run-7");
});
