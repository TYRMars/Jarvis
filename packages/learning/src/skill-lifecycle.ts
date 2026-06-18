// Skill lifecycle value types — Phase 2.
//
// Ported from crates/harness-learning/src/lib.rs. Distinct from
// `SkillUsageEvent` telemetry: a `SkillLifecycle` row is the operational
// *status* the Curator and UI act on, keyed by `skill_name`, kept separate
// from the user-authored `SKILL.md` frontmatter ("Usage 不写进 frontmatter").
import type { SkillSource } from "./skill-usage.ts";

// ---------- SkillState -----------------------------------------------------

/**
 * Lifecycle state of a catalog skill. Wire form snake_case; `active` is the
 * serde `#[default]`.
 *   - `active`: live and eligible for activation / injection.
 *   - `stale`: Curator flagged it as long-unused; still loadable.
 *   - `archived`: soft-deleted (never hard-deleted — "不删除，最多 archive").
 */
export type SkillState = "active" | "stale" | "archived";

/** Serde `#[default]` for {@link SkillState}. */
export const DEFAULT_SKILL_STATE: SkillState = "active";

/** Wire string for a {@link SkillState} (mirrors Rust `SkillState::as_wire`). */
export function skillStateAsWire(state: SkillState): string {
  return state;
}

// ---------- SkillCreator ---------------------------------------------------

/**
 * Who created a skill. The Curator may only auto-archive `agent` rows; the
 * rest are never touched automatically. Wire form snake_case; `plugin` is the
 * serde `#[default]`.
 */
export type SkillCreator = "user" | "agent" | "bundled" | "plugin";

/** Serde `#[default]` for {@link SkillCreator}. */
export const DEFAULT_SKILL_CREATOR: SkillCreator = "plugin";

/**
 * Whether the Curator may auto-mutate this skill's lifecycle (stale /
 * archive). Only agent-created skills qualify.
 */
export function skillCreatorMayMutate(creator: SkillCreator): boolean {
  return creator === "agent";
}

// ---------- SkillLifecycle -------------------------------------------------

/**
 * Operational lifecycle row for one catalog skill, keyed by `skill_name`.
 * Timestamps are empty on construction; the store stamps `created_at` (if
 * empty) + `updated_at` (always) on `upsert`. `pinned` is `#[serde(default)]`;
 * `absorbed_into` / `archived_at` carry `#[serde(skip_serializing_if =
 * "Option::is_none")]`.
 */
export interface SkillLifecycle {
  skill_name: string;
  source: SkillSource;
  created_by: SkillCreator;
  state: SkillState;
  /** `#[serde(default)]`. */
  pinned: boolean;
  /**
   * When archived because its content was merged into an umbrella skill, the
   * umbrella's name. Absent means a plain pruning with no absorption target.
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  absorbed_into?: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  archived_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Fresh `active` lifecycle row. Timestamps are stamped by the store on first
 * `upsert` (empty here), same convention as {@link MemoryItem} /
 * {@link SkillUsageEvent}.
 */
export function newSkillLifecycle(
  skillName: string,
  source: SkillSource,
  createdBy: SkillCreator,
): SkillLifecycle {
  return {
    skill_name: skillName,
    source,
    created_by: createdBy,
    state: "active",
    pinned: false,
    created_at: "",
    updated_at: "",
  };
}

/** Builder shortcut: mark the row pinned (mutates in place, returns it). */
export function pinnedSkillLifecycle(row: SkillLifecycle): SkillLifecycle {
  row.pinned = true;
  return row;
}

/**
 * Whether this row is eligible for the Curator's auto-archive sweep:
 * agent-created, not pinned, not already archived.
 */
export function skillLifecycleCuratorArchivable(row: SkillLifecycle): boolean {
  return skillCreatorMayMutate(row.created_by) && !row.pinned && row.state !== "archived";
}
