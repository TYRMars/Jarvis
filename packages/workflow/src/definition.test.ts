import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_JOIN_POLICY,
  agentStepCount,
  joinPolicyFromWire,
  newWorkflowDefinition,
  newWorkflowStep,
  touchDefinition,
  type WorkflowDefinition,
  type WorkflowStepKind,
} from "./definition.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sampleDefinition(): WorkflowDefinition {
  const def = newWorkflowDefinition("ship-feature");
  def.description = "research → implement → verify";
  def.steps = [
    newWorkflowStep("research", {
      type: "agent",
      prompt: "Investigate the codebase",
      output_key: "research",
    }),
    newWorkflowStep("build", {
      type: "phase",
      title: "Implement",
      steps: [
        newWorkflowStep("edit", {
          type: "agent",
          prompt: "Apply the change using {{ outputs.research }}",
          model: "gpt-4o",
        }),
      ],
    }),
    newWorkflowStep("verify", {
      type: "parallel",
      steps: [
        newWorkflowStep("tests", { type: "agent", prompt: "Run the tests" }),
        newWorkflowStep("review", {
          type: "agent",
          prompt: "Review the diff",
          subagent: "review",
        }),
      ],
      join: "best_effort",
    }),
  ];
  return def;
}

test("newWorkflowDefinition sets a fresh uuid, empty steps, equal timestamps", () => {
  const def = newWorkflowDefinition("recipe");
  assert.match(def.id, UUID_RE);
  assert.equal(def.name, "recipe");
  assert.deepEqual(def.steps, []);
  assert.equal(def.created_at, def.updated_at);
  assert.equal(def.project_id, undefined);
  assert.equal(def.description, undefined);
});

test("newWorkflowStep mints a fresh id", () => {
  const a = newWorkflowStep("s", { type: "agent", prompt: "p" });
  const b = newWorkflowStep("s", { type: "agent", prompt: "p" });
  assert.match(a.id, UUID_RE);
  assert.notEqual(a.id, b.id);
});

test("touchDefinition bumps updated_at", () => {
  const def = newWorkflowDefinition("recipe");
  def.updated_at = "2025-01-01T00:00:00.000Z";
  touchDefinition(def);
  assert.notEqual(def.updated_at, "2025-01-01T00:00:00.000Z");
  // created_at is untouched.
  assert.equal(def.created_at, def.created_at);
});

test("definition round-trips through JSON", () => {
  const def = sampleDefinition();
  const json = JSON.stringify(def);
  const back = JSON.parse(json) as WorkflowDefinition;
  assert.deepEqual(back, def);
});

test("agentStepCount walks nested groups", () => {
  // research (1) + phase>edit (1) + parallel>{tests,review} (2) = 4
  assert.equal(agentStepCount(sampleDefinition()), 4);
});

test("agentStepCount is crash-proof on unvalidated wire input", () => {
  // Unvalidated JSON from POST /v1/workflows: a container kind missing its
  // `steps` array, and an unknown kind. Must count 0 leaves, never throw a 500.
  const def = newWorkflowDefinition("bad");
  def.steps = [
    { id: "1", name: "s", kind: { type: "phase", title: "t" } as unknown as WorkflowStepKind },
    { id: "2", name: "u", kind: { type: "bogus" } as unknown as WorkflowStepKind },
  ];
  assert.equal(agentStepCount(def), 0);

  // Pathologically deep nesting is depth-capped rather than blowing the stack.
  let kind: WorkflowStepKind = { type: "agent", prompt: "leaf" };
  for (let i = 0; i < 5000; i++) {
    kind = { type: "pipeline", steps: [{ id: String(i), name: `p${i}`, kind }] };
  }
  const deep = newWorkflowDefinition("deep");
  deep.steps = [{ id: "root", name: "root", kind }];
  assert.doesNotThrow(() => agentStepCount(deep));
});

test("step kind is tagged on type, optionals skipped when absent", () => {
  const kind: WorkflowStepKind = { type: "agent", prompt: "do it" };
  const v = JSON.parse(JSON.stringify(kind)) as Record<string, unknown>;
  assert.equal(v["type"], "agent");
  assert.equal(v["prompt"], "do it");
  // Optional fields are skipped when absent.
  assert.equal("subagent" in v, false);
  assert.equal("model" in v, false);
  assert.equal("output_key" in v, false);
});

test("parallel join defaults via DEFAULT_JOIN_POLICY", () => {
  // A parallel block constructed with the default join uses all_required.
  assert.equal(DEFAULT_JOIN_POLICY, "all_required");
  const kind: WorkflowStepKind = {
    type: "parallel",
    steps: [],
    join: DEFAULT_JOIN_POLICY,
  };
  assert.equal(kind.type === "parallel" && kind.join, "all_required");
});

test("legacy definition without optional fields decodes (defaults applied)", () => {
  // Minimal row: no project_id / description; steps default to [].
  const raw = JSON.parse(
    JSON.stringify({
      id: "wf-legacy",
      name: "Old recipe",
      steps: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    }),
  ) as WorkflowDefinition;
  assert.equal(raw.project_id, undefined);
  assert.equal(raw.description, undefined);
  assert.deepEqual(raw.steps, []);
});

test("joinPolicy wire round-trips; unknown rejected", () => {
  for (const p of ["all_required", "best_effort"] as const) {
    assert.equal(joinPolicyFromWire(p), p);
  }
  assert.equal(joinPolicyFromWire("nonsense"), undefined);
});
