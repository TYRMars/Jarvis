// Send + Stop buttons. React owns visibility (className) + disabled
// state via subscriptions to `inFlight` and `composerValue`. The
// Send button is the form's submit trigger — `<Composer>`'s onSubmit
// catches the click. The Stop button dispatches an `interrupt` frame
// through the WS service.

import { useAppStore } from "../store/appStore";
import { requestInterrupt } from "../services/socket";
import { t } from "../utils/i18n";
import { ArrowRight, Icon, Square } from "./ui";

export function SendButton({ canSend }: { canSend?: boolean }) {
  const inFlight = useAppStore((s) => s.inFlight);
  const value = useAppStore((s) => s.composerValue);
  const ready = canSend ?? Boolean(value.trim());
  return (
    <button
      type="submit"
      id="send"
      className={"send-btn" + (inFlight ? " hidden" : "")}
      title={t("send")}
      data-i18n-title="send"
      disabled={inFlight || !ready}
    >
      <Icon icon={ArrowRight} size={17} strokeWidth={2.2} />
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
      title={t("stop")}
      data-i18n-title="stop"
      aria-label={t("stop")}
      onClick={() => requestInterrupt()}
    >
      <Icon icon={Square} size={14} fill="currentColor" strokeWidth={0} />
    </button>
  );
}
