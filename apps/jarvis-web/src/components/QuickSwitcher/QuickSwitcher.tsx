// Quick switcher modal — Claude.ai-style "Search chats and projects"
// dialog. Opened by Cmd+P or the sidebar topbar 🔍 button. Two
// sections coexist:
//
//   1. **Recents / title matches** — instant client-side filter over
//      the loaded conversation list (titles + id prefix). Cheap,
//      fires on every keystroke.
//   2. **Matches in messages** — debounced server-side full-text
//      search via `/v1/conversations/search` for queries 2+ chars
//      long. Renders snippets with the hit highlighted via `<mark>`.
//
// Up/Down navigates across the merged result list; Enter opens the
// selected conversation; Esc / click-outside closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { resolveTitle } from "../../store/persistence";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";
import { resumeConversation } from "../../services/conversations";
import { searchConversations, type SearchHit } from "../../services/search";
import type { ConvoListRow } from "../../types/frames";

const TITLE_RESULT_CAP = 12;
const RECENT_CAP = 12;
const DEEP_SEARCH_DEBOUNCE_MS = 240;
const DEEP_SEARCH_MIN_CHARS = 2;

/// Unified result row — either a "title hit" (sidebar list match) or
/// a "deep hit" (server-side message body match with snippets). The
/// modal renders both kinds in one keyboard-navigable list so Up/Down
/// flows naturally across sections.
type Result =
  | { kind: "title"; row: ConvoListRow }
  | { kind: "deep"; hit: SearchHit };

function resultId(r: Result): string {
  return r.kind === "title" ? r.row.id : r.hit.id;
}

export function QuickSwitcher() {
  const open = useAppStore((s) => s.quickOpen);
  const setOpen = useAppStore((s) => s.setQuickOpen);
  if (!open) return null;
  return <QuickSwitcherModal close={() => setOpen(false)} />;
}

function QuickSwitcherModal({ close }: { close: () => void }) {
  const rows = useAppStore((s) => s.convoRows);
  const projectsById = useAppStore((s) => s.projectsById);
  const activeId = useAppStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [deepHits, setDeepHits] = useState<SearchHit[]>([]);
  const [deepLoading, setDeepLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // ---- Title-prefix matches over the cached convo list ------------
  const titleMatches = useMemo(() => filterRows(rows, query), [rows, query]);

  // ---- Debounced deep search (only above min char count) ----------
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < DEEP_SEARCH_MIN_CHARS) {
      setDeepHits([]);
      setDeepLoading(false);
      return;
    }
    setDeepLoading(true);
    const handle = window.setTimeout(async () => {
      const hits = await searchConversations(trimmed, { limit: 20 });
      // `null` = a newer query is in flight; do nothing.
      if (hits !== null) {
        setDeepHits(hits);
        setDeepLoading(false);
      }
    }, DEEP_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  // ---- Merge into one keyboard-navigable result list --------------
  const merged: Result[] = useMemo(() => {
    const titleHits: Result[] = titleMatches.map((row) => ({ kind: "title", row }));
    const titleIds = new Set(titleMatches.map((r) => r.id));
    // Drop deep hits that already showed up as title matches so the
    // same conversation doesn't appear twice on screen.
    const deepOnly: Result[] = deepHits
      .filter((h) => !titleIds.has(h.id))
      .map((hit) => ({ kind: "deep", hit }));
    return [...titleHits, ...deepOnly];
  }, [titleMatches, deepHits]);

  // Auto-focus on mount; clamp / reset cursor when results shift.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (index >= merged.length) setIndex(0);
  }, [merged.length, index]);
  // Keep the active row scrolled into view as the cursor moves.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const accept = (r: Result | undefined) => {
    close();
    if (!r) return;
    const id = resultId(r);
    if (id !== activeId) void resumeConversation(id);
  };

  const trimmedQuery = query.trim();
  const showRecentLabel = trimmedQuery.length === 0 && titleMatches.length > 0;
  const showTitleLabel = trimmedQuery.length > 0 && titleMatches.length > 0;
  const showDeepLabel = trimmedQuery.length >= DEEP_SEARCH_MIN_CHARS;

  return (
    <div
      id="quick-switcher"
      className="quick-switcher"
      role="dialog"
      aria-label={t("quickSwitcherDialogLabel") || "Search chats"}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="quick-switcher-card">
        <div className="quick-switcher-searchbar">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            id="quick-switcher-input"
            ref={inputRef}
            type="text"
            className="quick-switcher-input"
            placeholder={t("quickSwitcherPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                if (merged.length) setIndex((i) => (i + 1) % merged.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (merged.length) setIndex((i) => (i - 1 + merged.length) % merged.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                accept(merged[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <button
            id="quick-switcher-close"
            type="button"
            className="ghost-icon"
            title={t("close") || "Close"}
            aria-label="Close"
            onClick={close}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <ul className="quick-switcher-list" id="quick-switcher-list">
          {showRecentLabel && (
            <li className="quick-switcher-section-label" role="presentation">
              {t("quickSwitcherRecents") || "Recent"}
            </li>
          )}
          {showTitleLabel && (
            <li className="quick-switcher-section-label" role="presentation">
              {t("quickSwitcherTitleMatches") || "Conversations"}
            </li>
          )}
          {merged.length === 0 && trimmedQuery.length === 0 && (
            <li className="quick-switcher-empty">{t("noConversations")}</li>
          )}
          {titleMatches.map((row, i) => {
            const project = row.project_id ? projectsById[row.project_id] : null;
            const isActive = i === index;
            return (
              <li
                key={`title:${row.id}`}
                ref={isActive ? activeRef : null}
                className={"quick-switcher-row" + (isActive ? " active" : "")}
                onClick={() => accept({ kind: "title", row })}
                onMouseEnter={() => setIndex(i)}
              >
                <div className="quick-switcher-title">{resolveTitle(row)}</div>
                <div className="quick-switcher-meta">
                  {project && (
                    <span className="quick-switcher-project">{project.name}</span>
                  )}
                  <span>{row.id.slice(0, 8)}</span>
                  <span>{t("msgCount", row.message_count)}</span>
                  <span>{relTime(row.updated_at || row.created_at)}</span>
                </div>
              </li>
            );
          })}

          {showDeepLabel && (
            <li className="quick-switcher-section-label" role="presentation">
              {deepLoading
                ? t("quickSwitcherSearchingMessages") || "Searching messages…"
                : t("quickSwitcherMessageMatches") || "Matches in messages"}
              {!deepLoading && deepHits.length > 0 && (
                <span className="quick-switcher-section-count"> · {deepHits.length}</span>
              )}
            </li>
          )}

          {!deepLoading
            && trimmedQuery.length >= DEEP_SEARCH_MIN_CHARS
            && deepHits.filter((h) => !titleMatches.some((tm) => tm.id === h.id)).length === 0
            && titleMatches.length === 0 && (
            <li className="quick-switcher-empty">
              {(t("searchNoMatches") || "No messages contain “{q}”.").replace(
                "{q}",
                trimmedQuery,
              )}
            </li>
          )}

          {deepHits
            .filter((h) => !titleMatches.some((tm) => tm.id === h.id))
            .map((hit, j) => {
              const i = titleMatches.length + j;
              const project = hit.project_id ? projectsById[hit.project_id] : null;
              const isActive = i === index;
              return (
                <li
                  key={`deep:${hit.id}`}
                  ref={isActive ? activeRef : null}
                  className={
                    "quick-switcher-row quick-switcher-row-deep"
                    + (isActive ? " active" : "")
                  }
                  onClick={() => accept({ kind: "deep", hit })}
                  onMouseEnter={() => setIndex(i)}
                >
                  <div className="quick-switcher-title">
                    {hit.title ?? "#" + hit.id.slice(0, 8)}
                    <span className="quick-switcher-deep-count">{hit.match_count}</span>
                  </div>
                  <ul className="quick-switcher-snippets">
                    {hit.snippets.slice(0, 2).map((s, k) => (
                      <li key={k} className="quick-switcher-snippet">
                        <span className="quick-switcher-snippet-role">{s.role}</span>
                        <span className="quick-switcher-snippet-text">
                          {s.before}
                          <mark>{s.hit}</mark>
                          {s.after}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {project && (
                    <div className="quick-switcher-meta">
                      <span className="quick-switcher-project">{project.name}</span>
                      <span>{relTime(hit.updated_at)}</span>
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
        <div className="quick-switcher-hint">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("navigate") || "navigate"}</span>
          <span><kbd>↵</kbd> {t("open") || "open"}</span>
          <span><kbd>Esc</kbd> {t("close") || "close"}</span>
        </div>
      </div>
    </div>
  );
}

function filterRows(rows: ConvoListRow[], q: string): ConvoListRow[] {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return rows.slice(0, RECENT_CAP);
  return rows
    .filter((r) => {
      const title = resolveTitle(r).toLowerCase();
      return title.includes(trimmed) || r.id.toLowerCase().startsWith(trimmed);
    })
    .slice(0, TITLE_RESULT_CAP);
}
