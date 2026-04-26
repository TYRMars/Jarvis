// First fully-React component on the new architecture: subscribes
// to the central app store, renders the WS connection status text +
// CSS class. Replaces the imperative `els.status.textContent = ...`
// path inside legacy.ts; the bridge from `setStatus()` → store lives
// in legacy/status.ts (next batch).

import { useAppStore } from "../store/appStore";
import { t } from "../utils/i18n";

export function ConnectionStatus() {
  // Subscribing to multiple slices via separate selectors is the
  // Zustand-recommended pattern: each selector triggers a re-render
  // only when its slice's identity changes.
  const statusKey = useAppStore((s) => s.statusKey);
  const statusClass = useAppStore((s) => s.statusClass);
  const connection = useAppStore((s) => s.connection);

  // Fall back to the connection enum when no explicit status key has
  // been pushed yet (boot, before the first WS event).
  const text = statusKey ? t(statusKey) : t(connection);
  const cls = `ws-status${statusClass ? " " + statusClass : ""}`;

  // Keep the original `id="status"` so the imperative legacy code
  // that still reads `els.status.dataset.statusKey` doesn't break
  // mid-migration. A future batch removes the `els.status` reads
  // entirely and lets this component own the node outright.
  return (
    <span id="status" className={cls} data-status-key={statusKey ?? ""}>
      {text}
    </span>
  );
}
