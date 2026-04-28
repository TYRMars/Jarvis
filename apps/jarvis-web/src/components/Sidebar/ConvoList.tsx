// Sidebar conversation list. Splits the live `convoRows` into a
// pinned section (always on top) + a chronologically-grouped recents
// section.
//
// The inline title-prefix filter that used to live above this list
// has moved into the QuickSwitcher modal (Cmd+P / topbar 🔍) — it's
// the same filter logic plus deep full-text search across message
// bodies, all in one place. The list itself is now plain "show
// everything we know about", grouped and pinned.

import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { convoGroupLabel } from "../../utils/time";
import type { ConvoListRow } from "../../types/frames";
import { ConvoRow } from "./ConvoRow";

export function ConvoList() {
  const rows = useAppStore((s) => s.convoRows);
  const pinned = useAppStore((s) => s.pinned);
  const persistEnabled = useAppStore((s) => s.persistEnabled);

  const pinnedRows = rows.filter((r) => pinned.has(r.id));
  const recentRows = rows.filter((r) => !pinned.has(r.id));

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
  if (!kind) return <p id="convos-status" className="empty-state" />;
  return (
    <p id="convos-status" className="empty-state" data-kind={kind}>
      {kind === "disabled" && (
        <>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span>{t("persistenceDisabled")}</span>
        </>
      )}
      {kind === "empty" && (
        <>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>{t("noConversations")}</span>
        </>
      )}
    </p>
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
