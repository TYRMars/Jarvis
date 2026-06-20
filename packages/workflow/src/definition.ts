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
 * Depth-first count of every leaf `agent` step. Used by REST validation to
 * reject empty recipes. Mirrors `WorkflowDefinition::agent_step_count`.
 */
export function agentStepCount(def: WorkflowDefinition): number {
  return walkAgentSteps(def.steps);
}

function walkAgentSteps(steps: WorkflowStep[]): number {
  let total = 0;
  for (const step of steps) {
    const kind = step.kind;
    if (kind.type === "agent") {
      total += 1;
    } else {
      // pipeline / phase / parallel all carry nested `steps`.
      total += walkAgentSteps(kind.steps);
    }
  }
  return total;
}
