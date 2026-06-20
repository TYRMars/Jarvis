// @jarvis/server — Fastify HTTP server (chat + conversations).
export {
  type AppState,
  type ConnectorSecretResolver,
  type ProviderCatalog,
  type ProviderListEntry,
  isInternalId,
} from "./state.ts";
export { type ServeOptions, buildServer, serve } from "./server.ts";
export { registerChatRoutes } from "./chat-routes.ts";
export { registerConversationsRoutes } from "./conversations-routes.ts";
export { registerProjectsRoutes } from "./projects-routes.ts";
export { registerRequirementsRoutes } from "./requirements-routes.ts";
export { registerCommentsRoutes } from "./comments-routes.ts";
export { registerLabelsRoutes } from "./labels-routes.ts";
export { registerWorkRoutes } from "./work-routes.ts";
export { registerWorkflowRoutes } from "./workflow-routes.ts";
export {
  WorkflowRunGate,
  WorkflowRunPermit,
  InflightGuard,
  DEFAULT_WORKFLOW_MAX_CONCURRENT,
} from "./workflow-concurrency.ts";
export {
  type DriveWorkflowOptions,
  type WorkflowLogger,
  type ReaperHandle,
  driveWorkflow,
  failRunIfRunning,
  reapStaleWorkflowRuns,
  spawnWorkflowReaper,
  renderTemplate,
  DEFAULT_WORKFLOW_REAP_SECONDS,
} from "./workflow-runtime.ts";
export {
  type AutoMode,
  type AutoModeConfig,
  type AutoModeDeps,
  AutoModeRuntime,
  Semaphore,
  TimeoutError,
  autoModeFromWire,
  defaultAutoModeConfig,
  autoModeTick,
  driveOne,
  advanceCompletedRequirement,
  completedRequirementTargetStatus,
  cycleBlockedRequirementIds,
  consecutiveFailedSinceLastSuccess,
  mostRecentFailedRun,
  failureBackoffMs,
  failureBackoffRemainingMs,
  seedPrompt,
  recordActivity,
  recordBlockedOnce,
  withTimeout,
  spawnAutoModeLoop,
  registerAutoModeRoutes,
} from "./auto-mode.ts";
export {
  type WorktreeMode,
  type WorktreeOutcome,
  type WorktreeEntry,
  type OrphanWorktree,
  DEFAULT_WORKTREE_ROOT,
  worktreeModeFromWire,
  effectiveAutoMode,
  isGitRepo,
  isCleanCheckout,
  createWorktree,
  createWorktreeForBranch,
  removeWorktree,
  listWorktrees,
  detectOrphans,
  pruneWorktrees,
} from "./worktree.ts";
export { streamSse } from "./sse.ts";
export { registerSkillRoutes } from "./skill-routes.ts";
export { registerAutomationRoutes } from "./automation-routes.ts";
export {
  type AutomationLogger,
  type AutomationDeps,
  type AutomationSchedulerConfig,
  type RunTrigger,
  type TriggerOutcome,
  type SchedulerHandle,
  AutomationClaims,
  sharedAutomationClaims,
  SILENT_LOGGER,
  DEFAULT_AUTOMATION_TICK_SECONDS,
  DEFAULT_AUTOMATION_RUN_TIMEOUT_MS,
  RUNNING_STALE_MULTIPLIER,
  isRunning,
  automationTick,
  runAutomation,
  triggerAutomationNow,
  spawnAutomationLoop,
} from "./automation-runtime.ts";
export { registerObservabilityRoutes } from "./observability-routes.ts";
export {
  type MemoryStatsProvider,
  type OrphanWorktree as DiagnosticsOrphanWorktree,
  type CleanupReport,
  type StuckRun,
  findOrphanWorktrees,
  removeOrphanWorktrees,
  stuckRuns,
  recentRuns,
  recentFailures,
  registerDiagnosticsRoutes,
} from "./diagnostics-routes.ts";
export {
  type ModelCapabilityLike,
  type ProviderDef,
  type ProviderSnapshot,
  type ProviderInfo,
  type ProvisionErrorKind,
  type ProviderAdmin,
  ProvisionError,
  registerProviderAdminRoutes,
} from "./provider-admin-routes.ts";
export { registerLearningRoutes } from "./learning-routes.ts";
export { registerSubagentsRoutes } from "./subagents-routes.ts";
export { registerChannelsRoutes } from "./channels-routes.ts";
export { registerDocRoutes } from "./doc-routes.ts";
export { registerMemoriesRoutes } from "./memories-routes.ts";
export {
  type PermissionMode,
  type Decision,
  type Scope,
  type HitSource,
  type RuleHit,
  type ScopedRule,
  type PermissionRule,
  type PermissionTable,
  type PermissionStore,
  type ModeHandle,
  PERMISSION_MODES,
  OUT_OF_BOUNDS,
  MemoryPermissionStore,
  RuleApprover,
  parsePermissionMode,
  wholeToolRule,
  withMatcher,
  ruleMatches,
  emptyTable,
  evaluateTable,
  globMatch,
  modeDefault,
  registerPermissionsRoutes,
} from "./permissions-routes.ts";
export { registerPluginsRoutes } from "./plugins-routes.ts";
export { registerAgentProfilesRoutes } from "./agent-profiles-routes.ts";
export { registerTodosRoutes } from "./todos-routes.ts";
export { registerWorkspaceRoutes } from "./workspace-routes.ts";
export { registerWorkspaceTerminalRoutes } from "./workspace-terminal-routes.ts";
export { registerWorkspacesRoutes } from "./workspaces-routes.ts";
export { registerConnectorsRoutes } from "./connectors-routes.ts";
export {
  type TaskKind,
  type TaskEntry,
  type TasksResponse,
  collectTasks,
  registerTasksRoutes,
} from "./tasks-routes.ts";
export { registerToolsRoutes } from "./tools-routes.ts";
export { type RegisterUiOptions, registerUiRoutes, pathLooksLikeAsset } from "./ui.ts";
export {
  type OAuthStateClaims,
  type ChannelInboundHandler,
  registerChannelsInboundRoutes,
  wecomSignature,
  constantTimeEq,
  extractTag,
  decryptAesPayload,
  parseInboundXml,
  makeOAuthState,
  verifyOAuthState,
  oauthAuthorizeUrl,
  urlencodingMinimal,
  packCtx,
  unpackCtx,
  isSafeNextUrl,
  renderSuccessPage,
} from "./channels-inbound-routes.ts";
