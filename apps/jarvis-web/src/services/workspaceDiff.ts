// Workspace diff data layer.
//
// Two-step fetch model — list endpoint is small (numstat + name-status
// per file, no hunks); per-file diff is fetched lazily when the user
// expands a row. This keeps the initial card render fast even on
// PRs the size of a Jarvis branch (10 KLOC+ deltas).
//
// Server contract: see `crates/harness-server/src/workspace_diff.rs`.
// Both endpoints return 503 when no workspace root is configured.

import { appStore } from "../store/appStore";
import { apiUrl } from "./api";
import { showError } from "./status";

export interface DiffStat {
  added: number;
  removed: number;
  files: number;
}

export interface DiffFileEntry {
  path: string;
  /// `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied,
  /// `T` type-changed, `?` untracked.
  status: string;
  added: number;
  removed: number;
  /// For renames only — the original path.
  old_path?: string;
}

export interface WorkspaceDiff {
  branch: string | null;
  base: string;
  base_exists: boolean;
  head: string | null;
  ahead: number;
  behind: number;
  stat: DiffStat;
  files: DiffFileEntry[];
  uncommitted: DiffStat;
}

/// Sentinel value the store uses to mean "feature unavailable on this
/// server" (503). Distinct from `null` (loading) and a real diff
/// payload — the rail card hides itself entirely in that case.
export type WorkspaceDiffState = WorkspaceDiff | "unavailable" | null;

let diffSeq = 0;

/// Pull the latest diff into the store. Idempotent against rapid
/// clicks via a sequence guard — a stale response from an in-flight
/// request can't overwrite a newer one. Returns the diff (or `null`
/// on failure) for callers that want to chain off it; the store is
/// the canonical sink.
export async function refreshWorkspaceDiff(base?: string): Promise<WorkspaceDiff | null> {
  const mySeq = ++diffSeq;
  appStore.getState().setWorkspaceDiffLoading(true);
  try {
    const params = base ? `?base=${encodeURIComponent(base)}` : "";
    const r = await fetch(apiUrl(`/v1/workspace/diff${params}`));
    if (mySeq !== diffSeq) return null;
    if (r.status === 503) {
      // Server has no workspace root pinned — hide the card.
      appStore.getState().setWorkspaceDiff("unavailable");
      return null;
    }
    if (!r.ok) {
      throw new Error(`workspace diff: ${r.status}`);
    }
    const body: WorkspaceDiff = await r.json();
    if (mySeq !== diffSeq) return null;
    appStore.getState().setWorkspaceDiff(body);
    return body;
  } catch (e: any) {
    if (mySeq !== diffSeq) return null;
    console.warn("workspace diff fetch failed", e);
    showError(`workspace diff: ${e?.message || e}`);
    return null;
  } finally {
    if (mySeq === diffSeq) {
      appStore.getState().setWorkspaceDiffLoading(false);
    }
  }
}

/// Fetch one file's unified diff. The card lazy-loads via this when
/// the user expands a row. Returns `null` on 503 / failure (caller
/// renders a placeholder).
export async function fetchFileDiff(base: string, path: string): Promise<string | null> {
  try {
    const params = `?base=${encodeURIComponent(base)}&path=${encodeURIComponent(path)}`;
    const r = await fetch(apiUrl(`/v1/workspace/diff/file${params}`));
    if (r.status === 503) return null;
    if (!r.ok) throw new Error(`file diff: ${r.status}`);
    const body = await r.json();
    return typeof body.diff === "string" ? body.diff : null;
  } catch (e: any) {
    console.warn("file diff fetch failed", e);
    return null;
  }
}

// ---------------------------------------------------------------- commit

export interface CommitResult {
  ok: true;
  head: string | null;
  pushed: boolean;
  push_error: string | null;
}

export interface CommitInput {
  message: string;
  push?: boolean;
}

/// Stage all working-tree changes and create a commit. Optionally
/// `git push -u origin <branch>` after. Throws on bad request /
/// server error so the caller can render the error inline in the
/// dialog instead of a generic banner.
export async function commitWorkspace(input: CommitInput): Promise<CommitResult> {
  const r = await fetch(apiUrl("/v1/workspace/commit"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      push: input.push ?? false,
    }),
  });
  const body = await r.json().catch(() => ({} as any));
  if (!r.ok) {
    throw new Error(body?.error || `commit failed: ${r.status}`);
  }
  return body as CommitResult;
}

// ---------------------------------------------------------------- PR

export interface PrPreview {
  branch: string | null;
  base: string;
  /// True when the `gh` CLI is on PATH and runs successfully on the
  /// server. False means the Create-PR action is unavailable; the
  /// dialog should render a "install gh" hint instead.
  gh_available: boolean;
  suggested_title: string;
  suggested_body: string;
}

export async function fetchPrPreview(base?: string): Promise<PrPreview | null> {
  try {
    const params = base ? `?base=${encodeURIComponent(base)}` : "";
    const r = await fetch(apiUrl(`/v1/workspace/pr/preview${params}`));
    if (r.status === 503) return null;
    if (!r.ok) throw new Error(`pr preview: ${r.status}`);
    return (await r.json()) as PrPreview;
  } catch (e: any) {
    console.warn("pr preview failed", e);
    return null;
  }
}

export interface CreatePrInput {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  push?: boolean;
}

export interface CreatePrResult {
  ok: true;
  url: string;
  draft: boolean;
}

export async function createPr(input: CreatePrInput): Promise<CreatePrResult> {
  const r = await fetch(apiUrl("/v1/workspace/pr"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: input.body ?? "",
      base: input.base,
      draft: input.draft ?? true,
      push: input.push ?? true,
    }),
  });
  const body = await r.json().catch(() => ({} as any));
  if (!r.ok) {
    const hint = body?.hint ? ` (${body.hint})` : "";
    throw new Error((body?.error || `create PR failed: ${r.status}`) + hint);
  }
  return body as CreatePrResult;
}
