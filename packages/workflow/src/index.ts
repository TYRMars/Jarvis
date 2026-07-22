// @jarvis/workflow — declarative multi-step agent workflows.
// Value types + the WorkflowStore trait, ported from harness-workflow.
// Concrete store backends live in @jarvis/store; the runtime in @jarvis/server.
export {
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowStepKind,
  type JoinPolicy,
  DEFAULT_JOIN_POLICY,
  JOIN_POLICIES,
  joinPolicyFromWire,
  newWorkflowStep,
  newWorkflowDefinition,
  touchDefinition,
  agentStepCount,
  MAX_WORKFLOW_STEP_DEPTH,
} from "./definition.ts";
export {
  type WorkflowRun,
  type WorkflowStepResult,
  type WorkflowRunStatus,
  WORKFLOW_RUN_STATUSES,
  workflowRunStatusFromWire,
  workflowRunStatusIsTerminal,
  workflowStepResultOk,
  workflowStepResultFailed,
  newWorkflowRun,
  finishWorkflowRun,
  pushWorkflowStep,
} from "./run.ts";
export { type WorkflowStore, WorkflowError } from "./store.ts";
