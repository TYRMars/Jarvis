// M2.3 UX: transient toast that surfaces an out-of-band
// permission-mode change. The mode-badge in the header updates
// silently, which is fine when the operator clicked it
// themselves — but when the agent self-switched via
// `enter_plan_mode`, the user needs a visible cue or they'll
// wonder why the next turn behaves differently.
//
// The store action only fires this when the `via` field is
// present (server-emitted). Operator-initiated changes through
// the same handler don't include `via` (or pass `via:"user"`),
// so this stays dormant for the common case.
//
// Auto-clears after `AUTO_CLEAR_MS`. Sticky-style: a brand-new
// change in the same window resets the timer and re-shows.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";

const AUTO_CLEAR_MS = 6000;

export function ModeChangedToast() {
  const recent = useAppStore((s) => s.recentModeChange);
  const clear = useAppStore((s) => s.setRecentModeChange);
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);

  useEffect(() => {
    if (!recent) return;
    // Reset any prior hide-debounce when a fresh change arrives.
    setHiddenAt(null);
    const id = window.setTimeout(() => {
      setHiddenAt(Date.now());
      clear(null);
    }, AUTO_CLEAR_MS);
    return () => window.clearTimeout(id);
  }, [recent, clear]);

  // Operator-initiated changes (via:"user" or no via) are silent —
  // the mode badge already reflects the click, no need to toast.
  if (!recent) return null;
  if (recent.via === "user") return null;
  if (hiddenAt !== null && hiddenAt > recent.at) return null;

  return (
    <div className="mode-changed-toast" role="status" aria-live="polite">
      <span className="mode-changed-toast-icon" aria-hidden="true">⇄</span>
      <span className="mode-changed-toast-body">
        {describe(recent.via)} switched permission mode to{" "}
        <strong>{recent.mode}</strong>
        {recent.mode === "plan" ? " — next turn will be read-only." : ""}
      </span>
      <button
        type="button"
        className="mode-changed-toast-close"
        aria-label="Dismiss"
        onClick={() => clear(null)}
      >
        ×
      </button>
    </div>
  );
}

function describe(via: string): string {
  switch (via) {
    case "tool":
      return "Agent";
    case "plan_accepted":
      return "Plan accept";
    default:
      return "Mode change";
  }
}
