// Service layer for server-global Agent profiles.
//
// REST + WS-driven; no localStorage fallback (these are admin-y
// settings that don't make sense to "remember offline" the way the
// kanban does).
//
// - `loadAgentProfiles()` populates the cache from
//   `GET /v1/agent-profiles`. Returns the rows for callers that
//   want them inline; subscribers also see the cache update.
// - `listAgentProfiles()` reads synchronously from the cache.
// - `subscribeAgentProfiles(cb)` returns an unsubscribe.
// - WS frames `agent_profile_upserted` / `agent_profile_deleted`
//   reconcile via `applyAgentProfileUpserted` / `_Deleted`.

import type { AgentProfile } from "../types/frames";
import { apiUrl } from "./api";

const cache: Map<string, AgentProfile> = new Map();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("agent-profiles subscriber threw", e);
    }
  }
}

function sortedRows(): AgentProfile[] {
  return [...cache.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/// Synchronous cache read, newest-updated first.
export function listAgentProfiles(): AgentProfile[] {
  return sortedRows();
}

/// Subscribe to cache changes. Returns an unsubscribe.
export function subscribeAgentProfiles(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

interface ListResponse {
  items: AgentProfile[];
}

/// Refresh the cache from the server. Returns the rows for inline
/// use. On 503 / network error the cache is cleared (these are
/// never meaningfully stale-readable like recent workspaces).
export async function loadAgentProfiles(): Promise<AgentProfile[]> {
  try {
    const r = await fetch(apiUrl("/v1/agent-profiles"));
    if (r.status === 503) {
      cache.clear();
      notify();
      return [];
    }
    if (!r.ok) throw new Error(`agent-profiles list: ${r.status}`);
    const body = (await r.json()) as ListResponse;
    cache.clear();
    for (const p of body.items) cache.set(p.id, p);
    notify();
    return sortedRows();
  } catch (e) {
    console.warn("agent-profiles fetch failed", e);
    return sortedRows();
  }
}

export interface CreateProfileInput {
  name: string;
  provider: string;
  model: string;
  avatar?: string | null;
  system_prompt?: string | null;
  default_workspace?: string | null;
  allowed_tools?: string[];
}

interface ItemResponse {
  profile: AgentProfile;
}

/// Create a profile via `POST /v1/agent-profiles`. The WS broadcast
/// reconciles the cache, but we also upsert locally on success so
/// callers awaiting the returned promise see the new row.
export async function createAgentProfile(
  input: CreateProfileInput,
): Promise<AgentProfile> {
  const r = await fetch(apiUrl("/v1/agent-profiles"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`create agent profile: ${r.status} ${body}`);
  }
  const { profile } = (await r.json()) as ItemResponse;
  applyAgentProfileUpserted(profile);
  return profile;
}

export interface UpdateProfileInput {
  name?: string;
  provider?: string;
  model?: string;
  avatar?: string | null;
  system_prompt?: string | null;
  default_workspace?: string | null;
  allowed_tools?: string[];
}

/// Patch a profile. `null` on optional string fields clears them.
export async function updateAgentProfile(
  id: string,
  patch: UpdateProfileInput,
): Promise<AgentProfile> {
  const r = await fetch(apiUrl(`/v1/agent-profiles/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`update agent profile: ${r.status} ${body}`);
  }
  const { profile } = (await r.json()) as ItemResponse;
  applyAgentProfileUpserted(profile);
  return profile;
}

/// Delete a profile.
export async function deleteAgentProfile(id: string): Promise<boolean> {
  const r = await fetch(apiUrl(`/v1/agent-profiles/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`delete agent profile: ${r.status} ${body}`);
  }
  const { deleted } = (await r.json()) as { deleted: boolean };
  if (deleted) applyAgentProfileDeleted(id);
  return deleted;
}

// ---------- WS frame appliers (called from frames dispatcher) -------

export function applyAgentProfileUpserted(profile: AgentProfile): void {
  cache.set(profile.id, profile);
  notify();
}

export function applyAgentProfileDeleted(id: string): void {
  if (cache.delete(id)) notify();
}
