// Document workspace value types — `DocProject` + `DocDraft`.
//
// Ported from crates/harness-project/src/doc.rs. Each DocProject lives under
// a workspace (the pinned root) and carries one or more Markdown drafts
// owned by DocDraft. Multiple drafts per project are allowed; the v0 UI
// surfaces only the most-recent one.

/**
 * Document type. Wire form lowercase snake_case. Renderers should treat
 * unknown values as `note` for forward-compat.
 */
export type DocKind = "note" | "research" | "report" | "design" | "guide";

const DOC_KINDS: readonly DocKind[] = ["note", "research", "report", "design", "guide"];

/** Parse a wire string. `undefined` for unrecognised values. */
export function docKindFromWire(s: string): DocKind | undefined {
  return (DOC_KINDS as readonly string[]).includes(s) ? (s as DocKind) : undefined;
}

/**
 * One document workspace — a folder for a single piece of writing (note,
 * research bundle, technical design, report, user guide).
 */
export interface DocProject {
  /** Stable identifier (UUID v4). */
  id: string;
  /** Canonicalised absolute path of the parent workspace this doc belongs to. */
  workspace: string;
  /** Display title. */
  title: string;
  /** Genre. */
  kind: DocKind;
  /** RFC-3339 / ISO-8601 timestamp. */
  created_at: string;
  /** RFC-3339; bumped on every mutation. */
  updated_at: string;
  /** Free-form labels for cross-kind organisation. `#[serde(default)]`. */
  tags: string[];
  /** Soft "favourite" flag. `#[serde(default)]`. */
  pinned: boolean;
  /** Soft delete / archive flag. `#[serde(default)]`. */
  archived: boolean;
}

/**
 * Mint a new project with a fresh UUID, current timestamps, and kind `note`
 * by default.
 */
export function newDocProject(workspace: string, title: string): DocProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    workspace,
    title,
    kind: "note",
    created_at: now,
    updated_at: now,
    tags: [],
    pinned: false,
    archived: false,
  };
}

/** Bump `updated_at` to "now". Call from every mutator. */
export function touchDocProject(project: DocProject): void {
  project.updated_at = new Date().toISOString();
}

/**
 * One Markdown draft. Multiple per project are allowed (versioning /
 * alternates); v0 UIs read the most-recent one by `updated_at`.
 */
export interface DocDraft {
  /** Stable identifier (UUID v4). */
  id: string;
  /** Foreign key into `DocProject.id`. */
  project_id: string;
  /** Always `"markdown"` in v0. */
  format: string;
  /** The full body. v0 rewrites the row on every save (no diff storage). */
  content: string;
  /** RFC-3339 timestamp of creation. */
  created_at: string;
  /** RFC-3339; bumped on every save. */
  updated_at: string;
}

/** Mint a new Markdown draft. */
export function newDocDraft(projectId: string, content: string): DocDraft {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project_id: projectId,
    format: "markdown",
    content,
    created_at: now,
    updated_at: now,
  };
}

/** Bump a draft's `updated_at`. */
export function touchDocDraft(draft: DocDraft): void {
  draft.updated_at = new Date().toISOString();
}

/**
 * Broadcast envelope sent on every successful DocStore mutation. Serde
 * shape: `#[serde(tag = "type", rename_all = "snake_case")]`. Newtype
 * variants flatten the inner struct's fields next to `type`.
 */
export type DocEvent =
  | ({ type: "project_upserted" } & DocProject)
  | { type: "project_deleted"; workspace: string; id: string }
  | ({ type: "draft_upserted" } & DocDraft);

/**
 * Workspace key the event targets. Draft events don't carry the workspace
 * inline, so this returns `undefined` for them (matching Rust `Option<&str>`).
 */
export function docEventWorkspace(ev: DocEvent): string | undefined {
  switch (ev.type) {
    case "project_upserted":
    case "project_deleted":
      return ev.workspace;
    case "draft_upserted":
      return undefined;
  }
}
