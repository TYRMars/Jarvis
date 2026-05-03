// Service layer for named agent profiles (Phase 3.6).
//
// Process-wide CRUD over `/v1/agent-profiles*`. Same in-memory cache
// + subscriber + WS-frame-applier shape as `services/requirements.ts`,
// scoped down to a single flat list (no per-project partitioning —
// profiles are global).

import type { AgentProfile } from "../types/frames";
import { apiUrl } from "./api";

const cache: Map<string, AgentProfile> = new Map();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("agent profile subscriber threw", e);
    }
  }
}

/// Synchronous read against the in-memory cache, sorted by name asc
/// (matches the server's sort order).
export function listAgentProfiles(): AgentProfile[] {
  return Array.from(cache.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/// Convenience lookup by id. Returns `null` when the cache hasn't
/// seen that id (caller can fall back to "use server default").
export function getAgentProfileFromCache(id: string | null | undefined): AgentProfile | null {
  if (!id) return null;
  return cache.get(id) ?? null;
}

/// Subscribe to cache change notifications.
export function subscribeAgentProfiles(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

interface ListResponse {
  items: AgentProfile[];
}

/// Refresh the cache from the server. Idempotent. 503 = no
/// agent-profile store wired up; in that case we leave the cache
/// empty and the UI renders the "no agents configured" state.
export async function loadAgentProfiles(): Promise<void> {
  try {
    const r = await fetch(apiUrl("/v1/agent-profiles"));
    if (r.status === 503) {
      cache.clear();
      notify();
      return;
    }
    if (!r.ok) throw new Error(`agent profiles list: ${r.status}`);
    const body = (await r.json()) as ListResponse;
    cache.clear();
    for (const p of body.items) cache.set(p.id, p);
    notify();
  } catch (e) {
    console.warn("agent profiles fetch failed", e);
  }
}

export interface CreateAgentProfileInput {
  name: string;
  provider: string;
  model: string;
  avatar?: string;
  system_prompt?: string;
  default_workspace?: string;
  allowed_tools?: string[];
}

/// Create a new profile. Returns the created row (with the
/// server-allocated id) or throws on failure.
export async function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfile> {
  const r = await fetch(apiUrl("/v1/agent-profiles"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`agent profile create: ${r.status}`);
  const saved = (await r.json()) as AgentProfile;
  cache.set(saved.id, saved);
  notify();
  return saved;
}

export interface UpdateAgentProfileInput {
  name?: string;
  provider?: string;
  model?: string;
  /// Pass empty string to clear; pass undefined to leave unchanged.
  avatar?: string;
  system_prompt?: string;
  default_workspace?: string;
  allowed_tools?: string[];
}

/// Patch a profile. Server is source-of-truth; the WS frame
/// reconciles. Returns the updated row, or null on 404.
export async function updateAgentProfile(
  id: string,
  patch: UpdateAgentProfileInput,
): Promise<AgentProfile | null> {
  const r = await fetch(apiUrl(`/v1/agent-profiles/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`agent profile patch: ${r.status}`);
  const updated = (await r.json()) as AgentProfile;
  cache.set(updated.id, updated);
  notify();
  return updated;
}

/// Delete a profile. Returns true if a row was removed; false on
/// idempotent "already gone".
export async function deleteAgentProfile(id: string): Promise<boolean> {
  const r = await fetch(apiUrl(`/v1/agent-profiles/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (r.status === 404) {
    cache.delete(id);
    notify();
    return false;
  }
  if (!r.ok) throw new Error(`agent profile delete: ${r.status}`);
  cache.delete(id);
  notify();
  return true;
}

// ---- WS frame appliers (called from frames.ts) ------------------

export function applyAgentProfileUpserted(p: AgentProfile): void {
  cache.set(p.id, p);
  notify();
}

export function applyAgentProfileDeleted(id: string): void {
  cache.delete(id);
  notify();
}
