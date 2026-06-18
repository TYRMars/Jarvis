// Skill usage telemetry value types — Phase 0 ("可观测但不自动写").
//
// Ported from crates/harness-learning/src/lib.rs. Every load / view /
// invocation of a catalog Skill lands as a `SkillUsageEvent` in a
// `SkillUsageStore` (append-only). The store folds the raw event log into
// per-(skill, scope) `SkillUsageRow` aggregates on read.
//
// Rust enums → TS unions:
//   - `SkillSource` / `SkillUsageAction` → string-literal unions
//     (serde rename_all = "snake_case").
//   - `SkillScope` carries data → discriminated union tagged by `kind`
//     (serde tag = "kind", rename_all = "snake_case").
import type { JsonValue } from "@jarvis/core";

// ---------- SkillSource ----------------------------------------------------

/**
 * Where a skill was loaded from. Mirrors `harness_skill::SkillSource` without
 * a hard dependency. Wire form snake_case; `other` is the serde `#[default]`.
 */
export type SkillSource = "bundled" | "user" | "workspace" | "plugin" | "other";

/** Serde `#[default]` for {@link SkillSource}. */
export const DEFAULT_SKILL_SOURCE: SkillSource = "other";

// ---------- SkillUsageAction -----------------------------------------------

/**
 * What happened to the skill during this event. `listed` / `viewed` are
 * read-only signals; `used` fires when a skill body is injected / invoked;
 * the rest track lifecycle mutation through the future `skill.manage` tool.
 * Wire form snake_case.
 */
export type SkillUsageAction =
  | "listed"
  | "viewed"
  | "used"
  | "patched"
  | "created"
  | "archived"
  | "restored";

// ---------- SkillScope -----------------------------------------------------

/**
 * What scope a usage event belongs to. Mirrors {@link MemoryScope} so the same
 * scope-by-scope lookup keys are reusable. Serde `tag = "kind"`,
 * rename_all = "snake_case" → discriminated union on `kind`.
 */
export type SkillScope =
  | { kind: "user" }
  | { kind: "project"; project_id: string }
  | { kind: "workspace"; workspace: string };

/** Cross-project, cross-workspace scope tied to the operator. */
export function skillScopeUser(): SkillScope {
  return { kind: "user" };
}

/** Scope tied to a specific project. */
export function skillScopeProject(projectId: string): SkillScope {
  return { kind: "project", project_id: projectId };
}

/** Scope tied to a workspace directory (opaque path or hash). */
export function skillScopeWorkspace(path: string): SkillScope {
  return { kind: "workspace", workspace: path };
}

/** Structural equality for two scopes (used as a fold grouping key). */
export function skillScopeEq(a: SkillScope, b: SkillScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "project" && b.kind === "project") return a.project_id === b.project_id;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspace === b.workspace;
  return true; // both "user"
}

/** Stable string key for a scope — used to group fold rows in a Map. */
function scopeKey(s: SkillScope): string {
  switch (s.kind) {
    case "user":
      return "user";
    case "project":
      return `project:${s.project_id}`;
    case "workspace":
      return `workspace:${s.workspace}`;
  }
}

// ---------- SkillUsageEvent ------------------------------------------------

/**
 * A single usage event recorded against the catalog. Append-only — the store
 * never edits or deletes telemetry rows.
 *
 * `id` and `created_at` are empty on construction; the store stamps both. The
 * optional `conversation_id` / `requirement_id` / `run_id` carry
 * `#[serde(skip_serializing_if = "Option::is_none")]` (absent when unset).
 * `attributes` is `#[serde(default)]` → free-form JSON, `null` when unset.
 */
export interface SkillUsageEvent {
  id: string;
  skill_name: string;
  source: SkillSource;
  action: SkillUsageAction;
  scope: SkillScope;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  conversation_id?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  requirement_id?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  run_id?: string;
  created_at: string;
  /** `#[serde(default)]` — free-form JSON, `null` when unset. */
  attributes: JsonValue;
}

/**
 * Shorthand for a minimal `viewed` event. Higher layers fill the rest
 * (conversation / requirement / run id) before persisting. Leaves `id` and
 * `created_at` empty so the store stamps both.
 */
export function viewedSkillUsageEvent(
  skillName: string,
  source: SkillSource,
  scope: SkillScope,
): SkillUsageEvent {
  return {
    id: "",
    skill_name: skillName,
    source,
    action: "viewed",
    scope,
    created_at: "",
    attributes: null,
  };
}

// ---------- sanitize -------------------------------------------------------

/** Hard cap on `skill_name` length (chars) accepted over the wire. */
export const SKILL_NAME_CAP = 200;

/**
 * Hard cap on the serialized byte size of an event's `attributes` blob.
 * Without it each POST could append a multi-MB never-pruned row (storage DoS).
 */
export const SKILL_ATTRIBUTES_CAP = 16 * 1024;

/**
 * Why a {@link SkillUsageEvent} write was refused by
 * {@link sanitizeSkillUsageEvent}. Rust `SkillUsageRejection` (a
 * `thiserror`-derived enum) → a discriminated union on `reason`. Carries an
 * `Error`-shaped `message` so higher layers can surface it verbatim.
 */
export type SkillUsageRejection =
  | { reason: "empty_skill_name"; message: string }
  | { reason: "skill_name_too_long"; len: number; cap: number; message: string }
  | { reason: "attributes_too_large"; size: number; cap: number; message: string };

/** Thrown by {@link sanitizeSkillUsageEvent}; carries the structured reason. */
export class SkillUsageRejectionError extends Error {
  readonly rejection: SkillUsageRejection;
  constructor(rejection: SkillUsageRejection) {
    super(rejection.message);
    this.name = "SkillUsageRejectionError";
    this.rejection = rejection;
  }
}

/** Byte length of a UTF-8 string (mirrors Rust `String::len`). */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Char count (Unicode scalar values, mirrors Rust `chars().count()`). */
function charCount(s: string): number {
  return [...s].length;
}

/**
 * Sanitize a client-supplied {@link SkillUsageEvent} before it reaches the
 * store. Two jobs:
 *
 * 1. **Strip client-controlled identity/ordering fields.** `id` and
 *    `created_at` are blanked so the store re-stamps both server-side. A
 *    client-chosen `created_at` (the sort key for the whole telemetry surface)
 *    would reorder and poison everyone's report.
 * 2. **Enforce size caps** on `skill_name` and `attributes`.
 *
 * Returns the cleaned event. Throws {@link SkillUsageRejectionError} on a
 * rejection (higher layers turn that into a 400 Bad Request).
 */
export function sanitizeSkillUsageEvent(event: SkillUsageEvent): SkillUsageEvent {
  const name = event.skill_name.trim();
  if (name === "") {
    throw new SkillUsageRejectionError({
      reason: "empty_skill_name",
      message: "skill usage rejected: empty skill_name after trim",
    });
  }
  const len = charCount(name);
  if (len > SKILL_NAME_CAP) {
    throw new SkillUsageRejectionError({
      reason: "skill_name_too_long",
      len,
      cap: SKILL_NAME_CAP,
      message: `skill usage rejected: skill_name too long (${len} chars > ${SKILL_NAME_CAP}-char cap)`,
    });
  }

  if (event.attributes !== null) {
    // Serializing a JSON value is infallible; measure its UTF-8 byte size.
    const size = utf8Len(JSON.stringify(event.attributes));
    if (size > SKILL_ATTRIBUTES_CAP) {
      throw new SkillUsageRejectionError({
        reason: "attributes_too_large",
        size,
        cap: SKILL_ATTRIBUTES_CAP,
        message: `skill usage rejected: attributes blob too large (${size} bytes > ${SKILL_ATTRIBUTES_CAP}-byte cap)`,
      });
    }
  }

  // Never trust client-supplied identity/ordering — the store stamps both.
  return { ...event, skill_name: name, id: "", created_at: "" };
}

// ---------- SkillUsageRow + fold -------------------------------------------

/**
 * Aggregated usage stats for a single skill in a given scope. The store
 * computes this on read so callers don't walk the raw event log.
 * `last_used_at` / `last_action` carry `#[serde(skip_serializing_if =
 * "Option::is_none")]` (absent when unset).
 */
export interface SkillUsageRow {
  skill_name: string;
  source: SkillSource;
  scope: SkillScope;
  view_count: number;
  use_count: number;
  patch_count: number;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  last_used_at?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  last_action?: SkillUsageAction;
}

/**
 * Read-side filter for {@link SkillUsageStore.listEvents} / `report`. All
 * fields optional; absent means "any". Wire form mirrors the Rust struct's
 * `skip_serializing_if = "Option::is_none"` (omitted when unset).
 */
export interface SkillUsageFilter {
  skill_name?: string;
  scope?: SkillScope;
  action?: SkillUsageAction;
  conversation_id?: string;
  limit?: number;
}

/**
 * Fold a flat event slice into per-(skill, source, scope) aggregated rows.
 * Public so SQL backends building the same report through a grouped query can
 * reuse the comparison invariants. Output sorted ascending by `skill_name`.
 *
 * The fold makes NO input-ordering guarantee: `last_used_at` keeps the newest
 * `used` event's timestamp, and `last_action` keeps the newest action seen for
 * a row — both compared lexicographically against `created_at`, so the result
 * is identical whether the input is ascending or descending.
 */
export function foldEventsIntoRows(events: readonly SkillUsageEvent[]): SkillUsageRow[] {
  const rows = new Map<string, SkillUsageRow>();
  // Tracks the `created_at` of the event currently recorded in each row's
  // `last_action`, so we can keep the *newest* action regardless of ordering.
  const lastActionAt = new Map<string, string>();

  for (const ev of events) {
    const key = `${ev.skill_name} ${ev.source} ${scopeKey(ev.scope)}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        skill_name: ev.skill_name,
        source: ev.source,
        scope: ev.scope,
        view_count: 0,
        use_count: 0,
        patch_count: 0,
      };
      rows.set(key, row);
    }
    switch (ev.action) {
      case "listed":
      case "viewed":
        row.view_count += 1;
        break;
      case "used": {
        row.use_count += 1;
        if ((row.last_used_at ?? "") < ev.created_at) {
          row.last_used_at = ev.created_at;
        }
        break;
      }
      case "patched":
      case "created":
      case "archived":
      case "restored":
        row.patch_count += 1;
        break;
    }
    const prev = lastActionAt.get(key);
    const isNewer = prev === undefined ? true : prev < ev.created_at;
    if (isNewer) {
      row.last_action = ev.action;
      lastActionAt.set(key, ev.created_at);
    }
  }

  const out = [...rows.values()];
  out.sort((a, b) => (a.skill_name < b.skill_name ? -1 : a.skill_name > b.skill_name ? 1 : 0));
  return out;
}

/** Whether `event` matches `filter` (all set predicates must hold). */
export function skillUsageEventMatches(event: SkillUsageEvent, filter: SkillUsageFilter): boolean {
  if (filter.skill_name !== undefined && event.skill_name !== filter.skill_name) return false;
  if (filter.scope !== undefined && !skillScopeEq(event.scope, filter.scope)) return false;
  if (filter.action !== undefined && event.action !== filter.action) return false;
  if (filter.conversation_id !== undefined && event.conversation_id !== filter.conversation_id) {
    return false;
  }
  return true;
}
