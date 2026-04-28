// WebSocket connection status badge. Subscribes to:
//   - statusKey  (most recent intent: "connected" / "reconnecting" / …)
//   - statusClass (CSS class: connected | warn | error | null)
//   - connection (legacy enum, fallback when statusKey is null)
//   - reconnectAttempt (badge text appends "(N)" while > 0)
//
// While disconnected / reconnecting, the badge becomes a button: a
// click runs `reconnectSocket()` to skip the backoff timer. The
// keyboard-accessible interaction matches what every other "I see
// this is broken, let me retry now" UI does.

import { useAppStore } from "../store/appStore";
import { reconnectSocket } from "../services/socket";
import { t } from "../utils/i18n";

export function ConnectionStatus() {
  const statusKey = useAppStore((s) => s.statusKey);
  const statusClass = useAppStore((s) => s.statusClass);
  const connection = useAppStore((s) => s.connection);
  const attempt = useAppStore((s) => s.reconnectAttempt);

  // Fall back to the connection enum when no explicit status key has
  // been pushed yet (boot, before the first WS event).
  const baseText = statusKey ? t(statusKey) : t(connection);
  const text = attempt > 0 ? `${baseText} (${attempt})` : baseText;
  const cls = `ws-status${statusClass ? " " + statusClass : ""}`;

  // Make the badge clickable when we're not connected so the user
  // can short-circuit backoff without reaching for the page reload.
  const interactive =
    statusKey === "reconnecting" ||
    statusKey === "disconnected" ||
    statusKey === "offline" ||
    statusKey === "websocketError" ||
    connection === "disconnected" ||
    connection === "error";

  if (interactive) {
    return (
      <button
        type="button"
        id="status"
        className={`${cls} ws-status-btn`}
        data-status-key={statusKey ?? ""}
        title={t("reconnectNow")}
        onClick={() => reconnectSocket()}
      >
        {text}
      </button>
    );
  }

  // Keep the original `id="status"` so any imperative legacy code
  // that still reads `els.status.dataset.statusKey` doesn't break.
  return (
    <span id="status" className={cls} data-status-key={statusKey ?? ""}>
      {text}
    </span>
  );
}
