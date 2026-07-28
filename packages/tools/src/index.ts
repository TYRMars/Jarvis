// @jarvis/tools — built-in Tool implementations + the default assembly entry
// point. Ported from crates/harness-tools/src/lib.rs.
//
// Read primitives are always on; write / exec primitives (`fs.write`,
// `fs.edit`, `fs.patch`, `shell.exec`) are opt-in + approval-gated. Call
// `registerBuiltins(registry, config)` to assemble the default set, or import
// individual tool classes for finer control.

// Sandbox helpers (owned by sandbox.ts; everyone imports them).
export { resolveUnder, SandboxError } from "./sandbox.ts";

// Assembly entry point.
export {
  type BuiltinsConfig,
  registerBuiltins,
  FS_DEFAULT_MAX_BYTES,
} from "./register-builtins.ts";

// Always-on, read-only tools.
export { EchoTool } from "./echo.ts";
export { TimeNowTool } from "./time.ts";
export { AskTextTool } from "./ask.ts";
export type { HitlKind, HitlOption, HitlRequest } from "./ask.ts";
export { PlanUpdateTool } from "./plan-update.ts";
export { ExitPlanTool } from "./exit-plan.ts";
export { EnterPlanModeTool } from "./enter-plan-mode.ts";

export { HttpFetchTool, HTTP_DEFAULT_MAX_BYTES } from "./http.ts";
export type { FetchImpl, FetchResponse, HttpFetchConfig } from "./http.ts";

export { CodeGrepTool } from "./grep.ts";
export type { CodeGrepOptions } from "./grep.ts";

export { GitStatusTool, GitDiffTool, GitLogTool, GitShowTool, gitTools } from "./git.ts";

export { WorkspaceContextTool } from "./workspace.ts";
export { ProjectChecksTool } from "./checks.ts";
export { TriageScanTool } from "./triage-scan.ts";

// Filesystem tools. Read primitives always on; write primitives gated.
export { FsReadTool, FsListTool, FsWriteTool, FsEditTool } from "./fs.ts";
export type { FsConfig } from "./fs.ts";
export { FsFindTool } from "./fs-find.ts";
export type { FsFindConfig } from "./fs-find.ts";
export { FsPatchTool } from "./patch.ts";

// Optional post-write diagnostics hook (LSP edit→verify loop). The composition
// root supplies an `@jarvis/lsp`-backed implementation via `BuiltinsConfig`.
export { withDiagnostics, type DiagnosticsHook } from "./diagnostics.ts";

// Shell execution. Opt-in + approval-gated.
export { ShellExecTool, SHELL_DEFAULT_MAX_BYTES, SHELL_DEFAULT_TIMEOUT_MS } from "./shell.ts";
export type { ShellExecConfig } from "./shell.ts";

// Store-backed Requirement kanban tools. Registered conditionally by
// `registerBuiltins` when both the `requirements` + `activities` stores are
// supplied; `requirement.review_verdict` is exported for reviewer-subagent
// registries but not part of the default set.
export {
  RequirementListTool,
  RequirementStartTool,
  RequirementBlockTool,
  RequirementCompleteTool,
  RequirementCreateTool,
  RequirementUpdateTool,
  RequirementDeleteTool,
  RequirementReviewVerdictTool,
  registerRequirementTools,
} from "./requirement-tools.ts";
export type { RequirementToolStores } from "./requirement-tools.ts";

// Store-backed Doc CRUD tools (`doc.{list,search,get,upsert,create,update,
// delete}` + `doc.draft.{get,save}`). Registered conditionally by
// `registerBuiltins` when the `docs` DocStore is supplied; the four mutators
// plus `doc.draft.save` are approval-gated.
export {
  DocListTool,
  DocSearchTool,
  DocGetTool,
  DocUpsertTool,
  DocCreateTool,
  DocUpdateTool,
  DocDeleteTool,
  DocDraftGetTool,
  DocDraftSaveTool,
  registerDocTools,
} from "./doc-tools.ts";
export type { DocToolStores } from "./doc-tools.ts";

// DDNS / remote-access tools (`ddns.{status,update,configure}`). Registered
// conditionally by `registerBuiltins` when a `DdnsRuntime` is supplied;
// `update` / `configure` are approval-gated.
export {
  DdnsStatusTool,
  DdnsUpdateTool,
  DdnsConfigureTool,
  registerDdnsTools,
} from "./ddns.ts";

// Store-backed row-based long-term Memory tools (`learning.memory.{list,add,
// update,delete}`). Registered conditionally by `registerBuiltins` when the
// `learningMemory` MemoryStore is supplied; `learning.memory.delete` is
// approval-gated.
export {
  LearningMemoryListTool,
  LearningMemoryAddTool,
  LearningMemoryUpdateTool,
  LearningMemoryDeleteTool,
  registerLearningMemoryTools,
} from "./learning-memory-tools.ts";
export type { LearningMemoryToolStores } from "./learning-memory-tools.ts";

// Agent `memory.*` markdown-memory tools (`memory.{list,read,write,delete}` +
// the include-directive tools `memory.{include_add,include_list,include_remove,
// include_refresh}`). Filesystem-based, no store — two scopes (workspace under
// `<workspaceRoot>/.jarvis/memory/`, optional user under `<userRoot>/...`).
// Registered conditionally by `registerBuiltins` when a memory workspace root
// is available; the mutating tools are approval-gated. Distinct from the
// row-based `learning.memory.*` surface.
export {
  MemoryListTool,
  MemoryReadTool,
  MemoryWriteTool,
  MemoryDeleteTool,
  MemoryIncludeAddTool,
  MemoryIncludeListTool,
  MemoryIncludeRemoveTool,
  MemoryIncludeRefreshTool,
  MemorySyncTool,
  MemorySyncSetupTool,
  MemoryICloudSetupTool,
  MemorySyncStatusTool,
  memorySyncBackendFromWire,
  icloudDriveRoot,
  icloudMemoryRoot,
  registerMemoryTools,
  renderCombinedList,
  readIndex,
  indexPath,
  validateSlug,
  validateGitUrl,
  parseIncludeTarget,
  parseIncludeDirectives,
  addIncludeLine,
  removeIncludeLine,
  directiveAsWire,
  directiveLabel,
  resolveInclude,
  refreshGitCache,
  MEMORY_DIR,
  MAX_ENTRY_BYTES,
  MAX_INDEX_BYTES,
  MAX_INDEX_LINES,
} from "./memory-tools.ts";
export type { MemoryToolsConfig, MemoryScope, IncludeDirective, MemorySyncBackend } from "./memory-tools.ts";

// Store-backed persistent workspace TODO board tools (`todo.{list,add,update,
// delete}`). Registered conditionally by `registerBuiltins` when the `todos`
// TodoStore is supplied; all four are ungated (`read`-category) — `todo.delete`
// relies on its input-schema cap for mass-delete protection, not approval.
export {
  TodoListTool,
  TodoAddTool,
  TodoUpdateTool,
  TodoDeleteTool,
  registerTodoTools,
} from "./todo-tools.ts";
export type { TodoToolStores } from "./todo-tools.ts";
