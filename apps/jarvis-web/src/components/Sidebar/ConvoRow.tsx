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
import { Ban, Download, Icon, Pencil, Pin, Trash2 } from "../ui";

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
            <Icon
              icon={Pin}
              size={13}
              fill={isPinned ? "currentColor" : "none"}
              strokeWidth={1.8}
            />
          </button>
          <button
            type="button"
            className="convo-action export"
            title={t("exportMd")}
            aria-label={t("exportMd")}
            onClick={(e) => { e.stopPropagation(); void exportConversationMarkdown(row.id); }}
          >
            <Icon icon={Download} size={13} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="convo-action rename"
            title={t("rename")}
            aria-label={t("rename")}
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          >
            <Icon icon={Pencil} size={13} strokeWidth={1.8} />
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
              <Icon icon={Ban} size={13} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className="convo-action delete"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={(e) => { e.stopPropagation(); void deleteConversation(row.id); }}
          >
            <Icon icon={Trash2} size={13} strokeWidth={1.8} />
          </button>
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
