import { useMemo, useState } from "react";
import { setDocScope, useDocScope, type DocScope } from "../../services/docScope";
import type { DocKind, DocProject } from "../../types/frames";

export type { DocScope } from "../../services/docScope";

export type DocSort = "updated" | "created" | "title";

export interface DocFilterState {
  scope: DocScope;
  sort: DocSort;
  query: string;
}

/// Hook used by the docs page. The scope itself lives in
/// `services/docScope` so the global sidebar can drive it; sort and
/// query are local to the list column.
export function useDocFilterState() {
  const scope = useDocScope();
  const [sort, setSort] = useState<DocSort>("updated");
  const [query, setQuery] = useState("");
  return {
    state: { scope, sort, query },
    setScope: (next: DocScope) => setDocScope(next),
    setSort,
    setQuery,
  };
}

interface ApplyFilterOpts {
  projects: DocProject[];
  filter: DocFilterState;
  /** When provided, used to surface a body-text snippet in search.
   *  Keyed by project id. */
  drafts?: Map<string, string | null>;
}

export interface FilteredDoc {
  project: DocProject;
  /** Search-matched snippet from body, or null when no query / no match. */
  snippet: string | null;
}

/// Apply scope + query + sort to a project list. Returns wrapped
/// objects so the list rendering layer can show optional snippets
/// without having to re-do the substring match.
export function applyDocFilter({
  projects,
  filter,
  drafts,
}: ApplyFilterOpts): FilteredDoc[] {
  const { scope, query, sort } = filter;

  const inScope = projects.filter((p) => {
    // Archived docs are hidden from every scope except "archived".
    if (scope.type !== "archived" && p.archived) return false;
    switch (scope.type) {
      case "all":
        return true;
      case "pinned":
        return !!p.pinned;
      case "archived":
        return !!p.archived;
      case "kind":
        return p.kind === scope.kind;
      case "tag":
        return (p.tags ?? []).includes(scope.tag);
    }
  });

  const q = query.trim().toLowerCase();
  const matched: FilteredDoc[] = inScope.flatMap((p): FilteredDoc[] => {
    if (!q) return [{ project: p, snippet: null }];
    if (p.title.toLowerCase().includes(q)) {
      return [{ project: p, snippet: null }];
    }
    if ((p.tags ?? []).some((t) => t.toLowerCase().includes(q))) {
      return [{ project: p, snippet: null }];
    }
    const body = drafts?.get(p.id) ?? null;
    if (body) {
      const lower = body.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 24);
        const end = Math.min(body.length, idx + q.length + 56);
        const slice =
          (start > 0 ? "…" : "") +
          body.slice(start, end).replace(/\s+/g, " ").trim() +
          (end < body.length ? "…" : "");
        return [{ project: p, snippet: slice }];
      }
    }
    return [];
  });

  matched.sort((a, b) => {
    // Pinned always floats to top under "all" / "kind" / "tag" scopes
    // (but not under "pinned" — already filtered — or "archived",
    // where pinning has been overridden by the archive intent).
    if (scope.type !== "pinned" && scope.type !== "archived") {
      if (!!a.project.pinned !== !!b.project.pinned) {
        return a.project.pinned ? -1 : 1;
      }
    }
    switch (sort) {
      case "updated":
        return b.project.updated_at.localeCompare(a.project.updated_at);
      case "created":
        return b.project.created_at.localeCompare(a.project.created_at);
      case "title":
        return a.project.title.localeCompare(b.project.title);
    }
  });

  return matched;
}

/// Aggregate counts per scope category for the rail. Memoised by the
/// caller via useMemo.
export interface DocCounts {
  all: number;
  pinned: number;
  archived: number;
  kinds: Record<DocKind, number>;
  tags: Map<string, number>;
}

export function useDocCounts(projects: DocProject[]): DocCounts {
  return useMemo(() => {
    const counts: DocCounts = {
      all: 0,
      pinned: 0,
      archived: 0,
      kinds: { note: 0, research: 0, report: 0, design: 0, guide: 0 },
      tags: new Map(),
    };
    for (const p of projects) {
      if (p.archived) {
        counts.archived += 1;
        continue;
      }
      counts.all += 1;
      if (p.pinned) counts.pinned += 1;
      counts.kinds[p.kind] = (counts.kinds[p.kind] ?? 0) + 1;
      for (const t of p.tags ?? []) {
        counts.tags.set(t, (counts.tags.get(t) ?? 0) + 1);
      }
    }
    return counts;
  }, [projects]);
}
