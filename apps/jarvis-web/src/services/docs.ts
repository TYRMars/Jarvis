// Service layer for the `/docs` page — DocProject + DocDraft.
//
// Server-backed. The /docs UI:
//   1. fetches GET /v1/doc-projects on mount and on workspace change;
//   2. updates an in-memory cache + draft cache;
//   3. fires PUT /v1/doc-projects/:id/draft on save (debounced in
//      the page);
//   4. listens to WS frames `doc_project_upserted`,
//      `doc_project_deleted`, `doc_draft_upserted` for cross-tab
//      live updates (handled in `frames.ts` via the `apply*`
//      exports below).
//
// Wire types live in `../types/frames.ts` and mirror
// `crates/harness-core/src/doc.rs`.

import type { DocDraft, DocKind, DocProject } from "../types/frames";
import { apiUrl } from "./api";
import { showError } from "./status";

// ---------- in-memory caches + subscribers -------------------------

const projectsByWorkspace: Map<string, DocProject[]> = new Map();
const draftByProject: Map<string, DocDraft | null> = new Map();
const subscribers = new Set<() => void>();
/// Workspace key the server most-recently confirmed for a list
/// fetch. The Web UI uses this as a fallback when the page doesn't
/// know the server-pinned workspace path (`socketWorkspace` is
/// null) — instead of guessing or showing "no docs", we read from
/// whatever key the server actually populated.
let lastLoadedWorkspace: string | null = null;

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("docs subscriber threw", e);
    }
  }
}

function sortProjects(workspace: string): void {
  const list = projectsByWorkspace.get(workspace);
  if (!list) return;
  list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ---------- public synchronous reads -------------------------------

export function listDocProjects(workspace: string): DocProject[] {
  // Prefer the requested workspace; fall back to the most-recent
  // server response when the caller didn't know the pinned root
  // (`workspace === ""` / no value).
  const direct = projectsByWorkspace.get(workspace);
  if (direct) return direct.slice();
  if (!workspace && lastLoadedWorkspace) {
    return projectsByWorkspace.get(lastLoadedWorkspace)?.slice() ?? [];
  }
  return [];
}

/// The workspace key the server most-recently confirmed. Useful
/// when the page didn't know the canonical pinned root.
export function getLastLoadedWorkspace(): string | null {
  return lastLoadedWorkspace;
}

export function getDocDraft(projectId: string): DocDraft | null {
  return draftByProject.get(projectId) ?? null;
}

export function subscribeDocs(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// ---------- async loaders ------------------------------------------

interface ListResponse {
  workspace: string;
  items: DocProject[];
}

export async function loadDocProjects(workspace?: string): Promise<void> {
  try {
    const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await fetch(apiUrl(`/v1/doc-projects${qs}`));
    if (r.status === 503) {
      // No store configured — leave the cache as-is.
      notify();
      return;
    }
    if (!r.ok) throw new Error(`doc-projects list: ${r.status}`);
    const body = (await r.json()) as ListResponse;
    projectsByWorkspace.set(body.workspace, body.items.slice());
    sortProjects(body.workspace);
    lastLoadedWorkspace = body.workspace;
    notify();
  } catch (e) {
    console.warn("doc projects fetch failed", e);
    notify();
  }
}

export async function loadDocDraft(projectId: string): Promise<void> {
  try {
    const r = await fetch(
      apiUrl(`/v1/doc-projects/${encodeURIComponent(projectId)}/draft`),
    );
    if (r.status === 503 || r.status === 404) {
      draftByProject.set(projectId, null);
      notify();
      return;
    }
    if (!r.ok) throw new Error(`doc draft fetch: ${r.status}`);
    const body = await r.json();
    draftByProject.set(projectId, body && body.id ? (body as DocDraft) : null);
    notify();
  } catch (e) {
    console.warn("doc draft fetch failed", e);
    notify();
  }
}

// ---------- mutations ----------------------------------------------

export interface CreateDocProjectInput {
  title: string;
  kind?: DocKind;
  workspace?: string;
}

export async function createDocProject(
  input: CreateDocProjectInput,
): Promise<DocProject | null> {
  try {
    const r = await fetch(apiUrl("/v1/doc-projects"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (r.status === 503) {
      showError("doc store not configured");
      return null;
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not create doc: ${r.status} ${body}`);
      return null;
    }
    const project = (await r.json()) as DocProject;
    upsertLocalProject(project);
    return project;
  } catch (e: any) {
    showError(`could not create doc: ${e?.message || e}`);
    return null;
  }
}

export async function updateDocProject(
  id: string,
  patch: { title?: string; kind?: DocKind },
): Promise<DocProject | null> {
  try {
    const r = await fetch(apiUrl(`/v1/doc-projects/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    const next = (await r.json()) as DocProject;
    upsertLocalProject(next);
    return next;
  } catch {
    return null;
  }
}

export async function deleteDocProject(id: string): Promise<boolean> {
  try {
    const r = await fetch(apiUrl(`/v1/doc-projects/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (r.status === 404) {
      removeLocalProject(id);
      return true;
    }
    if (!r.ok) return false;
    removeLocalProject(id);
    return true;
  } catch {
    return false;
  }
}

export async function saveDocDraft(
  projectId: string,
  content: string,
): Promise<DocDraft | null> {
  try {
    const r = await fetch(
      apiUrl(`/v1/doc-projects/${encodeURIComponent(projectId)}/draft`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      showError(`could not save draft: ${r.status} ${body}`);
      return null;
    }
    const draft = (await r.json()) as DocDraft;
    draftByProject.set(projectId, draft);
    notify();
    return draft;
  } catch (e: any) {
    showError(`could not save draft: ${e?.message || e}`);
    return null;
  }
}

// ---------- WS frame appliers (called from frames.ts) -------------

export function applyDocProjectUpserted(p: DocProject): void {
  upsertLocalProject(p);
}

export function applyDocProjectDeleted(id: string): void {
  removeLocalProject(id);
}

export function applyDocDraftUpserted(d: DocDraft): void {
  draftByProject.set(d.project_id, d);
  notify();
}

// ---------- internal helpers --------------------------------------

function upsertLocalProject(p: DocProject): void {
  const list = projectsByWorkspace.get(p.workspace) ?? [];
  const i = list.findIndex((r) => r.id === p.id);
  if (i >= 0) list[i] = p;
  else list.unshift(p);
  projectsByWorkspace.set(p.workspace, list);
  sortProjects(p.workspace);
  notify();
}

function removeLocalProject(id: string): void {
  for (const [ws, list] of projectsByWorkspace.entries()) {
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) projectsByWorkspace.delete(ws);
      else projectsByWorkspace.set(ws, list);
      // Drop draft cache entry too.
      draftByProject.delete(id);
      notify();
      return;
    }
  }
}
