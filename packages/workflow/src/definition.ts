// WorkflowDefinition runtime helpers (constructors / validators).
//
// The wire TYPES (WorkflowDefinition / WorkflowStep / WorkflowStepKind /
// JoinPolicy) are the single source of truth in @jarvis/shared-types — this
// module re-exports them and owns the runtime behaviour. Ported from
// harness-workflow/src/lib.rs (the definition subset).
//
// A WorkflowDefinition is a reusable, multi-step agent recipe: an ordered list
// of WorkflowSteps a server-side runtime executes by driving the agent loop.
// The step vocabulary mirrors Claude Code's Workflow primitives:
//
//   - Agent    ≈ agent(prompt, …)  — one agent step.
//   - Pipeline ≈ pipeline(…)       — sequential, output of step N threads
//                                     into step N+1.
//   - Phase    ≈ phase(title)      — labelled sequential group (progress
//                                     boundary).
//   - Parallel ≈ parallel([…])     — fan-out with a join policy.
import { randomUUID } from "node:crypto";

import type {
  JoinPolicy,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from "@jarvis/shared-types";

export type { JoinPolicy, WorkflowDefinition, WorkflowStep, WorkflowStepKind };

// ---------- JoinPolicy -----------------------------------------------------

/** Default `JoinPolicy` — `#[default] AllRequired`. */
export const DEFAULT_JOIN_POLICY: JoinPolicy = "all_required";

/** Every valid {@link JoinPolicy} wire string. */
export const JOIN_POLICIES: readonly JoinPolicy[] = ["all_required", "best_effort"];

/**
 * Parse a wire string into a {@link JoinPolicy}. `undefined` for unrecognised
 * values (REST handlers turn that into a 400). Mirrors `JoinPolicy::from_wire`.
 */
export function joinPolicyFromWire(s: string): JoinPolicy | undefined {
  return s === "all_required" || s === "best_effort" ? s : undefined;
}

// ---------- WorkflowStep ---------------------------------------------------

/** Mint a step with a fresh id. Mirrors `WorkflowStep::new`. */
export function newWorkflowStep(name: string, kind: WorkflowStepKind): WorkflowStep {
  return { id: randomUUID(), name, kind };
}

// ---------- WorkflowDefinition ---------------------------------------------

/**
 * Mint a new definition with a fresh UUID and current timestamps.
 * Mirrors `WorkflowDefinition::new`.
 */
export function newWorkflowDefinition(name: string): WorkflowDefinition {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    steps: [],
    created_at: now,
    updated_at: now,
  };
}

/** Bump `updated_at` to "now". Mirrors `WorkflowDefinition::touch`. */
export function touchDefinition(def: WorkflowDefinition): void {
  def.updated_at = new Date().toISOString();
}

/**
 * Maximum step-nesting depth. Container kinds (`pipeline`/`phase`/`parallel`)
 * nest recursively; the walkers here (and the REST-boundary `validateStepKinds`)
 * cap depth at this so an attacker-controlled deeply-nested tree from
 * `POST /v1/workflows` can't blow the stack with a `RangeError`.
 */
export const MAX_WORKFLOW_STEP_DEPTH = 64;

/**
 * Depth-first count of every leaf `agent` step. Used by REST validation to
 * reject empty recipes. Mirrors `WorkflowDefinition::agent_step_count`.
 *
 * Defensive: the input can be unvalidated JSON from the wire, so a container
 * kind with a missing/non-array `steps` counts as zero leaves (the caller's
 * `validateStepKinds` reports the real 400) rather than throwing a 500, and
 * recursion is depth-capped.
 */
export function agentStepCount(def: WorkflowDefinition): number {
  return walkAgentSteps(def.steps, 0);
}

function walkAgentSteps(steps: WorkflowStep[], depth: number): number {
  if (!Array.isArray(steps) || depth > MAX_WORKFLOW_STEP_DEPTH) return 0;
  let total = 0;
  for (const step of steps) {
    const kind = step.kind;
    if (kind.type === "agent") {
      total += 1;
    } else {
      // pipeline / phase / parallel all carry nested `steps`.
      total += walkAgentSteps((kind as { steps?: WorkflowStep[] }).steps ?? [], depth + 1);
    }
  }
  return total;
}
