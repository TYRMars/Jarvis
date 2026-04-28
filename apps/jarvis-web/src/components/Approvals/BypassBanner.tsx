// Persistent banner shown above the message list whenever the
// per-socket permission mode is `bypass`. Distinct from the regular
// transient `Banner` (which auto-hides after a few seconds) — this
// one stays up the whole time bypass is active so the user never
// loses track of "I am running with no approval gates right now".
//
// Click to switch back to `ask` (the safest mode). Server echoes a
// `permission_mode` frame and the banner unmounts on its own.

import { useAppStore } from "../../store/appStore";
import { setSocketMode } from "../../services/permissions";
import { t } from "../../utils/i18n";

export function BypassBanner() {
  const mode = useAppStore((s) => s.permissionMode);
  if (mode !== "bypass") return null;
  return (
    <div className="bypass-banner" role="alert">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
      </svg>
      <span className="bypass-banner-text">{t("permModeBypassActiveBanner")}</span>
      <button
        type="button"
        className="bypass-banner-btn"
        onClick={() => setSocketMode("ask")}
      >
        {t("permModeAsk")}
      </button>
    </div>
  );
}
