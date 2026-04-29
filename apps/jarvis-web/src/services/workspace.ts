// Workspace info — what root + git state is the server pinned to?
//
// Fetched lazily by the WorkspaceBadge on mount and on demand
// (clicking the badge re-fetches). 503 means the server didn't pin
// a workspace root (rare — only test harnesses); we surface the
// `unconfigured` state explicitly so the badge can render a hint.

import { apiUrl } from "./api";

export interface WorkspaceInfo {
  root: string;
  vcs: "git" | "none";
  branch?: string | null;
  head?: string | null;
  dirty?: boolean;
}

export type WorkspaceState =
  | { kind: "loading" }
  | { kind: "ready"; info: WorkspaceInfo }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

export async function fetchWorkspace(): Promise<WorkspaceState> {
  try {
    const res = await fetch(apiUrl("/v1/workspace"));
    if (res.status === 503) return { kind: "unconfigured" };
    if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };
    const info = (await res.json()) as WorkspaceInfo;
    return { kind: "ready", info };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/// Probe an arbitrary folder and return the same `{root, vcs, branch}`
/// shape as `/v1/workspace`. Used by the composer workspace picker
/// before that folder becomes the active session root.
export async function probeWorkspace(path: string): Promise<WorkspaceInfo> {
  const res = await fetch(apiUrl(`/v1/workspace/probe?path=${encodeURIComponent(path)}`));
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as WorkspaceInfo;
}

/// Squash an absolute path to something readable in a small badge:
///   /Users/x/code/myrepo  →  ~/code/myrepo
///   /home/y/projects/foo   →  ~/projects/foo
///   anything else           →  last 2 path segments, with a leading …
export function shortenPath(p: string): string {
  if (!p) return p;
  // Try a few common HOME prefixes — we don't actually know which the
  // server runs as, so this is heuristic. The full path is in the
  // tooltip so users can always see it.
  const homeLike = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(\/.*)?$/;
  const m = p.match(homeLike);
  if (m) return "~" + (m[2] || "");
  const segs = p.split("/").filter(Boolean);
  if (segs.length <= 2) return p;
  return "…/" + segs.slice(-2).join("/");
}
