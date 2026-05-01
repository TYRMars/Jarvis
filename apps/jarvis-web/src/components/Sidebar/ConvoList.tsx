// Sidebar conversation list. Splits the live `convoRows` into a
// pinned section (always on top) + a chronologically-grouped recents
// section.
//
// The inline title-prefix filter that used to live above this list
// has moved into the QuickSwitcher modal (Cmd+P / topbar 🔍) — it's
// the same filter logic plus deep full-text search across message
// bodies, all in one place. The list itself is now plain "show
// everything we know about", grouped and pinned.

import { useEffect } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { convoGroupLabel } from "../../utils/time";
import type { ConvoListRow } from "../../types/frames";
import { resumeConversation } from "../../services/conversations";
import { EmptyState } from "../shared/EmptyState";
import { ConvoRow } from "./ConvoRow";

export function ConvoList() {
  const rows = useAppStore((s) => s.convoRows);
  const pinned = useAppStore((s) => s.pinned);
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const activeId = useAppStore((s) => s.activeId);
  const quickOpen = useAppStore((s) => s.quickOpen);

  const pinnedRows = rows.filter((r) => pinned.has(r.id));
  const recentRows = rows.filter((r) => !pinned.has(r.id));

  // ↑/↓ to walk the conversation list — mirrors the docs / projects
  // pattern so the same muscle memory works across all three
  // products. Combines pinned + recent in display order. Gated by
  // `!inEditable` (composer keeps its arrow keys) and `!quickOpen`
  // (quick-switcher modal owns its own arrow nav). Only fires on
  // the chat route — guarded by pathname check because the conv-list
  // lives in the sidebar but the user may have focus anywhere on
  // the chat surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (window.location.pathname !== "/") return;
      if (quickOpen) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;
      const all = [...pinnedRows, ...recentRows];
      if (all.length === 0) return;
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const idx = all.findIndex((r) => r.id === activeId);
      const nextIdx =
        idx < 0
          ? direction === 1
            ? 0
            : all.length - 1
          : (idx + direction + all.length) % all.length;
      void resumeConversation(all[nextIdx].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pinned, activeId, quickOpen]);

  const recentsHaveContent = recentRows.length > 0;
  const status: "" | "disabled" | "empty" = !persistEnabled
    ? "disabled"
    : rows.length === 0
    ? "empty"
    : "";

  return (
    <>
      <div
        className={
          "sidebar-section pinned-section" +
          (pinnedRows.length === 0 ? " hidden" : "")
        }
        id="pinned-section"
      >
        <div className="section-label">{t("pinned")}</div>
        <ul id="pinned-list">
          {pinnedRows.map((r) => (
            <ConvoRow key={r.id} row={r} isPinned={true} />
          ))}
        </ul>
      </div>

      <div className="sidebar-section recents-section">
        <div className="section-label">{t("recents")}</div>
        <ConvoStatus kind={status} />
        <ul id="convo-list">
          {recentsHaveContent &&
            renderGroupedRows(recentRows).map((entry) =>
              entry.kind === "group" ? (
                <li
                  key={`g:${entry.label}`}
                  className="convo-group-label"
                  role="presentation"
                >
                  {entry.label}
                </li>
              ) : (
                <ConvoRow key={entry.row.id} row={entry.row} isPinned={false} />
              ),
            )}
        </ul>
      </div>
    </>
  );
}

function ConvoStatus({ kind }: { kind: "" | "disabled" | "empty" }) {
  if (!kind) return null;
  if (kind === "disabled") {
    return (
      <EmptyState
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        }
        title={t("persistenceDisabled")}
      />
    );
  }
  return (
    <EmptyState
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      }
      title={t("noConversations")}
    />
  );
}

type RenderEntry =
  | { kind: "group"; label: string }
  | { kind: "row"; row: ConvoListRow };

function renderGroupedRows(rows: ConvoListRow[]): RenderEntry[] {
  const out: RenderEntry[] = [];
  let currentGroup = "";
  for (const row of rows) {
    const group = convoGroupLabel(row);
    if (group !== currentGroup) {
      currentGroup = group;
      out.push({ kind: "group", label: group });
    }
    out.push({ kind: "row", row });
  }
  return out;
}
