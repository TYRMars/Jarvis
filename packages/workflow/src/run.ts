// WorkflowRun runtime helpers (constructors / transitions).
//
// The wire TYPES (WorkflowRun / WorkflowStepResult / WorkflowRunStatus) are the
// single source of truth in @jarvis/shared-types — this module re-exports them
// and owns the runtime behaviour. Ported from harness-workflow/src/lib.rs (the
// run subset).
//
// A WorkflowRun is one execution attempt against a WorkflowDefinition —
// sibling to RequirementRun, but multi-step: one WorkflowStepResult per leaf
// step executed. Status is a snake_case union; terminal status is sticky.
import { randomUUID } from "node:crypto";

import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepResult,
} from "@jarvis/shared-types";

export type { WorkflowRun, WorkflowRunStatus, WorkflowStepResult };

// ---------- WorkflowRunStatus ----------------------------------------------

/** Every valid {@link WorkflowRunStatus} wire string. */
export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

/**
 * Parse a wire string into a {@link WorkflowRunStatus}. `undefined` for
 * unrecognised values. Mirrors `WorkflowRunStatus::from_wire`.
 */
export function workflowRunStatusFromWire(s: string): WorkflowRunStatus | undefined {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(s)
    ? (s as WorkflowRunStatus)
    : undefined;
}

/** Terminal states cannot transition further. Mirrors `is_terminal`. */
export function workflowRunStatusIsTerminal(status: WorkflowRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

// ---------- WorkflowStepResult ---------------------------------------------

/** A successful step result. Mirrors `WorkflowStepResult::ok`. */
export function workflowStepResultOk(
  step: WorkflowStep,
  conversationId: string | undefined,
  output: string,
): WorkflowStepResult {
  const result: WorkflowStepResult = {
    step_id: step.id,
    name: step.name,
    status: "succeeded",
    output,
  };
  if (conversationId !== undefined) result.conversation_id = conversationId;
  return result;
}

/** A failed step result. Mirrors `WorkflowStepResult::failed`. */
export function workflowStepResultFailed(
  step: WorkflowStep,
  conversationId: string | undefined,
  error: string,
): WorkflowStepResult {
  const result: WorkflowStepResult = {
    step_id: step.id,
    name: step.name,
    status: "failed",
    error,
  };
  if (conversationId !== undefined) result.conversation_id = conversationId;
  return result;
}

// ---------- WorkflowRun ----------------------------------------------------

/**
 * Mint a new run with a fresh UUID, current timestamp, and status `running`
 * (runs are dispatched immediately). Mirrors `WorkflowRun::new`. Pass
 * `undefined` for `requirementId` for ad-hoc runs.
 */
export function newWorkflowRun(
  workflowId: string,
  requirementId: string | undefined,
): WorkflowRun {
  const run: WorkflowRun = {
    id: randomUUID(),
    workflow_id: workflowId,
    status: "running",
    step_results: [],
    started_at: new Date().toISOString(),
  };
  if (requirementId !== undefined) run.requirement_id = requirementId;
  return run;
}

/**
 * Mark the run finished (terminal status + `finished_at`). The first terminal
 * transition wins for BOTH fields — a late or duplicate call (e.g. the
 * stale-run reaper firing after the run already finished in-process) does not
 * overwrite the status or move `finished_at` to a later wall-clock time (which
 * would skew the recorded duration). Mirrors `WorkflowRun::finish`.
 */
export function finishWorkflowRun(run: WorkflowRun, status: WorkflowRunStatus): void {
  if (!workflowRunStatusIsTerminal(run.status)) {
    run.status = status;
    run.finished_at = new Date().toISOString();
  }
}

/** Append a step result. Mirrors `WorkflowRun::push_step`. */
export function pushWorkflowStep(run: WorkflowRun, result: WorkflowStepResult): void {
  run.step_results.push(result);
}
