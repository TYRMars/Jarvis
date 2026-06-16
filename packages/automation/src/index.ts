// @jarvis/automation — AutomationTask + ScheduleSpec (one-time / interval) +
// AutomationStore trait, with JSON-file + in-memory backends. Ported from
// crates/harness-automation/src/lib.rs.
export {
  type AutomationTask,
  type NewAutomationTask,
  type ScheduleSpec,
  type AutomationStatus,
  type AutomationRunStatus,
  DEFAULT_AUTOMATION_STATUS,
  scheduleOnce,
  scheduleInterval,
  newAutomationTask,
  isDueAt,
  markRunning,
  markManualRunStarted,
  markFinished,
  recomputeNextRun,
  isStaleRunning,
  markStaleReclaimed,
  scheduleNextAfter,
  parseTimestamp,
  toRfc3339,
} from "./task.ts";
export { type AutomationStore } from "./store.ts";
export { JsonFileAutomationStore, MemoryAutomationStore } from "./automation-store.ts";
