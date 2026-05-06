// One conversation row in the sidebar. Click anywhere on the row
// resumes; the action cluster (pin / export / rename / delete) is
// `stopPropagation`'d so a button click doesn't double-fire as a
// resume. Inline rename swaps the title span for an `<input>`;
// Enter / blur commits, Esc cancels.

import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { resolveTitle } from "../../store/persistence";
import { t } from "../../utils/i18n";
import { resumeConversation, deleteConversation } from "../../services/conversations";
import { exportConversationMarkdown } from "../../services/export";
import type { ConvoListRow } from "../../types/frames";

interface Props {
  row: ConvoListRow;
  isPinned: boolean;
}

export function ConvoRow({ row, isPinned }: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const runtime = useAppStore((s) => s.conversationRuns[row.id]);
  const togglePin = useAppStore((s) => s.togglePin);
  const setTitleOverride = useAppStore((s) => s.setTitleOverride);
  // Subscribing to titleOverrides triggers a re-render after rename.
  useAppStore((s) => s.titleOverrides);

  const [editing, setEditing] = useState(false);
  const titleText = resolveTitle(row);

  const status = runtime?.status ?? "idle";
  const isActiveRun =
    status === "running" || status === "waiting_approval" || status === "waiting_hitl";

  return (
    <li
      data-id={row.id}
      data-run-status={status}
      className={(row.id === activeId ? "active" : "") + (isActiveRun ? " running" : "")}
      onClick={() => {
        if (editing) return;
        void resumeConversation(row.id);
      }}
    >
      <span className="convo-dot" aria-hidden="true" />
      <div className="convo-line">
        {editing ? (
          <RenameInput
            initial={titleText}
            onCommit={(v) => {
              setTitleOverride(row.id, v && v !== row.title ? v : null);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className="convo-title" title={titleText}>{titleText}</span>
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
          <button
            type="button"
            className="convo-action delete"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={(e) => { e.stopPropagation(); void deleteConversation(row.id); }}
          >×</button>
        </div>
      </div>
    </li>
  );
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
