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
import type { ConvoListRow, Project } from "../../types/frames";
import { resumeConversation } from "../../services/conversations";
import { EmptyState } from "../shared/EmptyState";
import { ConvoRow } from "./ConvoRow";
import type { ConversationRunStatus, ConversationSurfaceSnapshot } from "../../store/types";
import type { ConvoGroupBy } from "../../store/persistence";

export function ConvoList() {
  const rows = useAppStore((s) => s.convoRows);
  const pinned = useAppStore((s) => s.pinned);
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const activeId = useAppStore((s) => s.activeId);
  const quickOpen = useAppStore((s) => s.quickOpen);
  const conversationRuns = useAppStore((s) => s.conversationRuns);
  const conversationSurfaces = useAppStore((s) => s.conversationSurfaces);
  const convoGroupBy = useAppStore((s) => s.convoGroupBy);
  const setConvoGroupBy = useAppStore((s) => s.setConvoGroupBy);
  const projectsById = useAppStore((s) => s.projectsById);

  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const runningEntries = Object.entries(conversationRuns)
    .filter(([, runtime]) => isRunActive(runtime.status))
    .sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0));
  const runningIds = new Set(runningEntries.map(([id]) => id));
  const pinnedRows = rows.filter((r) => pinned.has(r.id) && !runningIds.has(r.id));
  const recentRows = rows.filter((r) => !pinned.has(r.id) && !runningIds.has(r.id));
  const runningRows = runningEntries.map(
    ([id]) => rowsById.get(id) ?? makeFallbackRow(id, conversationSurfaces[id]),
  );

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
      const all = uniqueRows([...runningRows, ...pinnedRows, ...recentRows]);
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
          "sidebar-section running-section" +
          (runningRows.length === 0 ? " hidden" : "")
        }
        id="running-section"
      >
        <div className="section-label">{t("running")}</div>
        <ul id="running-list">
          {runningRows.map((r) => (
            <ConvoRow key={r.id} row={r} isPinned={pinned.has(r.id)} />
          ))}
        </ul>
      </div>

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
        <div className="convo-group-toolbar">
          <GroupByToggle mode={convoGroupBy} onChange={setConvoGroupBy} />
        </div>
        <ConvoStatus kind={status} />
        <ul id="convo-list">
          {recentsHaveContent &&
            renderGroupedRows(recentRows, convoGroupBy, projectsById).map((entry) =>
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

function renderGroupedRows(
  rows: ConvoListRow[],
  mode: ConvoGroupBy,
  projectsById: Record<string, Project>,
): RenderEntry[] {
  if (mode === "project") return renderGroupedByProject(rows, projectsById);
  return renderGroupedByDate(rows);
}

function renderGroupedByDate(rows: ConvoListRow[]): RenderEntry[] {
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

/// Bucket rows into one section per project. Sections are ordered by
/// the most-recent-row-in-the-bucket so the active project floats to
/// the top; rows inside a section keep the incoming sort order
/// (server hands them back newest-first). Free-chat rows (no
/// `project_id`) land in a "Free chat" bucket pinned to the bottom.
function renderGroupedByProject(
  rows: ConvoListRow[],
  projectsById: Record<string, Project>,
): RenderEntry[] {
  const FREE_KEY = "__free__";
  const buckets = new Map<string, { label: string; rows: ConvoListRow[] }>();
  for (const row of rows) {
    const pid = row.project_id ?? null;
    const key = pid ?? FREE_KEY;
    const label = pid
      ? projectsById[pid]?.name ?? pid
      : t("groupNoProject");
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { label, rows: [row] });
  }
  const ordered = Array.from(buckets.entries()).sort(([ak], [bk]) => {
    if (ak === FREE_KEY) return 1;
    if (bk === FREE_KEY) return -1;
    return 0;
  });
  const out: RenderEntry[] = [];
  for (const [, bucket] of ordered) {
    out.push({ kind: "group", label: bucket.label });
    for (const r of bucket.rows) out.push({ kind: "row", row: r });
  }
  return out;
}

function GroupByToggle({
  mode,
  onChange,
}: {
  mode: ConvoGroupBy;
  onChange: (mode: ConvoGroupBy) => void;
}) {
  const next: ConvoGroupBy = mode === "date" ? "project" : "date";
  const label = mode === "date" ? t("groupByDate") : t("groupByProject");
  return (
    <button
      type="button"
      className="convo-group-toggle"
      aria-label={t("groupByLabel")}
      title={`${t("groupByLabel")}: ${label}`}
      onClick={() => onChange(next)}
    >
      {mode === "date" ? <CalendarIcon /> : <FolderIcon />}
      <span>{label}</span>
    </button>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function isRunActive(status?: ConversationRunStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_hitl";
}

function makeFallbackRow(
  id: string,
  surface?: ConversationSurfaceSnapshot,
): ConvoListRow {
  return {
    id,
    title: surfaceTitle(surface),
    message_count: surface?.messages.length ?? 0,
    created_at: null,
    updated_at: null,
  };
}

function surfaceTitle(surface?: ConversationSurfaceSnapshot): string | null {
  const firstUser = surface?.messages.find((m) => m.kind === "user");
  if (!firstUser || typeof firstUser.content !== "string") return null;
  const title = firstUser.content.trim().replace(/\s+/g, " ");
  return title ? title.slice(0, 80) : null;
}

function uniqueRows(rows: ConvoListRow[]): ConvoListRow[] {
  const seen = new Set<string>();
  const out: ConvoListRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
