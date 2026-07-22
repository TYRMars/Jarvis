// @jarvis/store — ConversationStore + domain-store backends + connect(url).
export {
  type ConversationLifecycle,
  type ConversationMetadata,
  type ConversationRecord,
  type ConversationStore,
  ConversationStoreBase,
  StoreError,
  defaultMetadata,
} from "./types.ts";
export { JsonFileConversationStore, encodeId, encodeSegment, atomicWrite, ensureDir } from "./json-file.ts";
export { MemoryConversationStore } from "./memory.ts";
export { connect, connectAll, makeMemoryStores, type StoreBundle } from "./connect.ts";

// ---------- SQLite backends (better-sqlite3, P6.7) ----------
export {
  openSqlite,
  resolveSqlitePath,
  SqliteConversationStore,
  SqliteProjectStore,
  SqliteRequirementStore,
  SqliteRequirementRunStore,
  SqliteActivityStore,
  SqliteCommentStore,
  SqliteLabelStore,
  SqliteDocStore,
  SqliteProjectMemoryStore,
  SqliteWorkflowStore,
} from "./sqlite.ts";

// ---------- domain-store backends ----------
export { JsonFileProjectStore, MemoryProjectStore } from "./project-store.ts";
export {
  JsonFileRequirementStore,
  MemoryRequirementStore,
} from "./requirement-store.ts";
export {
  JsonFileRequirementRunStore,
  MemoryRequirementRunStore,
  classifyRunEvent,
} from "./requirement-run-store.ts";
export { JsonFileActivityStore, MemoryActivityStore } from "./activity-store.ts";
export { JsonFileCommentStore, MemoryCommentStore } from "./comment-store.ts";
export { JsonFileLabelStore, MemoryLabelStore } from "./label-store.ts";
export { JsonFileDocStore, MemoryDocStore } from "./doc-store.ts";
export {
  JsonFileProjectMemoryStore,
  MemoryProjectMemoryStore,
} from "./project-memory-store.ts";
export { JsonFileWorkflowStore, MemoryWorkflowStore } from "./workflow-store.ts";
export {
  JsonFileWorkspaceStore,
  MemoryWorkspaceStore,
  SqliteWorkspaceStore,
  MAX_RECENT,
  type WorkspaceEntry,
  type WorkspaceStore,
} from "./workspace-store.ts";
