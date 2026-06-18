// Long-term, project-scoped memory of lessons / gotchas / context.
//
// Ported from crates/harness-project/src/project_memory.rs. A ProjectMemory
// is a curated, durable note attached to a Project that should be loaded
// into the system prompt of every future run in that project.

/**
 * Why this memory exists. Kind is purely a presentation hint; the store
 * doesn't filter on it. Wire form snake_case.
 */
export type ProjectMemoryKind = "lesson" | "gotcha" | "context";

/** A single project-scoped memory row. */
export interface ProjectMemory {
  /** Stable internal identifier (UUID v4). */
  id: string;
  /** Owning project. Memories are loaded by `project_id`. */
  project_id: string;
  /** What this row represents. Drives system-prompt grouping. */
  kind: ProjectMemoryKind;
  /** Short headline, truncated to {@link PROJECT_MEMORY_TITLE_CAP} chars by {@link newProjectMemory}. */
  title: string;
  /** Markdown-friendly body. Truncated to {@link PROJECT_MEMORY_BODY_CAP} chars at construction. */
  body: string;
  /** Free-form tags. `#[serde(default)]`. */
  tags: string[];
  /** `RequirementRun.id` this memory was distilled from. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  source_run_id?: string;
  /** `Requirement.id` the source run was driving. `#[serde(skip_serializing_if = "Option::is_none")]`. */
  source_requirement_id?: string;
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp of the last edit. */
  updated_at: string;
}

/**
 * Hard cap on `body` at construction (4 KiB worth of chars). Longer rows are
 * silently truncated with a `…` marker.
 */
export const PROJECT_MEMORY_BODY_CAP = 4 * 1024;
/** Hard cap on `title` (chars). */
export const PROJECT_MEMORY_TITLE_CAP = 200;

/**
 * Truncate `s` to at most `cap` chars (Unicode scalar values, not bytes),
 * appending `…` if truncated. Mirrors Rust `truncate_chars`.
 */
function truncateChars(s: string, cap: number): string {
  const chars = [...s];
  if (chars.length <= cap) {
    return s;
  }
  return chars.slice(0, Math.max(cap - 1, 0)).join("") + "…";
}

/**
 * Build a fresh memory row with a UUID id and current timestamps. `body` is
 * truncated to {@link PROJECT_MEMORY_BODY_CAP} chars, title to
 * {@link PROJECT_MEMORY_TITLE_CAP}.
 */
export function newProjectMemory(
  projectId: string,
  kind: ProjectMemoryKind,
  title: string,
  body: string,
): ProjectMemory {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    kind,
    title: truncateChars(title, PROJECT_MEMORY_TITLE_CAP),
    body: truncateChars(body, PROJECT_MEMORY_BODY_CAP),
    tags: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Builder-style setter for `source_run_id` + the run's requirement id. Both
 * are typically set together by the auto-capture path. Mutates in place and
 * returns the same row (mirrors the Rust `with_source` ergonomics).
 */
export function withProjectMemorySource(
  memory: ProjectMemory,
  runId: string,
  requirementId: string,
): ProjectMemory {
  memory.source_run_id = runId;
  memory.source_requirement_id = requirementId;
  return memory;
}

/** Builder-style setter for `tags`. */
export function withProjectMemoryTags(memory: ProjectMemory, tags: string[]): ProjectMemory {
  memory.tags = tags;
  return memory;
}

/** Bump `updated_at`. Call after any mutation. */
export function touchProjectMemory(memory: ProjectMemory): void {
  memory.updated_at = new Date().toISOString();
}
