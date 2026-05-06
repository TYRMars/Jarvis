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

import type {
  Activity,
  Requirement,
  RequirementRun,
  RequirementStatus,
  RequirementTodo,
  RequirementTodoKind,
  RequirementTodoStatus,
  VerificationResult,
} from "../types/frames";
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
  /// Phase 3.6: pass `null` to clear, a string id to assign, or
  /// omit the key to leave unchanged. The wire shape mirrors —
  /// `JSON.stringify` on `{assignee_id: null}` correctly emits
  /// the `null` literal so the server's three-state deserializer
  /// (Missing / Clear / Set) sees "Clear".
  assignee_id?: string | null;
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
    ...("assignee_id" in patch ? { assignee_id: patch.assignee_id ?? null } : {}),
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

/// Mint a fresh-session run on the server. POST /v1/requirements/:id/runs
/// creates a new Conversation, links it back to the Requirement, flips
/// the Requirement to `in_progress`, persists the row in the run store
/// (when configured), and emits the `requirement_run_started` /
/// `requirement_upserted` / `activity_appended` WS frames the cache
/// reconciliation already handles.
///
/// Returns the freshly-allocated `RequirementRun`. Throws (with the
/// server's status text) on non-2xx so the caller can surface a toast
/// rather than swallowing the failure silently. Skipped for purely-
/// local optimistic Requirement rows (`req-local-*`) because there's
/// no server-side row to mint a run against yet.
export async function startRequirementRun(
  id: string,
): Promise<{ run: RequirementRun; conversation_id: string }> {
  if (id.startsWith("req-local-")) {
    throw new Error("requirement is still optimistic; wait for server reconcile");
  }
  const r = await fetch(apiUrl(`/v1/requirements/${encodeURIComponent(id)}/runs`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`start run ${r.status}: ${text || r.statusText}`);
  }
  const body = (await r.json()) as {
    run: RequirementRun;
    conversation_id: string;
  };
  // Optimistically push the new run into the cache so the
  // RunsSection updates immediately, before the WS frame arrives.
  upsertRunLocal(body.run);
  return body;
}

/// v1.0 — approve a triage candidate. Flips `triage_state` to
/// `approved` server-side and writes an Activity row. Optimistically
/// updates the local cache so the Triage drawer empties immediately;
/// the WS broadcast reconciles. Returns true iff the server accepted
/// (200/2xx); 404 / 503 / network error → false (caller may want to
/// retry or surface a toast).
export async function approveRequirement(id: string): Promise<boolean> {
  const existing = findById(id);
  if (existing) {
    upsertLocal({ ...existing, triage_state: "approved", updated_at: new Date().toISOString() });
  }
  if (id.startsWith("req-local-")) return true;
  try {
    const r = await fetch(apiUrl(`/v1/requirements/${encodeURIComponent(id)}/approve`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return r.ok;
  } catch (e) {
    console.warn("requirement approve fetch error", e);
    return false;
  }
}

/// v1.0 — reject a triage candidate. The server soft-deletes the row
/// after recording the rejection reason on the activity timeline.
/// Optimistically removes from the local cache.
/// Throws if the reason is blank — that mirrors the server's 400.
export async function rejectRequirement(
  id: string,
  reason: string,
): Promise<boolean> {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error("reject requires a non-blank reason");
  }
  removeLocal(id);
  if (id.startsWith("req-local-")) return true;
  try {
    const r = await fetch(apiUrl(`/v1/requirements/${encodeURIComponent(id)}/reject`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: trimmed }),
    });
    return r.ok;
  } catch (e) {
    console.warn("requirement reject fetch error", e);
    return false;
  }
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

// ---------- structured Requirement TODOs --------------------------

export interface CreateRequirementTodoInput {
  title: string;
  kind?: RequirementTodoKind;
  status?: RequirementTodoStatus;
  command?: string | null;
  created_by?: "human" | "agent" | "workflow";
}

export interface UpdateRequirementTodoInput {
  title?: string;
  kind?: RequirementTodoKind;
  status?: RequirementTodoStatus;
  command?: string | null;
}

interface RequirementTodoMutationResponse {
  todo?: RequirementTodo;
  requirement: Requirement;
  deleted?: boolean;
}

export async function createRequirementTodo(
  requirementId: string,
  input: CreateRequirementTodoInput,
): Promise<RequirementTodoMutationResponse> {
  const r = await fetch(
    apiUrl(`/v1/requirements/${encodeURIComponent(requirementId)}/todos`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        kind: input.kind ?? "work",
        status: input.status ?? "pending",
        command: input.command ?? undefined,
        created_by: input.created_by ?? "human",
      }),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`create TODO ${r.status}: ${text || r.statusText}`);
  }
  const body = (await r.json()) as RequirementTodoMutationResponse;
  upsertLocal(body.requirement);
  return body;
}

export async function updateRequirementTodo(
  requirementId: string,
  todoId: string,
  patch: UpdateRequirementTodoInput,
): Promise<RequirementTodoMutationResponse> {
  const r = await fetch(
    apiUrl(
      `/v1/requirements/${encodeURIComponent(requirementId)}/todos/${encodeURIComponent(todoId)}`,
    ),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`update TODO ${r.status}: ${text || r.statusText}`);
  }
  const body = (await r.json()) as RequirementTodoMutationResponse;
  upsertLocal(body.requirement);
  return body;
}

export async function deleteRequirementTodo(
  requirementId: string,
  todoId: string,
): Promise<RequirementTodoMutationResponse> {
  const r = await fetch(
    apiUrl(
      `/v1/requirements/${encodeURIComponent(requirementId)}/todos/${encodeURIComponent(todoId)}`,
    ),
    { method: "DELETE" },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`delete TODO ${r.status}: ${text || r.statusText}`);
  }
  const body = (await r.json()) as RequirementTodoMutationResponse;
  upsertLocal(body.requirement);
  return body;
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

// =============================================================
// RequirementRun history (Phase 3.5)
// =============================================================
//
// Companion cache for the per-requirement run history surfaced in
// the kanban card detail's "Runs" drawer. Same shape as the
// requirement cache above (in-memory map + subscriber set + REST
// loader + WS frame appliers) but keyed by `requirement_id` rather
// than `project_id`.
//
// localStorage is intentionally NOT used here — runs are
// server-of-record telemetry; no point persisting "last seen" rows
// when the next page load will refetch from the source. If the
// server's run store is missing, we just show an empty drawer.

const runsByRequirement: Map<string, RequirementRun[]> = new Map();
const runsSubscribers = new Set<() => void>();

function notifyRuns(): void {
  for (const s of runsSubscribers) {
    try {
      s();
    } catch (e) {
      console.warn("requirement-runs subscriber threw", e);
    }
  }
}

function sortRunsForRequirement(requirementId: string): void {
  const list = runsByRequirement.get(requirementId);
  if (!list) return;
  list.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

function upsertRunLocal(run: RequirementRun): void {
  const list = runsByRequirement.get(run.requirement_id) ?? [];
  const i = list.findIndex((r) => r.id === run.id);
  if (i >= 0) list[i] = run;
  else list.unshift(run);
  runsByRequirement.set(run.requirement_id, list);
  sortRunsForRequirement(run.requirement_id);
  notifyRuns();
}

/// Synchronous read against the in-memory run cache. Pair with
/// [`loadRunsForRequirement`] to populate from the server, and
/// [`subscribeRequirementRuns`] to re-render on cache changes.
export function listRunsForRequirement(requirementId: string): RequirementRun[] {
  return runsByRequirement.get(requirementId)?.slice() ?? [];
}

/// Subscribe to run-cache change notifications. Returns an
/// unsubscribe function. The callback fires after each REST load,
/// or WS frame (Started / Finished / Verified).
export function subscribeRequirementRuns(cb: () => void): () => void {
  runsSubscribers.add(cb);
  return () => {
    runsSubscribers.delete(cb);
  };
}

interface ListRunsResponse {
  requirement_id: string;
  items: RequirementRun[];
}

/// Refresh the run cache for `requirementId` from the server.
/// Idempotent. Silently no-ops on 503 (no run store wired up); other
/// failures degrade to "stay with whatever's cached" with a warn.
export async function loadRunsForRequirement(
  requirementId: string,
): Promise<void> {
  try {
    const r = await fetch(
      apiUrl(`/v1/requirements/${encodeURIComponent(requirementId)}/runs`),
    );
    if (r.status === 503) {
      // Run store absent — leave the cache alone (it'll just be
      // empty). The detail drawer renders accordingly.
      runsByRequirement.set(requirementId, []);
      notifyRuns();
      return;
    }
    if (!r.ok) throw new Error(`runs list: ${r.status}`);
    const body = (await r.json()) as ListRunsResponse;
    runsByRequirement.set(requirementId, body.items.slice());
    sortRunsForRequirement(requirementId);
    notifyRuns();
  } catch (e) {
    console.warn("requirement-runs fetch failed", e);
  }
}

// ---- WS frame appliers (called from frames.ts) -------------------

/// Apply a server-side `requirement_run_started` frame.
export function applyRequirementRunStarted(run: RequirementRun): void {
  upsertRunLocal(run);
}

/// Apply a server-side `requirement_run_finished` frame.
export function applyRequirementRunFinished(run: RequirementRun): void {
  upsertRunLocal(run);
}

/// Apply a server-side `requirement_run_verified` frame. Looks up the
/// run by id across all cached requirements, attaches the
/// verification result, and re-broadcasts. No-op when the run isn't
/// in cache (the next `loadRunsForRequirement` will pick it up).
export function applyRequirementRunVerified(
  runId: string,
  result: VerificationResult,
): void {
  for (const list of runsByRequirement.values()) {
    const i = list.findIndex((r) => r.id === runId);
    if (i >= 0) {
      list[i] = { ...list[i], verification: result };
      notifyRuns();
      return;
    }
  }
}

/// Phase 4 — auto-execute a verification plan via
/// `POST /v1/runs/:id/verify`. The server runs the commands,
/// writes the result, broadcasts the `requirement_run_verified`
/// frame (which `applyRequirementRunVerified` picks up), and
/// returns the run with the freshly-attached `verification`.
///
/// Errors throw; the caller is expected to surface them via
/// component-local state.
export async function verifyRunByCommands(
  runId: string,
  commands: string[],
  opts?: { requireHumanReview?: boolean; timeoutMs?: number },
): Promise<RequirementRun> {
  const r = await fetch(apiUrl(`/v1/runs/${encodeURIComponent(runId)}/verify`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commands,
      require_human_review: opts?.requireHumanReview ?? false,
      timeout_ms: opts?.timeoutMs,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`verify ${r.status}: ${text}`);
  }
  const run = (await r.json()) as RequirementRun;
  upsertRunLocal(run);
  return run;
}

export async function updateRequirementRun(
  runId: string,
  patch: {
    status?: RequirementRun["status"];
    summary?: string | null;
    error?: string | null;
  },
): Promise<RequirementRun> {
  const r = await fetch(apiUrl(`/v1/runs/${encodeURIComponent(runId)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`update run ${r.status}: ${text || r.statusText}`);
  }
  const run = (await r.json()) as RequirementRun;
  upsertRunLocal(run);
  return run;
}

// =============================================================
// Activity timeline (Phase 3.7)
// =============================================================
//
// Append-only audit log surfaced under each kanban card. Same
// cache + subscribe + apply shape as the run cache above; the
// only mutating WS frame is `activity_appended` (matches the
// trait — no upsert, no delete).

const activitiesByRequirement: Map<string, Activity[]> = new Map();
const activitiesSubscribers = new Set<() => void>();

function notifyActivities(): void {
  for (const s of activitiesSubscribers) {
    try {
      s();
    } catch (e) {
      console.warn("activity subscriber threw", e);
    }
  }
}

function sortActivitiesForRequirement(requirementId: string): void {
  const list = activitiesByRequirement.get(requirementId);
  if (!list) return;
  list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/// Synchronous read against the in-memory activity cache. Pair with
/// [`loadActivitiesForRequirement`] to populate from the server,
/// and [`subscribeRequirementActivities`] to re-render on cache
/// changes.
export function listActivitiesForRequirement(requirementId: string): Activity[] {
  return activitiesByRequirement.get(requirementId)?.slice() ?? [];
}

/// Subscribe to activity-cache change notifications.
export function subscribeRequirementActivities(cb: () => void): () => void {
  activitiesSubscribers.add(cb);
  return () => {
    activitiesSubscribers.delete(cb);
  };
}

interface ListActivitiesResponse {
  requirement_id: string;
  items: Activity[];
}

/// Refresh the activity cache for `requirementId` from the server.
/// Idempotent. 503 means the server has no activity store wired up;
/// in that case we drop to an empty list and let the section render
/// the "no activity" empty state.
export async function loadActivitiesForRequirement(
  requirementId: string,
): Promise<void> {
  try {
    const r = await fetch(
      apiUrl(
        `/v1/requirements/${encodeURIComponent(requirementId)}/activities`,
      ),
    );
    if (r.status === 503) {
      activitiesByRequirement.set(requirementId, []);
      notifyActivities();
      return;
    }
    if (!r.ok) throw new Error(`activities list: ${r.status}`);
    const body = (await r.json()) as ListActivitiesResponse;
    activitiesByRequirement.set(requirementId, body.items.slice());
    sortActivitiesForRequirement(requirementId);
    notifyActivities();
  } catch (e) {
    console.warn("activities fetch failed", e);
  }
}

/// Apply a server-side `activity_appended` frame.
export function applyActivityAppended(activity: Activity): void {
  const list = activitiesByRequirement.get(activity.requirement_id) ?? [];
  // Server is source-of-truth on uniqueness (UUID), but a safety
  // dedupe against double-deliver.
  if (list.some((a) => a.id === activity.id)) return;
  list.unshift(activity);
  activitiesByRequirement.set(activity.requirement_id, list);
  notifyActivities();
}
