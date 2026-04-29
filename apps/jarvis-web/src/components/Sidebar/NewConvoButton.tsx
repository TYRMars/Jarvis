// Sidebar "New session" button. It now behaves like Claude Code's
// flow: open a blank draft and let the composer chips carry the
// workspace / project context for the first message.

import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { sendFrame } from "../../services/socket";
import { t } from "../../utils/i18n";

export function NewConvoButton() {
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const inFlight = useAppStore((s) => s.inFlight);
  const activeFilter = useAppStore((s) => s.activeProjectFilter);
  const navigate = useNavigate();

  const onClick = () => {
    const store = useAppStore.getState();
    if (store.inFlight) return;
    void navigate("/");
    if (!store.persistEnabled) {
      if (sendFrame({ type: "reset" })) {
        store.clearMessages();
        store.setActiveId(null);
      }
      return;
    }
    store.clearMessages();
    store.setActiveId(null);
    store.setDraftProjectId?.(activeFilter ?? store.draftProjectId ?? null);
    window.setTimeout(() => document.getElementById("input")?.focus(), 0);
  };

  return (
    <button
      id="new-convo"
      type="button"
      className="nav-item"
      title={t("newConversation")}
      disabled={!persistEnabled || inFlight}
      onClick={onClick}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
      <span>{t("newSession")}</span>
    </button>
  );
}
