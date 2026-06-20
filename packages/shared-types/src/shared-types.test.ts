// Compile-time + smoke coverage for the wire types. There is no runtime to
// exercise (the package is type-only), so these tests pin the wire SHAPE:
// constructing a value of each interface is itself a type assertion, and the
// `node:assert` checks guard against a field being silently dropped/renamed.
import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ChannelInstance,
  ChannelMessageFormat,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepResult,
} from "./index.ts";

test("ChannelInstance wire shape (config is an opaque object)", () => {
  const inst: ChannelInstance = {
    id: "c1",
    kind: "wecom_webhook",
    display_name: "prod-alerts",
    status: "unconfigured",
    config: { webhook_url: "${env:WECOM_URL}" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  assert.equal(inst.config["webhook_url"], "${env:WECOM_URL}");
  const fmt: ChannelMessageFormat = "markdown";
  assert.equal(fmt, "markdown");
});

test("WorkflowDefinition omits optional fields when absent", () => {
  const def: WorkflowDefinition = {
    id: "w1",
    name: "review",
    steps: [{ id: "s1", name: "scan", kind: { type: "agent", prompt: "go" } }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  assert.equal("project_id" in def, false);
  assert.equal(def.steps[0]?.kind.type, "agent");
});

test("WorkflowStepResult/Run keep snake_case wire fields", () => {
  const result: WorkflowStepResult = { step_id: "s1", name: "scan", status: "succeeded", output: "ok" };
  const run: WorkflowRun = {
    id: "r1",
    workflow_id: "w1",
    status: "running",
    step_results: [result],
    started_at: "2026-01-01T00:00:00Z",
  };
  assert.equal(run.step_results[0]?.step_id, "s1");
  assert.equal("conversation_id" in result, false);
});
