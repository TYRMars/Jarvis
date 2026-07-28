// Non-blocking recovery panel shown only inside the desktop shell
// when the bundled Jarvis server isn't reachable. In a plain
// browser this is a no-op: the runtime check (`window.__TAURI__`)
// returns null so the component renders nothing and never polls.
//
// When the server is missing or returned an error, we render a
// dismissible diagnostic card with the last error message, a Provider
// settings shortcut, workspace picking, and retry. On success the
// panel clears itself and the underlying app continues from where the
// boot sequence left off.

import { useEffect, useState } from "react";
import {
  fetchDesktopLogs,
  fetchDesktopStatus,
  isDesktopRuntime,
  restartDesktopServer,
  selectDesktopWorkspace,
  type DesktopStatus,
} from "../../services/desktop";
import { t } from "../../utils/i18n";

const POLL_MS = 2000;
const SETTINGS_TARGET_KEY = "jarvis.settings.target";

function navigateToDesktopOrigin(status: DesktopStatus | null) {
  if (!status?.server_running || status.last_error) return;
  if (!status.api_origin || window.location.origin === status.api_origin) return;
  window.location.assign(`${status.api_origin}/${window.location.hash || ""}`);
}

export function DesktopStartupOverlay() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchDesktopStatus();
        if (cancelled) return;
        navigateToDesktopOrigin(next);
        setStatus(next);
      } catch (e) {
        console.warn("desktop status poll failed", e);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!showLogs) return;
    let cancelled = false;
    void (async () => {
      const next = await fetchDesktopLogs(80);
      if (!cancelled) setLogs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [showLogs, status?.last_error, status?.server_running]);

  if (!status) return null;
  if (status.server_running && !status.last_error) return null;
  if (dismissed) return null;

  const errorMsg = status.last_error ?? t("desktopServerUnavailable");

  const onRetry = async () => {
    setWorking(true);
    try {
      const next = await restartDesktopServer();
      navigateToDesktopOrigin(next);
      if (next) setStatus(next);
    } catch (e) {
      console.warn("desktop restart failed", e);
    } finally {
      setWorking(false);
    }
  };

  const onPickWorkspace = async () => {
    setWorking(true);
    try {
      const ws = await selectDesktopWorkspace();
      if (!ws) return;
      const next = await restartDesktopServer(ws);
      navigateToDesktopOrigin(next);
      if (next) setStatus(next);
    } catch (e) {
      console.warn("desktop workspace pick failed", e);
    } finally {
      setWorking(false);
    }
  };

  const onConfigureProvider = () => {
    sessionStorage.setItem(SETTINGS_TARGET_KEY, JSON.stringify({ id: "models" }));
    window.location.hash = "#/settings";
  };

  if (!expanded) {
    return (
      <div className="desktop-startup-overlay" role="region" aria-label={t("desktopServerUnavailable")}>
        <div className="desktop-startup-card is-compact">
          <div className="desktop-startup-compact-main" title={errorMsg}>
            <span className="desktop-startup-status-dot" aria-hidden="true" />
            <span className="desktop-startup-title">{t("desktopServerUnavailable")}</span>
          </div>
          <div className="desktop-startup-compact-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => void onRetry()}
              disabled={working}
            >
              {working ? t("desktopRetrying") : t("desktopRetry")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onConfigureProvider}
              disabled={working}
            >
              {t("desktopProviderShort")}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setExpanded(true)}
            >
              {t("desktopDetails")}
            </button>
            <button
              type="button"
              className="desktop-startup-dismiss"
              onClick={() => setDismissed(true)}
              aria-label={t("desktopContinueUsing")}
              title={t("desktopContinueUsing")}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-startup-overlay" role="region" aria-label={t("desktopServerUnavailable")}>
      <div className="desktop-startup-card is-expanded">
        <div className="desktop-startup-head">
          <h1 className="desktop-startup-title">{t("desktopServerUnavailable")}</h1>
          <button
            type="button"
            className="desktop-startup-dismiss"
            onClick={() => setDismissed(true)}
            aria-label={t("desktopContinueUsing")}
            title={t("desktopContinueUsing")}
          >
            ×
          </button>
        </div>
        {expanded ? <p className="desktop-startup-hint">{t("desktopServerHint")}</p> : null}
        <div className="desktop-startup-error">{errorMsg}</div>
        {expanded && status.workspace ? (
          <div className="desktop-startup-meta">
            <span className="desktop-startup-meta-label">{t("desktopWorkspaceLabel")}</span>
            <code className="desktop-startup-meta-value">{status.workspace}</code>
          </div>
        ) : null}
        <div className="desktop-startup-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void onRetry()}
            disabled={working}
          >
            {working ? t("desktopRetrying") : t("desktopRetry")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onPickWorkspace()}
            disabled={working}
          >
            {t("desktopChooseWorkspace")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onConfigureProvider}
            disabled={working}
          >
            {t("desktopConfigureProvider")}
          </button>
          {expanded ? (
            <>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDismissed(true)}
              >
                {t("desktopContinueUsing")}
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setShowLogs((v) => !v)}
                aria-expanded={showLogs}
              >
                {showLogs ? t("desktopHideLogs") : t("desktopShowLogs")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setExpanded(true)}
            >
              {t("desktopDetails")}
            </button>
          )}
        </div>
        {expanded && showLogs ? (
          <pre className="desktop-startup-logs" aria-live="polite">
            {logs.length ? logs.join("\n") : "—"}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
