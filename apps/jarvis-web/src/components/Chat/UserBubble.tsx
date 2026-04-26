// User message bubble. Hover reveals the ✏️ "edit and rerun"
// affordance; clicking enters inline-edit mode. Submitting sends
// a `fork` frame keyed by the bubble's `userOrdinal` and lets the
// server-echo `forked` event prune subsequent UI rows.

import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { sendFrame, isOpen } from "../../services/socket";

interface Props {
  uid: string;
  content: string;
  userOrdinal: number;
}

export function UserBubble({ uid: _uid, content, userOrdinal }: Props) {
  const [editing, setEditing] = useState(false);
  const inFlight = useAppStore((s) => s.inFlight);
  const setInFlight = useAppStore((s) => s.setInFlight);
  const showBanner = useAppStore((s) => s.showBanner);

  return (
    <div
      className="msg-row user"
      data-user-ordinal={userOrdinal}
    >
      <div className="msg-content">
        <div className="msg-author-row">
          <div className="msg-author">{t("user")}</div>
          {!editing && (
            <button
              type="button"
              className="msg-edit-btn"
              title={t("editAndRerun")}
              aria-label={t("editAndRerun")}
              onClick={(e) => {
                e.stopPropagation();
                if (inFlight) {
                  showBanner(t("turnInProgress"));
                  return;
                }
                setEditing(true);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          )}
        </div>
        {editing ? (
          <UserEditor
            initial={content}
            onCancel={() => setEditing(false)}
            onSubmit={(value) => {
              const v = value.trim();
              if (!v || !isOpen()) {
                setEditing(false);
                return;
              }
              const frame: any = { type: "fork", user_ordinal: userOrdinal, content: v };
              const routing = useAppStore.getState().routing;
              if (routing) {
                const idx = routing.indexOf("|");
                const provider = idx >= 0 ? routing.slice(0, idx) : routing;
                const model = idx >= 0 ? routing.slice(idx + 1) : "";
                if (provider) frame.provider = provider;
                if (model) frame.model = model;
              }
              if (!sendFrame(frame)) {
                setEditing(false);
                return;
              }
              setEditing(false);
              setInFlight(true);
            }}
          />
        ) : (
          <div className="msg-body">{content}</div>
        )}
      </div>
      <div className="msg-avatar">{t("user").slice(0, 1) === t("user") ? t("user") : t("user").slice(0, 2)}</div>
    </div>
  );
}

function UserEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="user-edit">
      <textarea
        className="user-edit-input"
        rows={3}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit(value);
          }
        }}
      />
      <div className="user-edit-actions">
        <div className="user-edit-hint">{t("rerunHint")}</div>
        <button
          type="button"
          className="user-edit-cancel"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          className="user-edit-send"
          onClick={(e) => { e.stopPropagation(); onSubmit(value); }}
        >
          {t("rerun")}
        </button>
      </div>
    </div>
  );
}
