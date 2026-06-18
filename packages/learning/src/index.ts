// @jarvis/learning — self-improving-agent persistence surfaces.
//
// Ported from the harness-learning Rust crate (+ the MemoryStore guard /
// broadcast wrapper from harness-store/src/learning_guard.rs, folded into the
// MemoryStore backends here). Two foundational surfaces:
//   - Skill usage telemetry (Phase 0): SkillUsageEvent + SkillUsageStore.
//   - Long-term memory (Phase 1): MemoryItem + MemoryStore, with the
//     prompt-injection / credential / hide-from-user write-side guard.
// Plus the Phase-2 SkillLifecycle surface.

// ---------- event-source.ts ----------
export {
  type Unsubscribe,
  type EventListener,
  type EventSource,
  Fanout,
} from "./event-source.ts";

// ---------- skill-usage.ts ----------
export {
  type SkillSource,
  type SkillUsageAction,
  type SkillScope,
  type SkillUsageEvent,
  type SkillUsageRejection,
  type SkillUsageRow,
  type SkillUsageFilter,
  DEFAULT_SKILL_SOURCE,
  SKILL_NAME_CAP,
  SKILL_ATTRIBUTES_CAP,
  SkillUsageRejectionError,
  skillScopeUser,
  skillScopeProject,
  skillScopeWorkspace,
  skillScopeEq,
  viewedSkillUsageEvent,
  sanitizeSkillUsageEvent,
  foldEventsIntoRows,
  skillUsageEventMatches,
} from "./skill-usage.ts";

// ---------- skill-lifecycle.ts ----------
export {
  type SkillState,
  type SkillCreator,
  type SkillLifecycle,
  DEFAULT_SKILL_STATE,
  DEFAULT_SKILL_CREATOR,
  skillStateAsWire,
  skillCreatorMayMutate,
  newSkillLifecycle,
  pinnedSkillLifecycle,
  skillLifecycleCuratorArchivable,
} from "./skill-lifecycle.ts";

// ---------- memory.ts ----------
export {
  type MemoryScope,
  type MemoryKind,
  type MemorySource,
  type MemoryItem,
  type MemoryPatch,
  type MemoryFilter,
  type MemoryEvent,
  DEFAULT_MEMORY_KIND,
  MEMORY_TITLE_CAP,
  MEMORY_BODY_CAP,
  memoryScopeUser,
  memoryScopeProject,
  memoryScopeWorkspace,
  memoryScopeIsUser,
  memoryScopeEq,
  defaultMemorySource,
  clampMemoryFields,
  newMemoryItem,
  withMemoryTag,
  pinnedMemoryItem,
  withMemorySource,
  applyMemoryPatch,
  memoryItemMatches,
  memoryUpsertedEvent,
  memoryDeletedEvent,
} from "./memory.ts";

// ---------- validate.ts ----------
export {
  type MemoryRejection,
  MemoryRejectionError,
  MEMORY_TOTAL_SAFETY_CAP,
  validateMemorySafe,
} from "./validate.ts";

// ---------- store.ts (traits) ----------
export {
  type SkillUsageStore,
  type SkillLifecycleStore,
  type MemoryStore,
} from "./store.ts";

// ---------- backends ----------
export { JsonFileSkillUsageStore, MemorySkillUsageStore } from "./skill-usage-store.ts";
export {
  JsonFileSkillLifecycleStore,
  MemorySkillLifecycleStore,
} from "./skill-lifecycle-store.ts";
export { JsonFileMemoryStore, MemoryMemoryStore } from "./memory-store.ts";
