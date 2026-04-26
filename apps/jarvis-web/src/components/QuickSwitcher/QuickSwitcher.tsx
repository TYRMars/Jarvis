// Cmd+P quick switcher. A floating modal that fuzzy-matches across
// every loaded conversation by title or id prefix. Up/Down navigates,
// Enter resumes, Esc / click-outside closes. Renders nothing when
// `quickOpen` is false so the input + keydown handlers don't exist.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { resolveTitle } from "../../store/persistence";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";
import { resumeConversation } from "../../services/conversations";
import type { ConvoListRow } from "../../types/frames";

const MAX_RESULTS = 20;
const RECENT_CAP = 12;

export function QuickSwitcher() {
  const open = useAppStore((s) => s.quickOpen);
  const setOpen = useAppStore((s) => s.setQuickOpen);
  if (!open) return null;
  return <QuickSwitcherModal close={() => setOpen(false)} />;
}

function QuickSwitcherModal({ close }: { close: () => void }) {
  const rows = useAppStore((s) => s.convoRows);
  const activeId = useAppStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => filterRows(rows, query), [rows, query]);

  // Focus the input on mount; the modal is unmounted/remounted when
  // toggled so this fires every open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clamp the cursor when results shrink underneath us.
  useEffect(() => {
    if (index >= results.length) setIndex(0);
  }, [results.length, index]);

  const accept = (row: ConvoListRow | undefined) => {
    close();
    if (!row) return;
    if (row.id !== activeId) void resumeConversation(row.id);
  };

  return (
    <div
      id="quick-switcher"
      className="quick-switcher"
      role="dialog"
      aria-label="Quick switcher"
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
                if (results.length) setIndex((i) => (i + 1) % results.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (results.length) setIndex((i) => (i - 1 + results.length) % results.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                accept(results[index]);
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
          {results.length === 0 ? (
            <li className="quick-switcher-empty">{t("noMatches")}</li>
          ) : (
            results.map((row, i) => (
              <li
                key={row.id}
                className={"quick-switcher-row" + (i === index ? " active" : "")}
                onClick={() => accept(row)}
                onMouseEnter={() => setIndex(i)}
              >
                <div className="quick-switcher-title">{resolveTitle(row)}</div>
                <div className="quick-switcher-meta">
                  <span>{row.id.slice(0, 8)}</span>
                  <span>{t("msgCount", row.message_count)}</span>
                  <span>{relTime(row.updated_at || row.created_at)}</span>
                </div>
              </li>
            ))
          )}
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
    .slice(0, MAX_RESULTS);
}
