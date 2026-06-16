// Skill activation-state value types + the SkillStore trait.
//
// The Rust `harness-skill` crate keeps its `SkillCatalog` purely in memory —
// discovery is a disk scan, not a persisted store. What *does* need to persist
// across restarts is which skills a scope (a session, a workspace, …) has
// *activated*: the manual on/off toggles the harness consults each turn before
// the auto-selector ({@link pickAutoSkills}) runs. This module owns that
// persistence surface — value type + trait — with concrete backends in
// skill-store.ts.
//
// Concurrency / events follow the @jarvis/project convention: the trait is an
// {@link EventSource}, and every successful mutation fans an event out to all
// registered listeners synchronously (the Node stand-in for Rust's
// `tokio::sync::broadcast`).

/** Removes a previously-registered listener. Idempotent. */
export type Unsubscribe = () => void;

/** A listener for events of type `E`. */
export type EventListener<E> = (event: E) => void;

/**
 * Typed event-source — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener and returns a function that detaches it.
 * Delivery is synchronous fan-out, so listeners cannot lag.
 */
export interface EventSource<E> {
  subscribe(listener: EventListener<E>): Unsubscribe;
}

/**
 * Per-scope record of which skills are manually activated.
 *
 * `scope` is an opaque caller-chosen key — typically a conversation/session
 * id or a workspace path — under which a set of skill `names` is toggled on.
 * The set is stored as a sorted, de-duplicated array so the on-disk form is
 * deterministic (matching the catalog's name-ordered iteration).
 */
export interface SkillActivationRecord {
  /** Opaque scope key (session id, workspace path, …). The store's primary key. */
  scope: string;
  /** Skill names toggled on for this scope, sorted + de-duplicated. */
  names: string[];
  /** RFC-3339 / ISO-8601. Set on first write, never mutated. */
  created_at: string;
  /** RFC-3339 / ISO-8601. Bumped on every mutation. */
  updated_at: string;
}

/**
 * Broadcast event for {@link SkillActivationRecord} mutations. Serde shape:
 * `#[serde(tag = "type", rename_all = "snake_case")]`.
 *
 * - `activated`   — `name` was turned on for `scope` (no-op writes don't emit).
 * - `deactivated` — `name` was turned off for `scope`.
 * - `cleared`     — every activation for `scope` was removed (the record deleted).
 */
export type SkillActivationEvent =
  | { type: "activated"; scope: string; name: string }
  | { type: "deactivated"; scope: string; name: string }
  | { type: "cleared"; scope: string };

/** Scope the event targets — convenience for per-scope WS filtering. */
export function skillActivationEventScope(ev: SkillActivationEvent): string {
  return ev.scope;
}

/**
 * Persistence operations on per-scope {@link SkillActivationRecord} records. One row
 * per `scope`. All mutations are idempotent and broadcast through the
 * {@link EventSource} on a real change only.
 */
export interface SkillStore extends EventSource<SkillActivationEvent> {
  /**
   * Activated skill names for `scope`, sorted + de-duplicated. Resolves an
   * empty array when the scope has no record (never `undefined`).
   */
  activeNames(scope: string): Promise<string[]>;
  /**
   * Load the full record for `scope`. Resolves `undefined` when absent.
   */
  get(scope: string): Promise<SkillActivationRecord | undefined>;
  /**
   * List every scope's record, newest-updated first, capped at `limit`.
   */
  list(limit: number): Promise<SkillActivationRecord[]>;
  /**
   * Turn `name` on for `scope`. Creates the record on first activation.
   * Resolves `true` when the set changed (was off → now on), `false` when it
   * was already active. Broadcasts `activated` only on the `true` path.
   */
  activate(scope: string, name: string): Promise<boolean>;
  /**
   * Turn `name` off for `scope`. Resolves `true` when the set changed,
   * `false` when it wasn't active (or the scope had no record). Broadcasts
   * `deactivated` only on the `true` path. Removing the last active name
   * leaves an empty record (use {@link clear} to delete it).
   */
  deactivate(scope: string, name: string): Promise<boolean>;
  /**
   * Remove the entire record for `scope`. Resolves `true` when a record was
   * removed, `false` when none existed (idempotent). Broadcasts `cleared`
   * only on the `true` path.
   */
  clear(scope: string): Promise<boolean>;
}
