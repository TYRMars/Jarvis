// WorkflowRun + WorkflowStepResult + WorkflowRunStatus.
// Ported from harness-workflow/src/lib.rs (the run subset).
//
// A WorkflowRun is one execution attempt against a WorkflowDefinition —
// sibling to RequirementRun, but multi-step: one WorkflowStepResult per leaf
// step executed. Status is a snake_case union; terminal status is sticky.
import { randomUUID } from "node:crypto";

import type { WorkflowStep } from "./definition.ts";

// ---------- WorkflowRunStatus ----------------------------------------------

/**
 * Lifecycle of a {@link WorkflowRun} (and the terminal state of a
 * {@link WorkflowStepResult}). Serialised snake_case.
 */
export type WorkflowRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

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

/**
 * Result of executing one leaf {@link WorkflowStep} within a
 * {@link WorkflowRun}.
 */
export interface WorkflowStepResult {
  /** The `WorkflowStep.id` this result corresponds to. */
  step_id: string;
  /**
   * Step label, denormalised so a client can render without the definition.
   */
  name: string;
  /** Terminal state of the step. */
  status: WorkflowRunStatus;
  /**
   * Conversation that drove the step (for drill-down). Absent for steps that
   * never reached the agent loop. (`skip_serializing_if = "Option::is_none"`.)
   */
  conversation_id?: string;
  /**
   * Final assistant text — also the handoff value for `{{ prev }}` /
   * `{{ outputs.<key> }}`. (`skip_serializing_if = "Option::is_none"`.)
   */
  output?: string;
  /** Error string if the step failed. (`skip_serializing_if`.) */
  error?: string;
}

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
 * One execution attempt against a {@link WorkflowDefinition}.
 *
 * Sibling to `RequirementRun`: that records one single-agent run; this
 * records a multi-step run, one {@link WorkflowStepResult} per leaf step
 * executed.
 */
export interface WorkflowRun {
  /** Stable identifier (UUID v4). */
  id: string;
  /** The definition this run executed. */
  workflow_id: string;
  /**
   * Optional Requirement this run was bound to. Absent for ad-hoc runs not
   * tied to a kanban card. (`skip_serializing_if = "Option::is_none"`.)
   */
  requirement_id?: string;
  /** Lifecycle state. */
  status: WorkflowRunStatus;
  /** Per-step results in execution order. `#[serde(default)]` → `[]`. */
  step_results: WorkflowStepResult[];
  /**
   * Free-form error string when the run failed before / between steps.
   * (`skip_serializing_if = "Option::is_none"`.)
   */
  error?: string;
  /** RFC-3339 timestamp of run creation. */
  started_at: string;
  /**
   * RFC-3339 timestamp of completion. Absent while in flight.
   * (`skip_serializing_if = "Option::is_none"`.)
   */
  finished_at?: string;
}

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
 * Mark the run finished (terminal status + `finished_at`). Terminal status is
 * sticky — a late call does not overwrite an existing terminal status.
 * Mirrors `WorkflowRun::finish`.
 */
export function finishWorkflowRun(run: WorkflowRun, status: WorkflowRunStatus): void {
  if (!workflowRunStatusIsTerminal(run.status)) {
    run.status = status;
  }
  run.finished_at = new Date().toISOString();
}

/** Append a step result. Mirrors `WorkflowRun::push_step`. */
export function pushWorkflowStep(run: WorkflowRun, result: WorkflowStepResult): void {
  run.step_results.push(result);
}
