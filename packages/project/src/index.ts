// @jarvis/project — Project domain value types + *Store traits.
//
// Ported from the harness-project Rust crate. The "Work" feature: kanban
// (Project / Requirement / RequirementRun), audit timeline (Activity),
// discussion (Comment), Labels, Docs (DocProject / DocDraft), and
// project-scoped Memory — plus the 8 store-trait interfaces.

// ---------- project.ts ----------
export {
  type Project,
  type ProjectWorkspace,
  type ProjectAutomation,
  type KanbanColumn,
  newProject,
  newProjectWorkspace,
  defaultProjectAutomation,
  automationIsDefault,
  defaultKanbanColumns,
  validateColumnId,
  validateSlug,
  deriveSlug,
  touchProject,
  setProjectSlug,
  setProjectName,
  setProjectDescription,
  setProjectInstructions,
  setProjectTags,
  setProjectWorkspaces,
  setProjectAutomation,
  archiveProject,
  unarchiveProject,
  projectToWire,
} from "./project.ts";

// ---------- requirement.ts ----------
export {
  type Requirement,
  type RequirementStatus,
  type RequirementTodo,
  type RequirementTodoKind,
  type RequirementTodoStatus,
  type RequirementTodoCreator,
  type RequirementTodoEvidence,
  type TriageState,
  type AcceptancePolicy,
  type RequirementEvent,
  type RequirementWire,
  DEFAULT_TRIAGE_STATE,
  DEFAULT_ACCEPTANCE_POLICY,
  newRequirement,
  newRequirementTodo,
  touchRequirement,
  touchRequirementTodo,
  linkConversation,
  validateNoSelfDependency,
  ensureExecutionChecklist,
  executionChecklistPassed,
  executionChecklistFailedOrBlocked,
  executionChecklistIsDefaultSeeded,
  requirementToWire,
  requirementStatusFromWire,
  requirementTodoKindFromWire,
  requirementTodoStatusFromWire,
  requirementTodoCreatorFromWire,
  triageStateFromWire,
  triageStateIsDefault,
  triageStateNeedsTriage,
  acceptancePolicyFromWire,
  acceptancePolicyIsDefault,
  requirementUpsertedEvent,
  requirementDeletedEvent,
  requirementEventProjectId,
} from "./requirement.ts";

// ---------- requirement-run.ts ----------
export {
  type RequirementRun,
  type RequirementRunStatus,
  type RequirementRunLog,
  type RequirementRunLogLevel,
  type VerificationPlan,
  type VerificationResult,
  type VerificationStatus,
  type CommandResult,
  type RequirementRunEvent,
  newRequirementRun,
  finishRequirementRun,
  pushRequirementRunLog,
  requirementRunStatusFromWire,
  requirementRunStatusIsTerminal,
  requirementRunEventRunId,
} from "./requirement-run.ts";

// ---------- activity.ts ----------
export {
  type Activity,
  type ActivityKind,
  type ActivityActor,
  type ActivityEvent,
  newActivity,
  activityKindFromWire,
  activityEventRequirementId,
} from "./activity.ts";

// ---------- comment.ts ----------
export {
  type Comment,
  type CommentEvent,
  newComment,
  replyComment,
  editComment,
  commentEventRequirementId,
} from "./comment.ts";

// ---------- label.ts ----------
export {
  type Label,
  type LabelEvent,
  type LabelValidation,
  MAX_LABEL_NAME_LEN,
  newLabel,
  touchLabel,
  validateLabelName,
  validateLabelColour,
  labelEventProjectId,
} from "./label.ts";

// ---------- doc.ts ----------
export {
  type DocProject,
  type DocDraft,
  type DocKind,
  type DocEvent,
  newDocProject,
  newDocDraft,
  touchDocProject,
  touchDocDraft,
  docKindFromWire,
  docEventWorkspace,
} from "./doc.ts";

// ---------- project-memory.ts ----------
export {
  type ProjectMemory,
  type ProjectMemoryKind,
  PROJECT_MEMORY_BODY_CAP,
  PROJECT_MEMORY_TITLE_CAP,
  newProjectMemory,
  withProjectMemorySource,
  withProjectMemoryTags,
  touchProjectMemory,
} from "./project-memory.ts";

// ---------- store.ts ----------
export {
  type Unsubscribe,
  type EventListener,
  type EventSource,
  type ProjectStore,
  type RequirementStore,
  type RequirementRunStore,
  type ActivityStore,
  type CommentStore,
  type LabelStore,
  type DocStore,
  type ProjectMemoryStore,
  docStoreLatestDraft,
} from "./store.ts";
