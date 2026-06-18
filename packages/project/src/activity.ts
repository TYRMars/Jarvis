// Per-Requirement audit timeline.
//
// Ported from crates/harness-project/src/activity.rs. One row per "thing
// that happened" against a kanban Requirement — status flips, run lifecycle,
// verification results. Append-only by design (no upsert, no delete).
import type { JsonValue } from "@jarvis/core";

/**
 * Kind of activity. Wire form snake_case. The set is intentionally small;
 * AssigneeChange / Comment / Blocked / Unblocked are reserved for later
 * phases. Body shapes vary by kind (documented on each variant in Rust).
 */
export type ActivityKind =
  | "status_change"
  | "run_started"
  | "run_finished"
  | "verification_finished"
  | "assignee_change"
  | "comment"
  | "blocked"
  | "unblocked"
  | "connector_sync";

const ACTIVITY_KINDS: readonly ActivityKind[] = [
  "status_change",
  "run_started",
  "run_finished",
  "verification_finished",
  "assignee_change",
  "comment",
  "blocked",
  "unblocked",
  "connector_sync",
];

/** Parse a wire string. `undefined` for unrecognised values. */
export function activityKindFromWire(s: string): ActivityKind | undefined {
  return (ACTIVITY_KINDS as readonly string[]).includes(s) ? (s as ActivityKind) : undefined;
}

/**
 * Who triggered an activity. Serde shape:
 * `#[serde(tag = "type", rename_all = "snake_case")]`.
 *
 * - `Human` is the v0 default for any REST-driven mutation.
 * - `Agent { profile_id }` carries the agent's profile id.
 * - `System` is the bucket for server-side auto-advances.
 */
export type ActivityActor =
  | { type: "human" }
  | { type: "agent"; profile_id: string }
  | { type: "system" };

/** One audit-timeline row. */
export interface Activity {
  /** Stable identifier (UUID v4). */
  id: string;
  /** Requirement this activity belongs to. */
  requirement_id: string;
  /** What happened. */
  kind: ActivityKind;
  /** Who did it. */
  actor: ActivityActor;
  /**
   * Free-form payload, shape varies by `kind`. (Rust uses
   * `serde_json::Value` with `#[ts(type = "Record<string, unknown>")]`.)
   */
  body: JsonValue;
  /** RFC-3339 / ISO-8601 timestamp. */
  created_at: string;
}

/** Build a new activity row with a fresh UUID and current timestamp. */
export function newActivity(
  requirementId: string,
  kind: ActivityKind,
  actor: ActivityActor,
  body: JsonValue,
): Activity {
  return {
    id: crypto.randomUUID(),
    requirement_id: requirementId,
    kind,
    actor,
    body,
    created_at: new Date().toISOString(),
  };
}

/**
 * Broadcast event for {@link Activity} mutations. Append-only log → only one
 * variant. Serde shape: `#[serde(tag = "type", rename_all = "snake_case")]`;
 * the `Appended(Activity)` newtype variant flattens the activity's fields.
 */
export type ActivityEvent = { type: "appended" } & Activity;

/** Requirement id the event targets — convenience for per-requirement WS filtering. */
export function activityEventRequirementId(ev: ActivityEvent): string {
  return ev.requirement_id;
}
