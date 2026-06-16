// Long-term memory value types — Phase 1 ("User / Project Memory 自动写入").
//
// Ported from crates/harness-learning/src/lib.rs. A `MemoryItem` is a short,
// pinnable fact about the user / project / workspace persisted in a
// `MemoryStore`. Rows feed into prompt context on the next relevant turn so
// the agent doesn't re-learn the same preference.
//
// Rust enums → TS unions:
//   - `MemoryKind` → string-literal union (serde rename_all = "snake_case").
//   - `MemoryScope` / `MemorySource` carry data → discriminated unions tagged
//     by `kind` (serde tag = "kind", rename_all = "snake_case").
import type { JsonValue } from "@jarvis/core";

// ---------- MemoryScope ----------------------------------------------------

/**
 * Where a memory row applies. Mirrors {@link SkillScope} so the same
 * scope-by-scope filtering UX works for both telemetry and Memory tabs. Serde
 * `tag = "kind"`, rename_all = "snake_case" → discriminated union on `kind`.
 */
export type MemoryScope =
  | { kind: "user" }
  | { kind: "project"; project_id: string }
  | { kind: "workspace"; workspace: string };

/** Cross-project, cross-workspace scope tied to the operator. */
export function memoryScopeUser(): MemoryScope {
  return { kind: "user" };
}

/** Scope tied to a specific project. */
export function memoryScopeProject(projectId: string): MemoryScope {
  return { kind: "project", project_id: projectId };
}

/** Scope tied to a workspace directory (opaque path or hash). */
export function memoryScopeWorkspace(path: string): MemoryScope {
  return { kind: "workspace", workspace: path };
}

/** Whether a scope is the cross-project user scope. */
export function memoryScopeIsUser(scope: MemoryScope): boolean {
  return scope.kind === "user";
}

/** Structural equality for two scopes (used as a list filter predicate). */
export function memoryScopeEq(a: MemoryScope, b: MemoryScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "project" && b.kind === "project") return a.project_id === b.project_id;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspace === b.workspace;
  return true; // both "user"
}

// ---------- MemoryKind -----------------------------------------------------

/**
 * What flavour of fact a memory row holds. Drives the prompt-injection budget
 * rules. Wire form snake_case; `preference` is the serde `#[default]`.
 */
export type MemoryKind = "preference" | "fact" | "lesson" | "gotcha" | "convention";

/** Serde `#[default]` for {@link MemoryKind}. */
export const DEFAULT_MEMORY_KIND: MemoryKind = "preference";

// ---------- MemorySource ---------------------------------------------------

/**
 * How a memory row was created. Drives the UI's "agent-inferred" badge and
 * tells the Curator what's safe to auto-archive (only `agent` / `run` rows).
 * Serde `tag = "kind"`, rename_all = "snake_case" → discriminated union;
 * `other` is the serde `#[default]`.
 */
export type MemorySource =
  | { kind: "user" }
  | { kind: "agent" }
  | { kind: "run"; run_id: string }
  | { kind: "import"; from: string }
  | { kind: "other" };

/** Serde `#[default]` for {@link MemorySource}. */
export function defaultMemorySource(): MemorySource {
  return { kind: "other" };
}

// ---------- MemoryItem -----------------------------------------------------

/** Hard cap on `title` length in chars. */
export const MEMORY_TITLE_CAP = 200;
/** Hard cap on `body` length in chars (~2 KiB). */
export const MEMORY_BODY_CAP = 2048;

/**
 * One memory row. `id` empty on construction; the store stamps a stable id +
 * `created_at` / `updated_at` on first `upsert`. `tags` is
 * `#[serde(skip_serializing_if = "Vec::is_empty")]` (absent when empty in
 * Rust, but always present as `[]` here for ergonomics — JSON `[]` round-trips
 * to an empty Vec either way). `last_used_at` carries
 * `#[serde(skip_serializing_if = "Option::is_none")]`; `attributes` is
 * `#[serde(default)]` (`null` when unset).
 */
export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  source: MemorySource;
  /** 0.0 — 1.0. Defaults to 1.0 for user-typed rows. */
  confidence: number;
  /** `#[serde(default)]`. Pinned rows survive the future Curator sweep. */
  pinned: boolean;
  created_at: string;
  updated_at: string;
  /** `#[serde(skip_serializing_if = "Option::is_none")]`. */
  last_used_at?: string;
  /** `#[serde(default)]` — free-form JSON, `null` when unset. */
  attributes: JsonValue;
}

/** Char count (Unicode scalar values, mirrors Rust `chars().count()`). */
function charCount(s: string): number {
  return [...s].length;
}

/** Take the first `n` chars (Unicode scalar values). */
function takeChars(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/**
 * Re-apply the per-field {@link MEMORY_TITLE_CAP} / {@link MEMORY_BODY_CAP}
 * truncation in place. A title past the cap is truncated to exactly
 * `TITLE_CAP` chars; a body past the cap is truncated to `BODY_CAP` chars plus
 * a trailing `…` (so it grows to `BODY_CAP + 1` chars — the wire signal that
 * truncation happened). Idempotent for rows already within the caps.
 *
 * Mirrors Rust `MemoryItem::clamp_fields`. Mutates `item` and returns it.
 */
export function clampMemoryFields(item: MemoryItem): MemoryItem {
  if (charCount(item.title) > MEMORY_TITLE_CAP) {
    item.title = takeChars(item.title, MEMORY_TITLE_CAP);
  }
  if (charCount(item.body) > MEMORY_BODY_CAP) {
    item.body = takeChars(item.body, MEMORY_BODY_CAP) + "…";
  }
  return item;
}

/**
 * Cheap constructor used by tools and tests. Caps title + body; stamps neither
 * `id` nor timestamps (the store does both on `upsert`). `source` defaults to
 * `user`, `confidence` to 1.0. Mirrors Rust `MemoryItem::new`.
 */
export function newMemoryItem(
  scope: MemoryScope,
  kind: MemoryKind,
  title: string,
  body: string,
): MemoryItem {
  const item: MemoryItem = {
    id: "",
    scope,
    kind,
    title,
    body,
    tags: [],
    source: { kind: "user" },
    confidence: 1.0,
    pinned: false,
    created_at: "",
    updated_at: "",
    attributes: null,
  };
  clampMemoryFields(item);
  return item;
}

/** Builder shortcut: tag the row (mutates in place, returns it). */
export function withMemoryTag(item: MemoryItem, tag: string): MemoryItem {
  item.tags.push(tag);
  return item;
}

/** Builder shortcut: mark the row pinned (mutates in place, returns it). */
export function pinnedMemoryItem(item: MemoryItem): MemoryItem {
  item.pinned = true;
  return item;
}

/** Builder shortcut: set the source (mutates in place, returns it). */
export function withMemorySource(item: MemoryItem, source: MemorySource): MemoryItem {
  item.source = source;
  return item;
}

// ---------- MemoryPatch ----------------------------------------------------

/**
 * Partial-update payload. Absent fields leave the existing value alone; a set
 * field replaces. Wire form mirrors `skip_serializing_if = "Option::is_none"`
 * (omitted when unset).
 */
export interface MemoryPatch {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  tags?: string[];
  pinned?: boolean;
  confidence?: number;
  last_used_at?: string;
}

/** Clamp a number into `[lo, hi]` (mirrors Rust `f32::clamp`). */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Apply `patch` in place to `item`, respecting the same per-field caps as
 * {@link newMemoryItem}. `confidence` is clamped into `[0.0, 1.0]`. Mirrors
 * Rust `MemoryPatch::apply`.
 */
export function applyMemoryPatch(patch: MemoryPatch, item: MemoryItem): void {
  if (patch.title !== undefined) {
    let t = patch.title;
    if (charCount(t) > MEMORY_TITLE_CAP) t = takeChars(t, MEMORY_TITLE_CAP);
    item.title = t;
  }
  if (patch.body !== undefined) {
    let b = patch.body;
    if (charCount(b) > MEMORY_BODY_CAP) b = takeChars(b, MEMORY_BODY_CAP) + "…";
    item.body = b;
  }
  if (patch.kind !== undefined) item.kind = patch.kind;
  if (patch.tags !== undefined) item.tags = [...patch.tags];
  if (patch.pinned !== undefined) item.pinned = patch.pinned;
  if (patch.confidence !== undefined) item.confidence = clamp(patch.confidence, 0.0, 1.0);
  if (patch.last_used_at !== undefined) item.last_used_at = patch.last_used_at;
}

// ---------- MemoryFilter ---------------------------------------------------

/**
 * Read-side filter for {@link MemoryStore.list}. Absent means "any". `tags`
 * matches rows carrying *every* listed tag. `pinned`: `true` → only pinned,
 * `false` → only unpinned, absent → any. Wire form mirrors the Rust struct's
 * skip-when-default annotations (`tags` omitted when empty).
 */
export interface MemoryFilter {
  scope?: MemoryScope;
  kind?: MemoryKind;
  tags?: string[];
  pinned?: boolean;
  limit?: number;
}

/** Whether `item` matches `filter` (all set predicates must hold). */
export function memoryItemMatches(item: MemoryItem, filter: MemoryFilter): boolean {
  if (filter.scope !== undefined && !memoryScopeEq(item.scope, filter.scope)) return false;
  if (filter.kind !== undefined && item.kind !== filter.kind) return false;
  if (filter.tags !== undefined && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      if (!item.tags.includes(tag)) return false;
    }
  }
  if (filter.pinned !== undefined && item.pinned !== filter.pinned) return false;
  return true;
}

// ---------- MemoryEvent ----------------------------------------------------

/**
 * Broadcast event surface for memory mutations. Forwarded out over the WS as
 * `{type: "memory_upserted" | "memory_deleted"}` frames so the Web UI updates
 * without polling. Serde `tag = "type"`, rename_all = "snake_case" →
 * discriminated union on `type`. (Rust's `Box<MemoryItem>` is a heap-size
 * optimisation with no wire effect — the JSON carries the item inline.)
 */
export type MemoryEvent =
  | { type: "upserted"; item: MemoryItem }
  | { type: "deleted"; id: string };

/** Build the `upserted` broadcast event for `item`. */
export function memoryUpsertedEvent(item: MemoryItem): MemoryEvent {
  return { type: "upserted", item };
}

/** Build the `deleted` broadcast event. */
export function memoryDeletedEvent(id: string): MemoryEvent {
  return { type: "deleted", id };
}
