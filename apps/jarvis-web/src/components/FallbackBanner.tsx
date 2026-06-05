// Inline banner that surfaces provider-fallback hops.
//
// Shows when the agent loop emits one or more `provider_fallback`
// frames during the current chat turn. The banner is auto-dismissing:
// it fades after a few seconds so a transient rate-limit recovery
// doesn't permanently clutter the chat header. Operators who want
// the full history can check the server's `tracing` log or the
// observability dashboard.
//
// Phase 4.6 of the model-tool-compatibility rollout.

import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { t } from "../utils/i18n";

const VISIBLE_MS = 8_000;

export function FallbackBanner() {
  const history = useAppStore((s) => s.fallbackHistory);
  const latest = history[0];
  const [now, setNow] = useState(() => Date.now());

  // Refresh the wall-clock once a second while the banner is
  // potentially visible so the auto-dismiss kicks in without
  // requiring another store update.
  useEffect(() => {
    if (!latest) return undefined;
    const age = now - latest.receivedAt;
    if (age >= VISIBLE_MS) return undefined;
    const remaining = VISIBLE_MS - age;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [latest, now]);

  if (!latest) return null;
  if (now - latest.receivedAt > VISIBLE_MS) return null;

  return (
    <div className="fallback-banner" role="status" aria-live="polite">
      <span className="fallback-banner-icon" aria-hidden="true">
        ↻
      </span>
      <span className="fallback-banner-body">
        <strong>{t("chatCoreProviderFallback")}</strong>
        <span className="fallback-banner-arrow"> · </span>
        <span className="mono">{latest.from}</span>
        <span className="fallback-banner-arrow"> → </span>
        <span className="mono">{latest.to}</span>
        {latest.model ? (
          <>
            <span className="fallback-banner-arrow"> · </span>
            <span className="mono">{latest.model}</span>
          </>
        ) : null}
        {latest.reason ? (
          <span className="fallback-banner-reason"> ({latest.reason})</span>
        ) : null}
      </span>
    </div>
  );
}
