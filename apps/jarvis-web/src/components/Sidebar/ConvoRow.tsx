// One conversation row in the sidebar. Click anywhere on the row
// resumes; the action cluster (pin / export / rename / delete) is
// `stopPropagation`'d so a button click doesn't double-fire as a
// resume. Inline rename swaps the title span for an `<input>`;
// Enter / blur commits, Esc cancels.

import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { resolveTitle } from "../../store/persistence";
import { t } from "../../utils/i18n";
import { relTime } from "../../utils/time";
import {
  resumeConversation,
  deleteConversation,
  abandonConversation,
} from "../../services/conversations";
import { exportConversationMarkdown } from "../../services/export";
import type { ConvoListRow } from "../../types/frames";

interface Props {
  row: ConvoListRow;
  isPinned: boolean;
  unreadCount?: number;
}

export function ConvoRow({ row, isPinned, unreadCount = 0 }: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const runtime = useAppStore((s) => s.conversationRuns[row.id]);
  const project = useAppStore((s) =>
    row.project_id ? s.projectsById[row.project_id] : null,
  );
  const togglePin = useAppStore((s) => s.togglePin);
  const setTitleOverride = useAppStore((s) => s.setTitleOverride);
  // Subscribing to titleOverrides triggers a re-render after rename.
  const titleOverrides = useAppStore((s) => s.titleOverrides);

  const [editing, setEditing] = useState(false);
  const titleText = resolveTitle(row);

  const status = runtime?.status ?? "idle";
  const isActiveRun =
    status === "running" || status === "waiting_approval" || status === "waiting_hitl";
  const isRequirement = row.source === "requirement" || !!row.requirement_title;
  // Treat missing field as `active` for forward compat with older
  // servers / cached rows.
  const lifecycle = row.lifecycle ?? "active";
  const isAbandoned = lifecycle === "abandoned";
  const isArchived = lifecycle === "archived";
  const manualTitle = titleOverrides[row.id]?.trim();
  const displayTitle = manualTitle || row.requirement_title?.trim() || titleText;
  const timeLabel = relTime(row.updated_at || row.created_at);
  const statusLabel = runStatusLabel(status);
  const metaItems = [
    isRequirement ? t("convoSourceRequirement") : null,
    statusLabel,
    unreadCount > 0 ? t("unreadCount", unreadCount) : null,
    isAbandoned ? t("convoLifecycleAbandoned") : null,
    isArchived ? t("convoLifecycleArchived") : null,
    project?.name ?? null,
    timeLabel,
  ].filter(Boolean);
  const rowLabel = metaItems.length > 0
    ? `${displayTitle} · ${metaItems.join(" · ")}`
    : displayTitle;

  return (
    <li
      data-id={row.id}
      data-run-status={status}
      data-source={isRequirement ? "requirement" : "chat"}
      data-lifecycle={lifecycle}
      className={[
        row.id === activeId ? "active" : "",
        isActiveRun ? "running" : "",
        isAbandoned ? "is-abandoned" : "",
        isArchived ? "is-archived" : "",
      ].filter(Boolean).join(" ")}
    >
      <span className="convo-dot" aria-hidden="true" />
      <div className="convo-line" aria-hidden={!editing ? "true" : undefined}>
        {editing ? (
          <RenameInput
            initial={titleText}
            onCommit={(v) => {
              setTitleOverride(row.id, v && v !== row.title ? v : null);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </div>
      {!editing && (
        <button
          type="button"
          className="convo-main"
          aria-current={row.id === activeId ? "page" : undefined}
          aria-label={rowLabel}
          onClick={() => void resumeConversation(row.id)}
        >
          <span className="convo-title-zone">
            {isRequirement && (
              <span className="convo-chip source" aria-hidden="true">
                {t("convoSourceRequirementShort")}
              </span>
            )}
            <span className="convo-title">{displayTitle}</span>
            {unreadCount > 0 && isActiveRun && (
              <span className="convo-unread-dot" aria-hidden="true" />
            )}
          </span>
          <span className="convo-row-meta" aria-hidden="true">
            {isActiveRun ? (
              <span className="convo-spinner" />
            ) : unreadCount > 0 ? (
              <span className="convo-unread-badge">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : (
              <span className="convo-time">{timeLabel}</span>
            )}
            {project?.name && <span className="sr-only">{project.name}</span>}
          </span>
        </button>
      )}
      <div className="convo-actions">
          <button
            type="button"
            className={"convo-action pin" + (isPinned ? " active" : "")}
            title={t(isPinned ? "unpin" : "pin")}
            aria-label={t(isPinned ? "unpin" : "pin")}
            onClick={(e) => { e.stopPropagation(); togglePin(row.id); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5" />
              <path d="M9 10h6l1 7H8l1-7Z" />
              <path d="M10 10V3h4v7" />
            </svg>
          </button>
          <button
            type="button"
            className="convo-action export"
            title={t("exportMd")}
            aria-label={t("exportMd")}
            onClick={(e) => { e.stopPropagation(); void exportConversationMarkdown(row.id); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
          </button>
          <button
            type="button"
            className="convo-action rename"
            title={t("rename")}
            aria-label={t("rename")}
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          {!isAbandoned && (
            <button
              type="button"
              className="convo-action abandon"
              title={t("abandonHint")}
              aria-label={t("abandon")}
              onClick={(e) => {
                e.stopPropagation();
                void abandonConversation(row.id);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="convo-action delete"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={(e) => { e.stopPropagation(); void deleteConversation(row.id); }}
          >×</button>
      </div>
    </li>
  );
}

function runStatusLabel(status: string): string | null {
  switch (status) {
    case "running":
      return t("convoStatusRunning");
    case "waiting_approval":
      return t("convoStatusApproval");
    case "waiting_hitl":
      return t("convoStatusInput");
    case "failed":
      return t("convoStatusFailed");
    case "cancelled":
      return t("convoStatusCancelled");
    default:
      return null;
  }
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      className="convo-rename-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); onCommit(value); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
    />
  );
}
