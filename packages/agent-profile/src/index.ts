// @jarvis/agent-profile — named agent identity bundles + AgentProfileStore.
//
// Ported from crates/harness-core/src/agent_profile.rs (the value type +
// event) and crates/harness-core/src/store.rs (the AgentProfileStore trait),
// with JSON-file + in-memory backends ported from harness-store. A profile
// bundles name / avatar / provider / model / optional system_prompt /
// default_workspace / allowed_tools so a Requirement can be assigned to one.
//
// NOTE: the Rust source has NO default-profile concept (no `is_default` flag,
// no "the default profile" accessor on the trait) — the store is plain CRUD,
// so none is ported here.

// ---------- agent-profile.ts ----------
export {
  type AgentProfile,
  type AgentProfileEvent,
  newProfile,
  touchProfile,
  agentProfileEventId,
} from "./agent-profile.ts";

// ---------- store.ts ----------
export {
  type AgentProfileStore,
  type EventSource,
  type EventListener,
  type Unsubscribe,
  Fanout,
  byName,
  LIST_SOFT_CAP,
} from "./store.ts";

// ---------- backends ----------
export { JsonFileAgentProfileStore } from "./json-store.ts";
export { MemoryAgentProfileStore } from "./memory-store.ts";
