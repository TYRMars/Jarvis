// @jarvis/jarvis-cli — terminal coding-agent. Drives @jarvis/core's Agent
// in-process (no HTTP). The bin entry is main.ts; this module re-exports the
// composable pieces for embedding / testing.
export {
  type CliConfig,
  type CliConfigOverrides,
  type ProviderKind,
  type PermissionMode,
  type MemoryMode,
  loadCliConfig,
  parsePermissionMode,
} from "./config.ts";
export {
  CODING_SYSTEM_PROMPT,
  buildAgent,
  buildProvider,
  buildTools,
  buildMemory,
  loadProjectContext,
  resolveSystemPrompt,
} from "./agent.ts";
export {
  type SessionPolicy,
  type SlashCommand,
  type ReplDeps,
  PolicyTable,
  ReadlineApprover,
  decisionForReply,
  parseSlashCommand,
  renderEvent,
  runTurn,
  runRepl,
  readlineInput,
  shortArgs,
} from "./repl.ts";
export { type ParsedArgs, parseArgs, runPipe, main } from "./main.ts";
