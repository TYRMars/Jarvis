// @jarvis/jarvis-app — composition root. Re-exports the pieces the orchestrator
// (and tests) wire together: env → config, config → provider, config+stores →
// tools, config+provider+stores → AppState. The bin entry is main.ts.
export {
  type JarvisConfig,
  type ProviderKind,
  type PermissionModeName,
  type MemoryMode,
  type WorkMode,
  type McpServerSpec,
  type RouterConfigParsed,
  type ToolGating,
  loadConfig,
  defaultModel,
  parseAddr,
  parseComposioMcpServer,
  parseMcpServers,
} from "./config.ts";

export {
  ConversationSummaryStore,
  persistKey,
} from "./summary-store.ts";

export {
  type BuildProviderDeps,
  buildProvider,
  buildRawProvider,
  buildSmartRouter,
  capabilityCatalog,
  wrapWithCapabilities,
  resolveCodexAuth,
} from "./provider.ts";

export {
  type ToolRegistryBundle,
  type BuildToolsDeps,
  buildToolRegistry,
  codingMode,
} from "./tools.ts";

export {
  type ToolStores,
  type BuildAppStateDeps,
  type AppStateBundle,
  CODING_SYSTEM_PROMPT,
  GENERAL_SYSTEM_PROMPT,
  buildAppState,
  buildMemory,
  buildProviderCatalog,
  loadProjectContext,
  resolveSystemPrompt,
} from "./state.ts";

export {
  type ParsedArgs,
  type Subcommand,
  parseCliArgs,
  applyArgs,
  resolveDbUrl,
  openStores,
  main,
} from "./main.ts";
