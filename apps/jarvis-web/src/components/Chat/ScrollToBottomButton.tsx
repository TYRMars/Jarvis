// Floating "scroll to bottom" button. Appears only when the user has
// scrolled up away from the bottom of the message list and there are
// messages to scroll through. Clicking it snaps to the bottom and
// re-arms the auto-follow behavior (see `useStickToBottom`).

import { t } from "../../utils/i18n";

export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      className="scroll-to-bottom-btn"
      title={t("chatCoreScrollToBottom")}
      aria-label={t("chatCoreScrollToBottom")}
      onClick={onClick}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
    </button>
  );
}
