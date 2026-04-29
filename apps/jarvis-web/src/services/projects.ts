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
import type { Project } from "../types/frames";
import { apiUrl } from "./api";
import { showError } from "./status";

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
  archived?: boolean;
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
      updated_at: new Date().toISOString(),
    };
    return found;
  });
  if (found) writeLocalProjects(rows);
  return found;
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
