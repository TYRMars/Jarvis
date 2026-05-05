// Project CRUD over the REST API. Mirrors `harness-server::projects`:
// the surface returns 503 when the server has no project store
// configured, in which case the local `setProjectsAvailable(false)`
// kill-switch hides the UI affordances entirely.
//
// The store is the source of truth for project rows; this module only
// dispatches HTTP and pushes results back into the store via the
// matching setter. Errors are surfaced through the shared banner so
// the user sees them without each component having to thread their
// own error state.

import { appStore } from "../store/appStore";
import type { KanbanColumn, Project, ProjectWorkspace } from "../types/frames";
import { apiUrl } from "./api";
import { showError } from "./status";

/// Per-workspace Git status returned by
/// `GET /v1/projects/:id/workspaces/status`. Mirrors the server-side
/// row shape — `branch` / `head` / `dirty` are present only when
/// `vcs == "git"` succeeded; `error` is present only on probe
/// failures (e.g. the path was deleted, or the total budget elapsed).
export interface ProjectWorkspaceStatus {
  path: string;
  name?: string | null;
  vcs: "git" | "none" | "unknown";
  branch?: string | null;
  head?: string | null;
  dirty?: boolean;
  error?: string | null;
}

let projectsListSeq = 0;
const LOCAL_PROJECTS_KEY = "jarvis.productProjects.v1";
export const LOCAL_PROJECT_PREFIX = "product-";

export async function refreshProjects(includeArchived = false): Promise<void> {
  const mySeq = ++projectsListSeq;
  try {
    const r = await fetch(
      apiUrl(`/v1/projects?limit=100&include_archived=${includeArchived}`),
    );
    if (mySeq !== projectsListSeq) return;
    if (r.status === 503) {
      appStore.getState().setProjectsAvailable(true);
      appStore.getState().setProjects(localProjects(includeArchived));
      return;
    }
    if (!r.ok) throw new Error(`projects list: ${r.status}`);
    const rows: Project[] = await r.json();
    if (mySeq !== projectsListSeq) return;
    appStore.getState().setProjectsAvailable(true);
    appStore.getState().setProjects(rows);
  } catch (e: any) {
    if (mySeq !== projectsListSeq) return;
    console.warn("projects fetch failed", e);
    appStore.getState().setProjectsAvailable(true);
    appStore.getState().setProjects(localProjects(includeArchived));
  }
}

export interface CreateProjectInput {
  name: string;
  instructions?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  workspaces?: ProjectWorkspace[];
}

export async function createProject(input: CreateProjectInput): Promise<Project | null> {
  const payload = {
    ...input,
    instructions:
      input.instructions?.trim() ||
      input.description?.trim() ||
      "Product planning workspace.",
  };
  try {
    const r = await fetch(apiUrl("/v1/projects"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.status === 503) {
      const p = createLocalProject(input);
      appStore.getState().upsertProject(p);
      return p;
    }
    if (!r.ok) {
      const body = await safeBody(r);
      throw new Error(body?.error ?? `create: ${r.status}`);
    }
    const p: Project = await r.json();
    appStore.getState().upsertProject(p);
    invalidateWorkspaceStatusCache(p.id);
    return p;
  } catch (e: any) {
    console.warn("project create failed; using local product project", e);
    const p = createLocalProject(input);
    appStore.getState().upsertProject(p);
    return p;
  }
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  /// `undefined` leaves the list untouched. `[]` clears it.
  workspaces?: ProjectWorkspace[];
  archived?: boolean;
  /// `undefined` leaves the list untouched. `[]` reverts to the
  /// four built-in defaults. Otherwise replaces the customised
  /// column set wholesale.
  columns?: KanbanColumn[];
}

export async function updateProject(
  idOrSlug: string,
  patch: UpdateProjectInput,
): Promise<Project | null> {
  if (isLocalProjectId(idOrSlug)) {
    const p = updateLocalProject(idOrSlug, patch);
    if (p) appStore.getState().upsertProject(p);
    return p;
  }
  try {
    const r = await fetch(apiUrl(`/v1/projects/${encodeURIComponent(idOrSlug)}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const body = await safeBody(r);
      throw new Error(body?.error ?? `update: ${r.status}`);
    }
    const p: Project = await r.json();
    appStore.getState().upsertProject(p);
    invalidateWorkspaceStatusCache(p.id);
    return p;
  } catch (e: any) {
    showError(`Update project: ${e.message ?? e}`);
    return null;
  }
}

/// Soft-delete by default (matches REST `DELETE /v1/projects/:id`
/// without `?hard=true`). The row stays in the store flipped to
/// `archived: true` so the UI can offer a restore.
export async function archiveProject(idOrSlug: string): Promise<boolean> {
  if (isLocalProjectId(idOrSlug)) {
    const p = updateLocalProject(idOrSlug, { archived: true });
    if (p) appStore.getState().upsertProject(p);
    if (appStore.getState().activeProjectFilter === idOrSlug) {
      appStore.getState().setActiveProjectFilter(null);
    }
    return !!p;
  }
  try {
    const r = await fetch(apiUrl(`/v1/projects/${encodeURIComponent(idOrSlug)}`), {
      method: "DELETE",
    });
    if (!r.ok) {
      const body = await safeBody(r);
      throw new Error(body?.error ?? `archive: ${r.status}`);
    }
    // Update local state to reflect the archive.
    const existing = appStore.getState().projectsById[idOrSlug];
    if (existing) {
      appStore.getState().upsertProject({ ...existing, archived: true });
    } else {
      // Could be a slug-keyed call — refresh.
      void refreshProjects();
    }
    // If the user was filtered to it, drop the filter so they see all
    // conversations again.
    if (appStore.getState().activeProjectFilter === idOrSlug) {
      appStore.getState().setActiveProjectFilter(null);
    }
    return true;
  } catch (e: any) {
    showError(`Archive project: ${e.message ?? e}`);
    return false;
  }
}

export async function restoreProject(idOrSlug: string): Promise<boolean> {
  if (isLocalProjectId(idOrSlug)) {
    const p = updateLocalProject(idOrSlug, { archived: false });
    if (p) appStore.getState().upsertProject(p);
    return !!p;
  }
  try {
    const r = await fetch(apiUrl(`/v1/projects/${encodeURIComponent(idOrSlug)}/restore`), {
      method: "POST",
    });
    if (!r.ok) {
      const body = await safeBody(r);
      throw new Error(body?.error ?? `restore: ${r.status}`);
    }
    const p: Project = await r.json();
    appStore.getState().upsertProject(p);
    return true;
  } catch (e: any) {
    showError(`Restore project: ${e.message ?? e}`);
    return false;
  }
}

async function safeBody(r: Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export function isLocalProjectId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(LOCAL_PROJECT_PREFIX);
}

function localProjects(includeArchived: boolean): Project[] {
  const rows = readLocalProjects();
  return includeArchived ? rows : rows.filter((p) => !p.archived);
}

function createLocalProject(input: CreateProjectInput): Project {
  const now = new Date().toISOString();
  const existing = readLocalProjects();
  const slug = uniqueSlug(input.slug || deriveSlug(input.name), existing);
  const project: Project = {
    id: `${LOCAL_PROJECT_PREFIX}${randomId()}`,
    slug,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    instructions: input.instructions?.trim() || "",
    tags: input.tags || [],
    workspaces: input.workspaces ? [...input.workspaces] : [],
    archived: false,
    created_at: now,
    updated_at: now,
    conversation_count: 0,
  };
  writeLocalProjects([project, ...existing]);
  return project;
}

function updateLocalProject(id: string, patch: UpdateProjectInput): Project | null {
  let found: Project | null = null;
  const rows = readLocalProjects().map((p) => {
    if (p.id !== id && p.slug !== id) return p;
    found = {
      ...p,
      ...patch,
      description: patch.description === undefined ? p.description : patch.description,
      tags: patch.tags === undefined ? p.tags : patch.tags,
      workspaces: patch.workspaces === undefined ? p.workspaces : patch.workspaces,
      updated_at: new Date().toISOString(),
    };
    return found;
  });
  if (found) writeLocalProjects(rows);
  return found;
}

// ----------------------- workspace status -----------------------

/// `GET /v1/projects/:id/workspaces/status` — agg git probe for each
/// of a project's `workspaces`. Cached in-process for 5 seconds so a
/// repeatedly-opened picker popover doesn't re-shell out to git.
///
/// Returns `[]` for:
/// - local-only projects (the project never reached the server)
/// - servers that pre-date the endpoint (404 → graceful degrade)
const STATUS_CACHE_TTL_MS = 5_000;
const statusCache: Map<string, { at: number; rows: ProjectWorkspaceStatus[] }> =
  new Map();

export async function fetchProjectWorkspaceStatuses(
  idOrSlug: string,
): Promise<ProjectWorkspaceStatus[]> {
  if (isLocalProjectId(idOrSlug)) {
    // Local projects never had their workspaces probed — return the
    // recorded paths with `vcs: "unknown"` so the UI can still render
    // them without lying about Git state.
    const local = readLocalProjects().find(
      (p) => p.id === idOrSlug || p.slug === idOrSlug,
    );
    return (local?.workspaces ?? []).map((w) => ({
      path: w.path,
      name: w.name ?? null,
      vcs: "unknown" as const,
    }));
  }
  const cached = statusCache.get(idOrSlug);
  if (cached && Date.now() - cached.at < STATUS_CACHE_TTL_MS) {
    return cached.rows;
  }
  try {
    const r = await fetch(
      apiUrl(`/v1/projects/${encodeURIComponent(idOrSlug)}/workspaces/status`),
    );
    if (r.status === 404 || r.status === 503) {
      // Either: project doesn't exist, or server pre-dates the endpoint.
      // Either way the UI degrades to "no live status".
      const rows: ProjectWorkspaceStatus[] = [];
      statusCache.set(idOrSlug, { at: Date.now(), rows });
      return rows;
    }
    if (!r.ok) throw new Error(`workspaces/status: ${r.status}`);
    const rows: ProjectWorkspaceStatus[] = await r.json();
    statusCache.set(idOrSlug, { at: Date.now(), rows });
    return rows;
  } catch (e: any) {
    console.warn("workspaces/status fetch failed", e);
    return [];
  }
}

/// Drop the cached status for a project (or all projects) — call
/// after the project's workspaces list mutates so the next popover
/// open re-probes.
export function invalidateWorkspaceStatusCache(idOrSlug?: string): void {
  if (idOrSlug) {
    statusCache.delete(idOrSlug);
  } else {
    statusCache.clear();
  }
}

// ----------------------- workspace branches / switch -----------------------

/// Mirrors `GET /v1/projects/:id/workspaces/branches`.
export interface ProjectWorkspaceBranches {
  current: string | null;
  branches: { name: string; is_current: boolean; is_remote: boolean }[];
}

/// `GET /v1/projects/:id/workspaces/branches?path=<canonical>` — list
/// local + remote branches for one of a project's workspaces. No
/// caching: branches change underfoot (user typed `git branch foo` in
/// the terminal) and the popover only opens on demand.
export async function fetchProjectWorkspaceBranches(
  idOrSlug: string,
  path: string,
): Promise<ProjectWorkspaceBranches> {
  if (isLocalProjectId(idOrSlug)) {
    return { current: null, branches: [] };
  }
  const url = apiUrl(
    `/v1/projects/${encodeURIComponent(idOrSlug)}/workspaces/branches?path=${encodeURIComponent(path)}`,
  );
  const r = await fetch(url);
  if (r.status === 404 || r.status === 503) {
    return { current: null, branches: [] };
  }
  if (!r.ok) {
    const body = await safeBody(r);
    throw new Error(body?.error ?? `branches: ${r.status}`);
  }
  return (await r.json()) as ProjectWorkspaceBranches;
}

export type SwitchWorkspaceMode = "worktree" | "checkout";

export interface SwitchWorkspaceResult {
  active_path: string;
  branch: string;
  mode: SwitchWorkspaceMode;
}

/// `POST /v1/projects/:id/workspaces/switch` — either creates a
/// worktree (default) or `git checkout`s the workspace itself.
///
/// On a `checkout` mode dirty-tree refusal the server returns 409
/// with `{error: "dirty", dirty_files: [...]}`; we surface that as a
/// thrown `DirtyWorkspaceError` so the caller can ask the user to
/// confirm and retry with `force=true`.
export class DirtyWorkspaceError extends Error {
  constructor(
    message: string,
    public dirtyFiles: string[],
  ) {
    super(message);
    this.name = "DirtyWorkspaceError";
  }
}

export async function switchProjectWorkspace(
  idOrSlug: string,
  path: string,
  branch: string,
  mode: SwitchWorkspaceMode,
  opts: { force?: boolean } = {},
): Promise<SwitchWorkspaceResult> {
  const r = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(idOrSlug)}/workspaces/switch`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, branch, mode, force: !!opts.force }),
    },
  );
  if (r.status === 409) {
    const body = await safeBody(r);
    throw new DirtyWorkspaceError(
      body?.error ?? "workspace is dirty",
      Array.isArray(body?.dirty_files) ? body.dirty_files : [],
    );
  }
  if (!r.ok) {
    const body = await safeBody(r);
    throw new Error(body?.error ?? `switch: ${r.status}`);
  }
  const result = (await r.json()) as SwitchWorkspaceResult;
  invalidateWorkspaceStatusCache(idOrSlug);
  return result;
}

function readLocalProjects(): Project[] {
  try {
    const raw = localStorage.getItem(LOCAL_PROJECTS_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeLocalProjects(rows: Project[]): void {
  localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(rows));
}

function deriveSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || `project-${randomId().slice(0, 6)}`;
}

function uniqueSlug(seed: string, rows: Project[]): string {
  const candidate = deriveSlug(seed);
  const taken = new Set(rows.map((p) => p.slug));
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 100; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${randomId().slice(0, 4)}`;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
