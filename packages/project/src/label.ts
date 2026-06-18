// Project-scoped tags for kanban Requirement rows.
//
// Ported from crates/harness-project/src/label.rs. A Label is a structured,
// project-scoped, shared entity that one or more requirements reference by
// id (via Requirement.label_ids). Labels carry a name + colour + optional
// description.

/**
 * Maximum length for a label name. The kanban renders these as inline chips
 * (>32 chars wraps badly) and the agent system prompt embeds active labels.
 */
export const MAX_LABEL_NAME_LEN = 32;

/** One project-scoped tag. */
export interface Label {
  /** Stable identifier (UUID v4). */
  id: string;
  /** Project this label belongs to. Labels do not cross project boundaries. */
  project_id: string;
  /** Display name. Trimmed + required non-empty by {@link validateLabelName}. */
  name: string;
  /** Hex colour in `#rrggbb` form (lowercase). Validated by {@link validateLabelColour}. */
  colour: string;
  /** Optional one-line guidance. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  description?: string;
  /** RFC-3339 / ISO-8601. Set on insert, never mutated. */
  created_at: string;
  /** RFC-3339 / ISO-8601. Bumped on every mutation. */
  updated_at: string;
}

/**
 * Build a fresh label. The caller is responsible for running
 * {@link validateLabelName} / {@link validateLabelColour} before passing
 * values; this constructor stays infallible.
 */
export function newLabel(projectId: string, name: string, colour: string): Label {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    name,
    colour,
    created_at: now,
    updated_at: now,
  };
}

/** Bump `updated_at` to now. */
export function touchLabel(label: Label): void {
  label.updated_at = new Date().toISOString();
}

/**
 * Validation result discriminated union — mirrors Rust `Result<String,
 * String>`. `ok` carries the canonicalised value; `err` carries a
 * human-readable reason.
 */
export type LabelValidation = { ok: string } | { err: string };

/**
 * Trim, length-cap, and reject empty / whitespace-only label names. Returns
 * the canonicalised (trimmed) form on success.
 */
export function validateLabelName(raw: string): LabelValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { err: "label name must not be empty" };
  }
  // Char count (Unicode scalar values), matching Rust `chars().count()`.
  if ([...trimmed].length > MAX_LABEL_NAME_LEN) {
    return { err: `label name must be ≤ ${MAX_LABEL_NAME_LEN} characters` };
  }
  if (/[\n\r\t]/.test(trimmed)) {
    return { err: "label name must not contain newline / tab" };
  }
  return { ok: trimmed };
}

/**
 * Accept `#rrggbb` (case-insensitive). Returns the lowercased form. Named
 * colours, rgba(), hsl() are deliberately rejected.
 */
export function validateLabelColour(raw: string): LabelValidation {
  const trimmed = raw.trim();
  if (trimmed.length !== 7 || !trimmed.startsWith("#")) {
    return { err: "colour must be in `#rrggbb` form" };
  }
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed.slice(1))) {
    return { err: "colour must be `#rrggbb` with hex digits" };
  }
  return { ok: trimmed.toLowerCase() };
}

/**
 * Broadcast event for {@link Label} mutations. Serde shape:
 * `#[serde(tag = "type", rename_all = "snake_case")]`. The `Created(Label)`
 * / `Updated(Label)` newtype variants flatten the label's fields.
 */
export type LabelEvent =
  | ({ type: "created" } & Label)
  | ({ type: "updated" } & Label)
  | { type: "deleted"; project_id: string; label_id: string };

/** Project id the event targets — convenience for per-project WS filtering. */
export function labelEventProjectId(ev: LabelEvent): string {
  return ev.project_id;
}
