// Pure helpers for the resource-manager dialog.
//
// Side-effect-free so they're trivial to unit-test. The dialog calls
// these functions to derive defaults, dedupe lists, and decide what
// happens when the user picks a folder that may or may not be linked
// to an existing Project.
//
// Spec: `docs/proposals/new-session-resource-manager.zh-CN.md`
//   § "前端实现" → `resourceSelection.ts` listed helpers
//   § "交互细节"  → match-rule semantics

import type { Project, ProjectWorkspace } from "../../types/frames";
import type { ProjectDraft } from "./resourceSelectionTypes";

/// Strip a path down to its final non-empty segment, with `~`
/// preserved as-is for display purposes (caller is expected to have
/// expanded `~` upstream when sending to the server).
export function folderNameFromPath(path: string): string {
  if (!path) return "";
  // Trim trailing slashes (but never strip the "/" root itself).
  let p = path;
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) {
    p = p.slice(0, -1);
  }
  // Look for the last forward-slash or backslash.
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const tail = idx >= 0 ? p.slice(idx + 1) : p;
  return tail || p;
}

/// What happens when the user submits a folder path. Drives the
/// dialog's confirmation copy + the action on Confirm.
export type WorkspaceMatch =
  | { kind: "path_match"; project: Project; workspace: ProjectWorkspace }
  | { kind: "name_match_unique"; project: Project }
  | { kind: "name_match_ambiguous"; projects: Project[] }
  | { kind: "none" };

/// Resolve a folder path against the existing project list.
///
///  1. Strict canonical-path comparison wins — if the path is already
///     in some Project's `workspaces`, that Project is the match.
///  2. Otherwise, casefolded basename lookup against `name` and `slug`.
///  3. Multiple name hits → ambiguous; user must disambiguate by hand.
///  4. Otherwise → `none` (caller will offer to create a new Project).
export function matchProjectsForWorkspace(
  projects: Project[],
  canonicalPath: string,
  basename: string,
): WorkspaceMatch {
  const canon = canonicalPath.trim();
  if (canon) {
    for (const p of projects) {
      if (!p.workspaces) continue;
      for (const w of p.workspaces) {
        if (samePath(w.path, canon)) {
          return { kind: "path_match", project: p, workspace: w };
        }
      }
    }
  }

  const needle = basename.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  const nameHits: Project[] = [];
  for (const p of projects) {
    if (
      p.name.toLowerCase() === needle ||
      p.slug.toLowerCase() === needle
    ) {
      nameHits.push(p);
    }
  }
  if (nameHits.length === 1) return { kind: "name_match_unique", project: nameHits[0] };
  if (nameHits.length > 1) return { kind: "name_match_ambiguous", projects: nameHits };
  return { kind: "none" };
}

/// Compare two filesystem paths up to harmless trailing-slash noise.
/// Path probing is server-side, so by the time we call this both
/// strings have been canonicalised — a strict equals would also work
/// but trailing-slash hygiene is cheap insurance.
export function samePath(a: string, b: string): boolean {
  return stripTrailingSep(a) === stripTrailingSep(b);
}

function stripTrailingSep(p: string): string {
  if (!p) return p;
  let q = p;
  while (q.length > 1 && (q.endsWith("/") || q.endsWith("\\"))) {
    q = q.slice(0, -1);
  }
  return q;
}

/// Build the `Project` payload for `POST /v1/projects` when a folder
/// has no matching Project. Server enforces slug uniqueness — duplicates
/// get suffixed `-2` / `-3` automatically; we just pass our best guess.
///
/// The single-folder shape is the fast path; the multi-folder shape
/// derives the project name from the FIRST folder's basename and lists
/// every workspace path in the instructions body so the project's
/// per-turn system prompt explains the layout.
export function deriveProjectDraftFromWorkspace(info: {
  root: string;
  branch?: string | null;
}): ProjectDraft {
  return deriveProjectDraftFromWorkspaces([info.root]);
}

/// Multi-folder version. The first path drives the project name + slug
/// (matches what the user sees in the editor's first row); every path
/// is enumerated under "Workspaces:" in the instructions so the agent
/// has a clear picture of the project's reach without needing tool
/// calls.
export function deriveProjectDraftFromWorkspaces(roots: string[]): ProjectDraft {
  if (roots.length === 0) {
    return {
      name: "untitled",
      slug: "untitled",
      instructions: "Project context.",
    };
  }
  const primary = roots[0];
  const name = folderNameFromPath(primary) || "untitled";
  const lines: string[] = [`Project context for ${name}.`];
  if (roots.length === 1) {
    lines.push(`Workspace: ${roots[0]}`);
  } else {
    lines.push(`Workspaces:`);
    for (const r of roots) lines.push(`- ${r}`);
  }
  return {
    name,
    slug: slugify(name),
    instructions: lines.join("\n"),
  };
}

/// Lower-cased ASCII slug used as the Project's `slug` field. Server
/// re-validates and de-duplicates — this just gets us close enough on
/// the first try.
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

/// Pick the default workspace path for a Project that the user just
/// selected without explicitly choosing a folder. Order:
///   1. The Project's first workspace (Project remembers what folder
///      it was last used with — preserving that across sessions is
///      what users expect);
///   2. The current global baseline (server startup root);
///   3. `null` — the session will run against the server's default
///      and the Project just contributes instructions.
export function resolveDefaultWorkspaceForProject(
  project: Project,
  baseline: string | null,
): string | null {
  if (project.workspaces && project.workspaces.length > 0) {
    return project.workspaces[0].path;
  }
  return baseline ?? null;
}

/// Shorten a long absolute path for display in a list row. Keeps the
/// last two path segments (`.../GitHub/Jarvis`) when the source is
/// long; otherwise returns the input unchanged.
export function compactResourceLabel(path: string, max = 48): string {
  if (!path || path.length <= max) return path;
  // Prefer keeping the trailing two segments — they're the meaningful
  // "where am I" bit. If even those exceed the budget, fall back to
  // an end-truncation so the basename stays visible.
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join("/");
    const candidate = `…/${tail}`;
    if (candidate.length <= max) return candidate;
  }
  return "…" + path.slice(-(max - 1));
}

/// Dedupe a workspace list by canonical path. The server-side recent
/// list and a Project's bound workspace list can carry the same
/// canonical path; the dialog renders one row per unique path.
export function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of items) {
    const key = stripTrailingSep(x.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}
