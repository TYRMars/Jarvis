// Send + Stop buttons. React owns visibility (className) + disabled
// state via subscriptions to `inFlight` and `composerValue`. The
// Send button is the form's submit trigger — `<Composer>`'s onSubmit
// catches the click. The Stop button dispatches an `interrupt` frame
// through the WS service.

import { useAppStore } from "../store/appStore";
import { requestInterrupt } from "../services/socket";

export function SendButton() {
  const inFlight = useAppStore((s) => s.inFlight);
  const value = useAppStore((s) => s.composerValue);
  const empty = !value.trim();
  return (
    <button
      type="submit"
      id="send"
      className={"send-btn" + (inFlight ? " hidden" : "")}
      title="Send"
      data-i18n-title="send"
      disabled={inFlight || empty}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </button>
  );
}

export function StopButton() {
  const inFlight = useAppStore((s) => s.inFlight);
  return (
    <button
      type="button"
      id="stop"
      className={"stop-btn" + (inFlight ? "" : " hidden")}
      title="Stop"
      data-i18n-title="stop"
      aria-label="Stop"
      onClick={() => requestInterrupt()}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="1" />
      </svg>
    </button>
  );
}
