// Named agent profiles — "agents as teammates".
//
// Ported from crates/harness-core/src/agent_profile.rs. Each profile bundles
// the choices that make a particular agent identity (name, avatar, provider,
// model, optional system prompt / default workspace / allowed tools) so a
// Requirement can be assigned to one and the runtime can dispatch the work
// against the right combination without the user re-entering it per turn.
//
// Wire stability: fields are snake_case JSON. The Rust optional fields use
// `skip_serializing_if = "Option::is_none"` / `"Vec::is_empty"`, so the
// matching TS fields are optional and ABSENT (not `null`) when at their
// default — older clients deserialise newer rows cleanly. `newProfile`
// therefore leaves them off entirely rather than setting `undefined`.

/**
 * One named agent identity.
 *
 * All fields are wire-stable (snake_case JSON). Optional ones are omitted
 * from the serialised form when at their default (matching the Rust
 * `skip_serializing_if`), so consumers must treat absence as "use the
 * server default / no preference".
 */
export interface AgentProfile {
  /** Stable identifier (UUID v4). */
  id: string;
  /**
   * Display name. Required, non-blank. Two profiles can have the same name
   * (uniqueness is by id); the UI surfaces both.
   */
  name: string;
  /**
   * Optional avatar — emoji glyph, hex colour, or a URL. Rendered verbatim,
   * so any encoding the operator likes works. Absent when unset.
   */
  avatar?: string;
  /**
   * Provider key (e.g. `"codex"`, `"anthropic"`, `"openai"`). Validated at
   * startup to match a configured provider.
   */
  provider: string;
  /** Model id. Required so a profile is always actionable. */
  model: string;
  /**
   * Optional override of the system prompt. When set, `start_run` prepends
   * this to the manifest summary. Absent when unset.
   */
  system_prompt?: string;
  /**
   * Optional default workspace path. UIs that switch context when picking an
   * assignee read this. Absent (not empty string) when there is no
   * preference.
   */
  default_workspace?: string;
  /**
   * Tool allowlist. Absent/empty = "use the server's default catalogue";
   * non-empty = restrict to these tool names. Validation against the live
   * tool registry is the runtime's responsibility — bad names surface at
   * dispatch time, not at profile save time.
   */
  allowed_tools?: string[];
  /** RFC-3339 / ISO-8601 timestamp. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp. Bumped by {@link touchProfile}. */
  updated_at: string;
}

/**
 * Mint a new profile with a fresh UUID and current timestamps. Trims `name`
 * for safety; callers should still reject blank names at the REST layer. The
 * optional fields are left off entirely so they round-trip as absent (mirrors
 * the Rust `skip_serializing_if` wire form).
 */
export function newProfile(name: string, provider: string, model: string): AgentProfile {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    provider,
    model,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Bump `updated_at` to now. Call after every mutation to a profile field
 * except the timestamp itself. Mutates in place (mirrors Rust's `&mut self`).
 */
export function touchProfile(profile: AgentProfile): void {
  profile.updated_at = new Date().toISOString();
}

/**
 * Broadcast event for {@link AgentProfile} mutations. Externally tagged on
 * `type` (snake_case), mirroring the Rust `#[serde(tag = "type", rename_all =
 * "snake_case")]` enum. `upserted` carries the full profile; `deleted` is just
 * an id.
 */
export type AgentProfileEvent =
  | ({ type: "upserted" } & AgentProfile)
  | { type: "deleted"; id: string };

/** Profile id the event targets. */
export function agentProfileEventId(event: AgentProfileEvent): string {
  return event.id;
}
