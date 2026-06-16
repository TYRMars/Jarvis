// @jarvis/llm — LlmProvider implementations.
//
// Per-provider internals named identically across modules (StreamAccumulator,
// sanitizeToolName, buildXRequest) are intentionally NOT re-exported here to
// avoid collisions — tests import them directly from the module file. The
// public surface is the provider classes, their config types, and the small
// helpers callers (apps/jarvis, provider-admin routes) actually need.
export { autoCacheKey } from "./cache-key.ts";
export {
  type OpenAiConfig,
  type Outbound,
  OpenAiProvider,
  StreamAccumulator,
  buildOpenAiRequest,
  sanitizeToolName,
} from "./openai.ts";
export { type AnthropicConfig, AnthropicProvider } from "./anthropic.ts";
export { type GoogleConfig, type GoogleRequestBody, GoogleProvider } from "./google.ts";
export {
  type ResponsesAuth,
  type ResponsesConfig,
  type ResponsesOutbound,
  ResponsesProvider,
  responsesCodexConfig,
  responsesOpenAiConfig,
} from "./responses.ts";
export { type StaticAuthInit, type CodexAuthOptions, CodexAuth } from "./codex-auth.ts";
export { CapabilityValidatingProvider } from "./capability-validating.ts";
export { type FallbackEntry, FallbackProvider, fallbackEntry, isTransientError } from "./fallback.ts";
export {
  type ProviderTransport,
  type AuthKind,
  type Modality,
  type CostHint,
  type LatencyHint,
  type PrivacyHint,
  type ToolCallStyle,
  type JsonSchemaStyle,
  type ReasoningStyle,
  type RequestCompat,
  type ModelCapability,
  type ProviderProfile,
  type CatalogEntry,
  ProfileProvider,
  ProfileRegistry,
  BUILTIN_PROFILES,
  capabilityBadges,
  capabilityFor,
  lookupCapability,
  canonicalKind,
  flatBuiltinCatalog,
} from "./profile.ts";
