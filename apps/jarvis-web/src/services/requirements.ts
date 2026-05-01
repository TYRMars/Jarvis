// Service layer for the per-project Requirement kanban.
//
// History: this used to be a pure-localStorage module — every read
// hit `localStorage["jarvis.productRequirements.v1"]`, every write
// stuffed back. That worked for a single browser but didn't survive
// across devices or even across browser profiles.
//
// New shape (server-backed, localStorage as offline fallback):
//
// - Reads (`listRequirements`) return synchronously from a per-project
//   in-memory cache. Components don't have to switch to async.
// - `loadRequirements(projectId)` populates / refreshes the cache from
//   `GET /v1/projects/:id/requirements`. Falls back to localStorage on
//   network error or when the server returns 503.
// - Mutations (`createRequirement` / `updateRequirement` /
//   `linkRequirementConversation`) **optimistically** update the cache
//   so the kanban moves immediately, then fire-and-forget the matching
//   REST call. The server's authoritative response arrives via the
//   `requirement_upserted` / `requirement_deleted` WS frames (handled
//   in `frames.ts` → `applyRequirementUpserted` / `_Deleted` below) and
//   reconciles the cache.
// - Subscribers (`subscribeRequirements`) get called whenever the
//   cache changes; React components bump a version counter to
//   re-render.
// - localStorage stays in sync as a write-through cache. When the
//   server is unreachable (e.g. air-gapped demo), reads degrade to
//   "last seen" data instead of going blank.
//
// Wire types mirror `crates/harness-core/src/requirement.rs` and
// `apps/jarvis-web/src/types/frames.ts`.

import type { Requirement, RequirementStatus } from "../types/frames";
import { apiUrl } from "./api";

const REQUIREMENTS_KEY = "jarvis.productRequirements.v1";

// ---------- in-memory cache + subscribers --------------------------

const cache: Map<string, Requirement[]> = new Map();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      // Subscriber errors must not break siblings.
      console.warn("requirements subscriber threw", e);
    }
  }
}

function rowsByProjectFromCache(): Requirement[] {
  const all: Requirement[] = [];
  for (const list of cache.values()) all.push(...list);
  return all;
}

function persist(): void {
  try {
    localStorage.setItem(REQUIREMENTS_KEY, JSON.stringify(rowsByProjectFromCache()));
  } catch {
    // Ignore quota / private-mode failures — the cache is
    // authoritative for this session anyway.
  }
}

function hydrateFromLocalStorage(): void {
  if (cache.size > 0) return;
  try {
    const raw = localStorage.getItem(REQUIREMENTS_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r.project_id !== "string") continue;
      const list = cache.get(r.project_id) ?? [];
      list.push(r as Requirement);
      cache.set(r.project_id, list);
    }
    sortAllProjects();
  } catch {
    // Corrupt localStorage — just start empty.
  }
}

function sortProject(projectId: string): void {
  const list = cache.get(projectId);
  if (!list) return;
  list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function sortAllProjects(): void {
  for (const projectId of cache.keys()) sortProject(projectId);
}

// ---------- public synchronous API (back-compat) -------------------

/// Synchronous read against the in-memory cache. Pair with
/// [`loadRequirements`] (idempotent) to populate from the server, and
/// [`subscribeRequirements`] to re-render on cache changes.
export function listRequirements(projectId: string): Requirement[] {
  hydrateFromLocalStorage();
  return cache.get(projectId)?.slice() ?? [];
}

/// Subscribe to cache change notifications. Returns an unsubscribe
/// function. The callback fires after each REST load, optimistic
/// mutation, or WS-driven reconciliation.
export function subscribeRequirements(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// ---------- async loaders ------------------------------------------

interface ListRequirementsResponse {
  project_id: string;
  items: Requirement[];
}

/// Refresh the cache for `projectId` from the server. Falls back to
/// localStorage on network error or when the server returns 503; in
/// that case the cache contents (if any) stay as the last-seen view.
/// Idempotent — safe to call on every project switch / window focus.
export async function loadRequirements(projectId: string): Promise<void> {
  try {
    const r = await fetch(
      apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/requirements`),
    );
    if (r.status === 503) {
      // Server has no requirement store wired up — leave the cache
      // alone (localStorage still drives reads).
      hydrateFromLocalStorage();
      notify();
      return;
    }
    if (!r.ok) throw new Error(`requirements list: ${r.status}`);
    const body = (await r.json()) as ListRequirementsResponse;
    cache.set(projectId, body.items.slice());
    sortProject(projectId);
    persist();
    notify();
  } catch (e) {
    console.warn("requirements fetch failed; falling back to localStorage", e);
    hydrateFromLocalStorage();
    notify();
  }
}

// ---------- optimistic mutations -----------------------------------

export interface CreateRequirementInput {
  projectId: string;
  title: string;
  description?: string;
  /// Optional initial column. Server's `CreateRequirementBody` already
  /// accepts `status` (see `requirements_routes.rs`); we surface it
  /// here so the per-column "+" buttons on the board can drop a card
  /// straight into the right lane (e.g., a triage flow that creates
  /// review-bound items without a manual drag afterwards).
  status?: RequirementStatus;
}

/// Create a new Requirement. Returns the optimistic local row
/// immediately; the authoritative server-allocated id arrives via
/// the `requirement_upserted` WS frame and reconciles. When the
/// server is unreachable, the local row stays in cache + localStorage
/// (the operation degrades to a localStorage-only write).
export function createRequirement(input: CreateRequirementInput): Requirement {
  const now = new Date().toISOString();
  const initialStatus: RequirementStatus = input.status ?? "backlog";
  const optimistic: Requirement = {
    id: `req-local-${randomId()}`,
    project_id: input.projectId,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    status: initialStatus,
    conversation_ids: [],
    created_at: now,
    updated_at: now,
  };
  upsertLocal(optimistic);

  // Fire-and-forget POST. On success the WS broadcast will reconcile
  // (replacing the `req-local-*` row with the server-allocated id).
  void (async () => {
    try {
      const r = await fetch(
        apiUrl(
          `/v1/projects/${encodeURIComponent(input.projectId)}/requirements`,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: input.title,
            description: input.description ?? undefined,
            status: input.status ?? undefined,
          }),
        },
      );
      if (!r.ok) {
        if (r.status !== 503) {
          console.warn("requirement create failed", r.status);
        }
        return;
      }
      const saved = (await r.json()) as Requirement;
      // Drop the optimistic placeholder; insert the server row.
      removeLocal(optimistic.id);
      upsertLocal(saved);
    } catch (e) {
      console.warn("requirement create fetch error", e);
    }
  })();

  return optimistic;
}

export interface UpdateRequirementInput {
  title?: string;
  description?: string | null;
  status?: RequirementStatus;
  conversation_ids?: string[];
}

/// Patch a Requirement. Optimistic — applies immediately to cache,
/// then fires PATCH. WS broadcast reconciles `updated_at`. Returns
/// the optimistically-mutated row, or `null` if `id` isn't in cache.
export function updateRequirement(
  id: string,
  patch: UpdateRequirementInput,
): Requirement | null {
  const existing = findById(id);
  if (!existing) return null;
  const next: Requirement = {
    ...existing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.conversation_ids !== undefined
      ? { conversation_ids: patch.conversation_ids }
      : {}),
    updated_at: new Date().toISOString(),
  };
  upsertLocal(next);

  // Skip the network round-trip for purely-local optimistic rows
  // (the create-side fire-and-forget hasn't reconciled yet).
  if (id.startsWith("req-local-")) return next;

  void (async () => {
    try {
      const r = await fetch(apiUrl(`/v1/requirements/${encodeURIComponent(id)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok && r.status !== 503 && r.status !== 404) {
        console.warn("requirement patch failed", r.status);
      }
    } catch (e) {
      console.warn("requirement patch fetch error", e);
    }
  })();

  return next;
}

/// Append a conversation id to the Requirement's `conversation_ids`.
/// Idempotent: if the id is already linked, returns the existing row
/// untouched. Otherwise applies optimistically and fires the link
/// POST.
export function linkRequirementConversation(
  id: string,
  conversationId: string,
): Requirement | null {
  const existing = findById(id);
  if (!existing) return null;
  if (existing.conversation_ids.includes(conversationId)) return existing;
  const next: Requirement = {
    ...existing,
    conversation_ids: [conversationId, ...existing.conversation_ids],
    updated_at: new Date().toISOString(),
  };
  upsertLocal(next);

  if (id.startsWith("req-local-")) return next;

  void (async () => {
    try {
      const r = await fetch(
        apiUrl(`/v1/requirements/${encodeURIComponent(id)}/conversations`),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId }),
        },
      );
      if (!r.ok && r.status !== 503 && r.status !== 404) {
        console.warn("requirement link failed", r.status);
      }
    } catch (e) {
      console.warn("requirement link fetch error", e);
    }
  })();

  return next;
}

// ---------- WS frame appliers (called from frames.ts) -------------

/// Apply a server-side `requirement_upserted` frame to the cache.
/// Replaces any existing row with the same id (in any project) so
/// project_id changes are handled cleanly.
export function applyRequirementUpserted(req: Requirement): void {
  // Drop the row from any project that currently holds it (covers
  // the rare case of a project_id change).
  for (const [pid, list] of cache.entries()) {
    const i = list.findIndex((r) => r.id === req.id);
    if (i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) cache.delete(pid);
      else cache.set(pid, list);
    }
  }
  upsertLocal(req);
}

/// Apply a server-side `requirement_deleted` frame to the cache.
export function applyRequirementDeleted(id: string, _projectId: string): void {
  removeLocal(id);
}

// ---------- internal cache helpers --------------------------------

function findById(id: string): Requirement | null {
  for (const list of cache.values()) {
    const found = list.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
}

function upsertLocal(req: Requirement): void {
  const list = cache.get(req.project_id) ?? [];
  const i = list.findIndex((r) => r.id === req.id);
  if (i >= 0) list[i] = req;
  else list.unshift(req);
  cache.set(req.project_id, list);
  sortProject(req.project_id);
  persist();
  notify();
}

function removeLocal(id: string): void {
  for (const [pid, list] of cache.entries()) {
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) cache.delete(pid);
      else cache.set(pid, list);
      persist();
      notify();
      return;
    }
  }
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
