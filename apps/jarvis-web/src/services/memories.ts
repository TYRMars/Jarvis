// Service layer for the self-improving-agent long-term Memory surface
// (Phase 1 of docs/proposals/self-improving-agent.zh-CN.md).
//
// REST endpoints (crates/harness-server/src/memory_routes.rs):
//   GET    /v1/memories?scope=user           -> { items: MemoryItem[] }
//   POST   /v1/memories                       -> { item } (201; user scope only)
//   PATCH  /v1/memories/:id                    -> { item }
//   DELETE /v1/memories/:id                    -> { deleted: bool }
//
// Live updates arrive over the WS as `memory_upserted` / `memory_deleted`
// frames (see services/frames/domainFrames.ts), routed into the cache via
// applyMemoryUpserted / applyMemoryDeleted so every open tab stays synced
// without polling.

import { apiUrl } from "./api";

export type MemoryKind =
  | "preference"
  | "fact"
  | "lesson"
  | "gotcha"
  | "convention";

export type MemoryScope =
  | { kind: "user" }
  | { kind: "project"; project_id: string }
  | { kind: "workspace"; workspace: string };

export type MemorySource =
  | { kind: "user" }
  | { kind: "agent" }
  | { kind: "run"; run_id: string }
  | { kind: "import"; from: string }
  | { kind: "other" };

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  source: MemorySource;
  confidence: number;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
  attributes?: unknown;
}

export interface MemoryPatch {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  tags?: string[];
  pinned?: boolean;
  confidence?: number;
}

// ---------- cache + subscribers ------------------------------------

const byId: Map<string, MemoryItem> = new Map();
const subscribers = new Set<() => void>();
let loadedOnce = false;

function notify(): void {
  for (const s of subscribers) {
    try {
      s();
    } catch (e) {
      console.warn("memories subscriber threw", e);
    }
  }
}

/** Subscribe to any memory-cache change. Returns an unsubscribe fn. */
export function subscribeMemories(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Snapshot of the cache, sorted pinned-first then newest-updated. */
export function memoriesSnapshot(): MemoryItem[] {
  const list = Array.from(byId.values());
  list.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
  return list;
}

export function memoriesLoaded(): boolean {
  return loadedOnce;
}

// ---------- frame appliers (called from domainFrames.ts) -----------

export function applyMemoryUpserted(item: MemoryItem): void {
  if (!item || typeof item.id !== "string") return;
  byId.set(item.id, item);
  notify();
}

export function applyMemoryDeleted(id: string): void {
  if (byId.delete(id)) notify();
}

// ---------- REST ---------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

/** Fetch all user-scope memories and populate the cache. */
export async function loadUserMemories(): Promise<MemoryItem[]> {
  const data = await request<{ items: MemoryItem[] }>(
    "GET",
    "/v1/memories?scope=user",
  );
  byId.clear();
  for (const item of data.items ?? []) byId.set(item.id, item);
  loadedOnce = true;
  notify();
  return memoriesSnapshot();
}

/** Create a new user-scope memory. Server fills id + timestamps. */
export async function createUserMemory(input: {
  title: string;
  body: string;
  kind: MemoryKind;
  tags?: string[];
  pinned?: boolean;
}): Promise<MemoryItem> {
  const payload: MemoryItem = {
    id: "",
    scope: { kind: "user" },
    kind: input.kind,
    title: input.title,
    body: input.body,
    tags: input.tags ?? [],
    source: { kind: "user" },
    confidence: 1.0,
    pinned: input.pinned ?? false,
    created_at: "",
    updated_at: "",
  };
  const { item } = await request<{ item: MemoryItem }>(
    "POST",
    "/v1/memories",
    payload,
  );
  applyMemoryUpserted(item);
  return item;
}

export async function patchMemory(
  id: string,
  patch: MemoryPatch,
): Promise<MemoryItem> {
  const { item } = await request<{ item: MemoryItem }>(
    "PATCH",
    `/v1/memories/${encodeURIComponent(id)}`,
    patch,
  );
  applyMemoryUpserted(item);
  return item;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const { deleted } = await request<{ deleted: boolean }>(
    "DELETE",
    `/v1/memories/${encodeURIComponent(id)}`,
  );
  if (deleted) applyMemoryDeleted(id);
  return deleted;
}
