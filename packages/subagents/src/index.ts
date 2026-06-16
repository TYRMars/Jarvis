// @jarvis/subagents — SubAgent trait + registry + built-in subagents
// (review / read_doc / codex / claude_code / batch), the subagent event
// channel + session-workspace seams, a `subagentTools` helper returning the
// `subagent.<name>` Tool adapters, and a runs-ledger store (JsonFile + Memory).
//
// Ported from the harness-subagents Rust crate (trait/registry/built-ins) +
// harness-core::subagent (frame stream) + harness-server::subagent_runs
// (ledger). Anything not yet portable (the @jarvis/core Agent loop's subagent
// channel + session-workspace task-locals, the inner-agent provider/tools
// wiring) is reached through injectable seams: the channel/workspace helpers
// are defined locally (a later @jarvis/core port can adopt them verbatim), and
// the internal subagents take a `createAgent` factory.

// ---------- subagent.ts: trait + registry + channel + workspace seam ----------
export {
  type SubAgent,
  type SubAgentInput,
  type SubAgentOutput,
  type Artifact,
  type SubAgentFrame,
  type SubAgentEvent,
  type SubAgentSink,
  SubAgentRegistry,
  subAgentRequiresApproval,
  emitSubagent,
  subagentActive,
  activeSender,
  withSubagent,
  activeWorkspace,
  activeWorkspaceOr,
  withSessionWorkspace,
} from "./subagent.ts";

// ---------- internal.ts: internal-loop runner + injectable seam ----------
export {
  InternalSubAgent,
  type InternalSubAgentConfig,
  type CreateAgent,
  type CreateAgentOptions,
  type SubAgentRunner,
} from "./internal.ts";

// ---------- built-in subagents ----------
export { EchoSubAgent } from "./echo.ts";
export * as reviewer from "./reviewer.ts";
export * as docReader from "./doc-reader.ts";
export * as codex from "./codex.ts";
export {
  ClaudeCodeSubAgent,
  type ClaudeCodeConfig,
  defaultClaudeCodeConfig,
  probe as probeClaudeCode,
  parseSdkMessage,
  stringifyToolResult,
  DESCRIPTION as CLAUDE_CODE_DESCRIPTION,
} from "./claude-code.ts";

// ---------- batch + tool adapters ----------
export { SubAgentBatchTool, DEFAULT_MAX_CONCURRENCY, type JoinStrategy } from "./batch.ts";
export { SubAgentTool } from "./tool-adapter.ts";
export { subagentTools, type SubagentToolsOptions } from "./subagent-tools.ts";

// ---------- runs ledger ----------
export {
  type SubAgentRunStore,
  type SubAgentRunRecord,
  type SubAgentRunStatus,
  type SubAgentEventRecord,
  MemorySubAgentRunStore,
  JsonFileSubAgentRunStore,
  MAX_RUNS,
  MAX_EVENTS_PER_RUN,
} from "./runs-store.ts";
