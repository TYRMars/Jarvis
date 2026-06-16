// Project domain — `Project` + everything that hangs off it.
//
// Ported from crates/harness-project/src/project.rs. A `Project` is a
// reusable, named context container that can be attached to a Conversation
// at creation time. The wire shape is the JSON serialisation of the Rust
// struct, so field names + optionality are preserved EXACTLY.

/**
 * A workspace folder a {@link Project} knows about.
 *
 * Paths are stored verbatim — canonicalisation is the caller's job
 * (the REST layer canonicalises on insert).
 */
export interface ProjectWorkspace {
  /**
   * Filesystem path. Expected to be absolute and canonical, but the type
   * does not enforce that.
   */
  path: string;
  /**
   * Optional display label. When absent, UIs fall back to the last path
   * segment. `#[serde(skip_serializing_if = "Option::is_none")]` → omitted
   * when undefined.
   */
  name?: string;
}

/** Convenience constructor for a workspace without a display name. */
export function newProjectWorkspace(path: string): ProjectWorkspace {
  return { path };
}

/**
 * Per-project automation policy. The default is enabled so existing
 * deployments keep the historical "all approved projects are eligible"
 * behaviour until an operator pauses a specific project.
 */
export interface ProjectAutomation {
  /** `#[serde(default = "default_auto_mode_enabled")]` → defaults to true. */
  auto_mode_enabled: boolean;
}

/** The default automation policy (auto-mode enabled). */
export function defaultProjectAutomation(): ProjectAutomation {
  return { auto_mode_enabled: true };
}

/**
 * Mirror of Rust `is_default_automation` — used to decide whether
 * `automation` is skipped on the wire (`skip_serializing_if`).
 */
export function automationIsDefault(value: ProjectAutomation): boolean {
  return value.auto_mode_enabled === true;
}

/**
 * One user-configurable column on a project's kanban board. Stored inline
 * on the {@link Project}.
 */
export interface KanbanColumn {
  /**
   * Stable id; what `Requirement.status` references. Validated as non-empty
   * + ≤ 64 bytes by {@link validateColumnId}. Built-in defaults use
   * `"backlog"` / `"in_progress"` / `"review"` / `"done"`.
   */
  id: string;
  /** Display label. Free-form, language-of-the-user. */
  label: string;
  /**
   * Optional kind hint that drives the icon. Recognised values: `"backlog"`
   * / `"in_progress"` / `"review"` / `"done"`. Custom columns omit this.
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  kind?: string;
}

/**
 * A reusable, named bundle of instructions / context that can be bound to
 * one or more Conversations. The wire shape is the JSON serialisation of
 * this struct.
 */
export interface Project {
  /** Stable internal identifier (UUID v4). */
  id: string;
  /** Human-readable, URL/CLI-friendly handle. Globally unique within a store. */
  slug: string;
  /** Display name. Free-form, not unique. */
  name: string;
  /**
   * Optional one-liner shown in pickers / sidebars.
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  description?: string;
  /** The body injected into the system prompt for any bound conversation. */
  instructions: string;
  /** Free-form tags; useful for UI grouping. Order is preserved. */
  tags: string[];
  /** Workspace folders associated with this project. Order is preserved. */
  workspaces: ProjectWorkspace[];
  /** Soft-delete flag. Archived projects are hidden from default listings. */
  archived: boolean;
  /**
   * Custom kanban columns. When absent, clients fall back to the four
   * built-in defaults (see {@link defaultKanbanColumns}).
   * `#[serde(skip_serializing_if = "Option::is_none")]`.
   */
  columns?: KanbanColumn[];
  /**
   * Per-project automation policy. Omitted on the wire when it equals the
   * default (`skip_serializing_if = "is_default_automation"`).
   */
  automation?: ProjectAutomation;
  /** RFC-3339 / ISO-8601 timestamp of creation. */
  created_at: string;
  /** RFC-3339 / ISO-8601 timestamp of the last mutation. */
  updated_at: string;
}

/**
 * The four built-in columns used when a project has no customised `columns`
 * set. Ids match the legacy `RequirementStatus` wire form.
 */
export function defaultKanbanColumns(): KanbanColumn[] {
  return [
    { id: "backlog", label: "Backlog", kind: "backlog" },
    { id: "in_progress", label: "In Progress", kind: "in_progress" },
    { id: "review", label: "Review", kind: "review" },
    { id: "done", label: "Done", kind: "done" },
  ];
}

/**
 * Validate a single column id for shape (not for uniqueness within a
 * project). Same charset as a slug: lowercase ASCII / digits / `_` / `-`,
 * 1–64 bytes. Returns a human-readable reason on failure, or `null` when ok.
 */
export function validateColumnId(id: string): string | null {
  if (id.length === 0) {
    return "column id must not be empty";
  }
  if (id.length > 64) {
    return "column id must be at most 64 characters";
  }
  if (!/^[a-z0-9_-]+$/.test(id)) {
    return "column id must contain only lowercase ascii, digits, '_' and '-'";
  }
  return null;
}

/**
 * Mint a new project with a fresh UUID v4 id and current timestamps. `slug`
 * is left empty — the caller is expected to set one (see {@link deriveSlug}).
 * `columns` is absent ("use the four built-in defaults") and `automation`
 * is the default policy.
 */
export function newProject(name: string, instructions: string): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    slug: "",
    name,
    instructions,
    tags: [],
    workspaces: [],
    archived: false,
    automation: defaultProjectAutomation(),
    created_at: now,
    updated_at: now,
  };
}

/** Refresh `updated_at` to "now". Called by every mutator. */
export function touchProject(project: Project): void {
  project.updated_at = new Date().toISOString();
}

/** Replace `slug`; bumps `updated_at`. */
export function setProjectSlug(project: Project, slug: string): void {
  project.slug = slug;
  touchProject(project);
}

/** Replace `name`; bumps `updated_at`. */
export function setProjectName(project: Project, name: string): void {
  project.name = name;
  touchProject(project);
}

/** Replace `description`; bumps `updated_at`. Pass `undefined` to clear. */
export function setProjectDescription(project: Project, description: string | undefined): void {
  project.description = description;
  touchProject(project);
}

/** Replace `instructions`; bumps `updated_at`. */
export function setProjectInstructions(project: Project, instructions: string): void {
  project.instructions = instructions;
  touchProject(project);
}

/** Replace `tags`; bumps `updated_at`. */
export function setProjectTags(project: Project, tags: string[]): void {
  project.tags = tags;
  touchProject(project);
}

/** Replace `workspaces`; bumps `updated_at`. */
export function setProjectWorkspaces(project: Project, workspaces: ProjectWorkspace[]): void {
  project.workspaces = workspaces;
  touchProject(project);
}

/** Replace the automation policy; bumps `updated_at`. */
export function setProjectAutomation(project: Project, automation: ProjectAutomation): void {
  project.automation = automation;
  touchProject(project);
}

/** Mark the project as soft-deleted. Idempotent. */
export function archiveProject(project: Project): void {
  if (!project.archived) {
    project.archived = true;
    touchProject(project);
  }
}

/** Restore a soft-deleted project. Idempotent. */
export function unarchiveProject(project: Project): void {
  if (project.archived) {
    project.archived = false;
    touchProject(project);
  }
}

/**
 * Produce the public wire object for a Project so `JSON.stringify(projectToWire(p))`
 * matches the Rust serialisation.
 *
 * The only non-`Option` field carrying a `skip_serializing_if` is `automation`
 * (`skip_serializing_if = "is_default_automation"`): it is omitted on the wire
 * when it equals the default (auto-mode enabled). {@link newProject} always
 * seeds the default in-memory, so a naive `JSON.stringify(project)` would
 * leak `"automation":{"auto_mode_enabled":true}` — a shape the Rust server
 * never emits. Every other optional / empty-collection field is simply absent
 * in-memory when defaulted, so `JSON.stringify` omits it naturally.
 *
 * Mirrors {@link requirementToWire}.
 */
export function projectToWire(project: Project): Project {
  const wire: Project = { ...project };
  if (wire.automation !== undefined && automationIsDefault(wire.automation)) {
    delete wire.automation;
  }
  return wire;
}

/**
 * Convert a free-form name into a URL-safe ASCII slug.
 *
 * Rules: lowercase; keep `[a-z0-9]`, replace anything else with `-`;
 * collapse runs of `-`; trim leading/trailing; cap at 64 chars; if empty
 * after that, return a short random fragment.
 *
 * Uniqueness is the caller's job — this just produces a candidate.
 */
export function deriveSlug(name: string): string {
  let out = "";
  let prevDash = true; // suppress leading '-'
  for (const ch of name) {
    const lower = ch.toLowerCase();
    if (/^[a-z0-9]$/.test(lower)) {
      out += lower;
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.endsWith("-")) {
    out = out.slice(0, -1);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    while (out.endsWith("-")) {
      out = out.slice(0, -1);
    }
  }
  if (out.length === 0) {
    // Last resort — pick a few hex chars from a fresh UUID.
    out = crypto.randomUUID().slice(0, 8);
  }
  return out;
}

/**
 * Validate that a slug is well-formed for storage. Returns `null` for
 * `[a-z0-9-]{1,64}` that doesn't start or end with `-`. Anything else
 * returns a human-readable reason.
 */
export function validateSlug(slug: string): string | null {
  if (slug.length === 0) {
    return "slug must not be empty";
  }
  if (slug.length > 64) {
    return "slug must be at most 64 characters";
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return "slug must not start or end with '-'";
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return "slug must contain only lowercase ascii, digits, and '-'";
  }
  return null;
}
