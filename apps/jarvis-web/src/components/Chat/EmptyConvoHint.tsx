// Tiny "Conversation #abc12345 started, type below to begin" card
// shown right after a fresh `new` event. Self-clears once any
// message lands (the store sets `emptyHintIdShort: null` on first
// `pushUserMessage` / `appendDelta` etc.).

import { t } from "../../utils/i18n";

export function EmptyConvoHint({ idShort }: { idShort: string }) {
  return (
    <div className="empty-convo-hint">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <p>{t("emptyConvoHint", idShort)}</p>
    </div>
  );
}
