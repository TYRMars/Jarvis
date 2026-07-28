// Sidebar "New session" button. It now behaves like Claude Code's
// flow: open a blank draft and let the composer chips carry the
// workspace / project context for the first message.

import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { newConversation } from "../../services/conversations";
import { t } from "../../utils/i18n";
import { Icon, SquarePen } from "../ui";

export function NewConvoButton() {
  const activeFilter = useAppStore((s) => s.activeProjectFilter);
  const navigate = useNavigate();

  const onClick = () => {
    const store = useAppStore.getState();
    void navigate("/");
    newConversation({
      projectId: activeFilter ?? store.draftProjectId ?? null,
      workspacePath: store.draftWorkspacePath ?? null,
    });
    window.setTimeout(() => document.getElementById("input")?.focus(), 0);
  };

  return (
    <button
      id="new-convo"
      type="button"
      className="nav-item"
      title={t("newConversation")}
      onClick={onClick}
    >
      <Icon icon={SquarePen} size={17} strokeWidth={1.9} />
      <span>{t("newConversation")}</span>
      <kbd className="nav-shortcut" aria-hidden="true">⌘N</kbd>
    </button>
  );
}
