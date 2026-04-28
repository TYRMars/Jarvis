// Conversation full-text search. Wraps `GET /v1/conversations/search`,
// which scans every conversation's message bodies in-process on the
// server (no inverted index — fine at the row counts we run at, see
// the route's `SEARCH_SCAN_BUDGET`).
//
// Sole consumer today: the QuickSwitcher modal (Cmd+P / topbar 🔍).
// Debounced inside the modal; this module's monotonic seq guard
// ensures stale responses from a slower previous request can't
// overwrite the latest results when the user is typing fast.

import { apiUrl } from "./api";

/// One match snippet — a single occurrence of the search term inside
/// one message of a conversation, with up to ~80 chars of context on
/// each side. Multiple snippets per conversation are returned for the
/// first few matches so the UI can show a representative slice of the
/// hits without dumping the whole message.
export interface SearchSnippet {
  role: "user" | "assistant" | "system" | "tool";
  ord: number;
  before: string;
  hit: string;
  after: string;
}

export interface SearchHit {
  id: string;
  title: string | null;
  project_id: string | null;
  updated_at: string;
  match_count: number;
  snippets: SearchSnippet[];
}

let searchSeq = 0;

/// Run a full-text search and return the hits, or `null` if the
/// request was superseded by a newer query mid-flight (so the caller
/// can ignore stale responses). Errors are swallowed and reported as
/// `[]` — search failure shouldn't break the sidebar; the operator
/// can still pick a conversation manually.
export async function searchConversations(
  query: string,
  opts: { projectId?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchHit[] | null> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const mySeq = ++searchSeq;
  const params = new URLSearchParams({ q: trimmed });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.projectId) params.set("project_id", opts.projectId);

  try {
    const res = await fetch(apiUrl(`/v1/conversations/search?${params.toString()}`), {
      signal: opts.signal,
    });
    if (mySeq !== searchSeq) return null;
    if (res.status === 503) return [];
    if (!res.ok) {
      console.warn("search failed", res.status);
      return [];
    }
    const hits = (await res.json()) as SearchHit[];
    if (mySeq !== searchSeq) return null;
    return hits;
  } catch (e: any) {
    if (e?.name === "AbortError") return null;
    console.warn("search error", e);
    return [];
  }
}
