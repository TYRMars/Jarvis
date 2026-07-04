// @jarvis/core — runtime-independent agent harness. Public surface.
export type { JsonValue } from "./json.ts";
export {
  HarnessError,
  ProviderError,
  MemoryError,
  ApprovalError,
  AbortError,
  MaxIterationsError,
  errorText,
} from "./error.ts";
export {
  type CacheHint,
  type Message,
  type ToolCall,
  systemMessage,
  userMessage,
  assistantText,
  toolResult,
  withCache,
} from "./message.ts";
export {
  type Conversation,
  newConversation,
  conversationWithSystem,
  lastAssistantText,
} from "./conversation.ts";
export {
  type FinishReason,
  type Usage,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
  emptyUsage,
  usageIsEmpty,
  addUsage,
  defaultCompleteStream,
  LlmProviderBase,
} from "./llm.ts";
export {
  type ToolCategory,
  type Tool,
  type ToolSpec,
  ToolRegistry,
  toolCategory,
  toolRequiresApproval,
  toolIsConcurrencySafe,
  toolIsDestructive,
} from "./tool.ts";
export {
  type ToolSource,
  type ToolPackCategory,
  type ToolRisk,
  type ToolMetadata,
  toolMetadataFromTool,
  toolMetadataToWire,
  derivePack,
  deriveRisk,
} from "./tool-metadata.ts";
export {
  type ApprovalDecision,
  type ApprovalRequest,
  type Approver,
  type PendingApproval,
  approveDecision,
  denyDecision,
  AlwaysApprove,
  AlwaysDeny,
  ChannelApprover,
} from "./approval.ts";
export { type PlanItem, type PlanStatus, emitPlan, planActive, withPlan } from "./plan.ts";
export { type ToolProgress, emitProgress, progressActive, withProgress } from "./progress.ts";
export { type Memory } from "./memory.ts";
export {
  type AgentConfig,
  type RunOutcome,
  type AgentEvent,
  Agent,
  defaultAgentConfig,
  ensureSystemPrompt,
} from "./agent.ts";
