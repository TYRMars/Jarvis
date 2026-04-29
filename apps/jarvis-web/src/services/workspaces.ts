// Persisted workspaces registry — recent paths + per-conversation
// bindings. The list shown in the chat-header dropdown comes from
// here; the actual workspace pin still flows through the WS frame
// (`set_workspace`) so the change takes effect immediately rather
// than waiting on a round-trip to the REST surface.

import { apiUrl } from "./api";

export interface RecentWorkspace {
  path: string;
  name: string;
  last_used_at: string;
}

interface RecentResponse {
  workspaces?: RecentWorkspace[];
  recent?: RecentWorkspace[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(apiUrl(path), init);
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed && typeof parsed.error === "string") msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(`workspaces ${method} ${path}: ${msg}`);
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const data = await request<RecentResponse>("GET", "/v1/workspaces");
  return data.workspaces ?? data.recent ?? [];
}

/** Touch a path: insert it (or move to front) in the recent list.
 *  Returns the canonicalised path string (the server resolves
 *  relative paths, symlinks, and trailing slashes). The chat
 *  header should treat this as the source of truth — display the
 *  returned `path` rather than what the user typed. */
export async function touchWorkspace(path: string): Promise<string> {
  const data = await request<{ path: string }>("POST", "/v1/workspaces", { path });
  return data.path;
}

/** Drop a path from the recent list. Idempotent. */
export async function forgetWorkspace(path: string): Promise<void> {
  const url = `/v1/workspaces?path=${encodeURIComponent(path)}`;
  await request<{ deleted: boolean }>("DELETE", url);
}
