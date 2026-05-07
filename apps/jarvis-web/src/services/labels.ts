// Service layer for Phase 3.8 project-scoped Labels.
//
// Two caches:
//
// 1. `byProject: Map<projectId, Label[]>` — what the project board
//    settings panel iterates over. Subscribers fire per-project so
//    a board only re-renders when *its* labels change.
// 2. `byId: Map<labelId, Label>` — what the kanban looks up when
//    rendering chips on a Requirement row. Refreshed eagerly from
//    every list / mutation so the chip rendering path is purely
//    synchronous.
//
// The two are kept in sync manually (no derived-store machinery —
// total population is small enough that the cost of a `Map.values()`
// rebuild is negligible).
//
// REST endpoints (see `crates/harness-server/src/labels_routes.rs`):
//   GET    /v1/projects/:pid/labels  -> { items: Label[] }
//   POST   /v1/projects/:pid/labels  -> Label (201)
//   PATCH  /v1/labels/:lid           -> Label
//   DELETE /v1/labels/:lid           -> { deleted: true, ... }

import type { Label } from "../types/frames";
import { apiUrl } from "./api";

// ---------- caches + subscribers -----------------------------------

const byProject: Map<string, Label[]> = new Map();
const byId: Map<string, Label> = new Map();
const subscribers = new Map<string, Set<() => void>>();
/** Subscribers that want to know about *any* label change (kanban
 * chip lookups, mostly). Populated by `subscribeAllLabels`. */
const globalSubscribers = new Set<() => void>();

function notify(projectId: string): void {
  const set = subscribers.get(projectId);
  if (set) {
    for (const s of set) {
      try {
        s();
      } catch (e) {
        console.warn("labels subscriber threw", e);
      }
    }
  }
  for (const s of globalSubscribers) {
    try {
      s();
    } catch (e) {
      console.warn("labels global subscriber threw", e);
    }
  }
}

function reindexById(): void {
  byId.clear();
  for (const list of byProject.values()) {
    for (const l of list) byId.set(l.id, l);
  }
}

export function subscribeLabels(
  projectId: string,
  fn: () => void,
): () => void {
  const set = subscribers.get(projectId) ?? new Set();
  subscribers.set(projectId, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(projectId);
  };
}

/**
 * Fires whenever **any** project's label cache mutates. Used by the
 * kanban chip rendering to repaint when a label rename / recolour
 * happens in the settings panel.
 */
export function subscribeAllLabels(fn: () => void): () => void {
  globalSubscribers.add(fn);
  return () => {
    globalSubscribers.delete(fn);
  };
}

export function listLabelsForProject(projectId: string): Label[] {
  return byProject.get(projectId) ?? [];
}

/**
 * Synchronous lookup by id. Returns `undefined` when the label
 * hasn't been loaded yet OR has been deleted server-side. Renderers
 * should fall back gracefully (e.g. skip the chip) rather than
 * surfacing the missing id to the user.
 */
export function getLabel(labelId: string): Label | undefined {
  return byId.get(labelId);
}

export async function loadLabels(
  projectId: string,
): Promise<Label[] | null> {
  const r = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/labels`),
  );
  if (r.status === 503) return null;
  if (!r.ok) throw new Error(`labels list: ${r.status}`);
  const body = (await r.json()) as { items: Label[] };
  byProject.set(projectId, body.items ?? []);
  reindexById();
  notify(projectId);
  return body.items ?? [];
}

/** Convenience: ensure cache is hydrated, no-op if already loaded. */
export async function ensureLabelsLoaded(
  projectId: string,
): Promise<void> {
  if (byProject.has(projectId)) return;
  await loadLabels(projectId).catch(() => {
    // Soft-fail — kanban renders without chips rather than
    // breaking on a transient network blip.
  });
}

export interface CreateLabelInput {
  name: string;
  /** `#rrggbb` (case-insensitive). The server canonicalises. */
  colour: string;
  description?: string;
}

export async function createLabel(
  projectId: string,
  input: CreateLabelInput,
): Promise<Label> {
  const r = await fetch(
    apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/labels`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`create label ${r.status}: ${text}`);
  }
  const created = (await r.json()) as Label;
  const list = byProject.get(projectId) ?? [];
  const next = list.concat(created);
  next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  byProject.set(projectId, next);
  reindexById();
  notify(projectId);
  return created;
}

export interface UpdateLabelInput {
  name?: string;
  colour?: string;
  /** `""` clears the description; `undefined` leaves it as-is. */
  description?: string;
}

export async function updateLabel(
  labelId: string,
  patch: UpdateLabelInput,
): Promise<Label> {
  const r = await fetch(apiUrl(`/v1/labels/${encodeURIComponent(labelId)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`update label ${r.status}: ${text}`);
  }
  const updated = (await r.json()) as Label;
  const list = byProject.get(updated.project_id) ?? [];
  const idx = list.findIndex((l) => l.id === labelId);
  let next = list.slice();
  if (idx >= 0) next[idx] = updated;
  else next = next.concat(updated);
  next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  byProject.set(updated.project_id, next);
  reindexById();
  notify(updated.project_id);
  return updated;
}

// ---------- WS frame appliers --------------------------------------
//
// Wired up in `services/frames/domainFrames.ts`. Same idempotent
// merge pattern as `comments.applyComment*` — late-arriving frames
// reconcile after an optimistic mutation rather than double-insert.

export function applyLabelCreated(l: Label): void {
  const list = byProject.get(l.project_id) ?? [];
  if (list.some((existing) => existing.id === l.id)) {
    // Optimistic insert already landed; overwrite to pick up any
    // server-side normalisation (canonical lowercase colour, etc.).
    const next = list.map((existing) =>
      existing.id === l.id ? l : existing,
    );
    byProject.set(l.project_id, next);
  } else {
    const next = list.concat(l);
    next.sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    byProject.set(l.project_id, next);
  }
  reindexById();
  notify(l.project_id);
}

export function applyLabelUpdated(l: Label): void {
  const list = byProject.get(l.project_id) ?? [];
  const idx = list.findIndex((existing) => existing.id === l.id);
  let next: Label[];
  if (idx >= 0) {
    next = list.slice();
    next[idx] = l;
  } else {
    // Cross-project move would land here too, but the trait pins
    // `project_id` as immutable, so we'd only see this for a label
    // that wasn't loaded yet. Append + sort.
    next = list.concat(l);
  }
  next.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  byProject.set(l.project_id, next);
  reindexById();
  notify(l.project_id);
}

export function applyLabelDeleted(
  projectId: string,
  labelId: string,
): void {
  const list = byProject.get(projectId);
  if (!list) return;
  const next = list.filter((l) => l.id !== labelId);
  if (next.length !== list.length) {
    byProject.set(projectId, next);
    reindexById();
    notify(projectId);
  }
}

export async function deleteLabel(labelId: string): Promise<void> {
  // We need the project id to update the right bucket after the
  // server-side delete succeeds. Pull from the by-id cache; if it's
  // not loaded, fall back to walking every bucket.
  const cached = byId.get(labelId);
  const r = await fetch(apiUrl(`/v1/labels/${encodeURIComponent(labelId)}`), {
    method: "DELETE",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`delete label ${r.status}: ${text}`);
  }
  const projectId = cached?.project_id;
  if (projectId) {
    const list = byProject.get(projectId) ?? [];
    byProject.set(
      projectId,
      list.filter((l) => l.id !== labelId),
    );
  } else {
    // Walk every bucket — covers the rare path where the chip was
    // rendered without a hydrated cache.
    for (const [pid, list] of byProject.entries()) {
      const filtered = list.filter((l) => l.id !== labelId);
      if (filtered.length !== list.length) byProject.set(pid, filtered);
    }
  }
  reindexById();
  notify(projectId ?? "");
}
