// Fullscreen recovery overlay shown only inside the Tauri desktop
// shell when the bundled Jarvis sidecar isn't reachable. In a plain
// browser this is a no-op: the runtime check (`window.__TAURI__`)
// returns null so the component renders nothing and never polls.
//
// When the sidecar is missing or returned an error, we render a
// blocking card with the last error message, the Tauri-side log
// tail, a "Choose workspace" button (re-points the sidecar at a
// folder the user can write to / has the right project layout) and
// a "Retry" button (re-issues `restart_server`). On success the
// overlay clears itself and the underlying app continues from where
// the boot sequence left off.

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

export function DesktopStartupOverlay() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchDesktopStatus();
        if (cancelled) return;
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

  // Auto-expand the log panel on the first failure so users
  // immediately see the actual stderr (missing API key, port
  // collision, …) instead of having to reach for "Show recent logs".
  useEffect(() => {
    if (status?.last_error && !status.server_running) {
      setShowLogs(true);
    }
  }, [status?.last_error, status?.server_running]);

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

  const errorMsg = status.last_error ?? t("desktopServerUnavailable");

  const onRetry = async () => {
    setWorking(true);
    try {
      const next = await restartDesktopServer();
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
      if (next) setStatus(next);
    } catch (e) {
      console.warn("desktop workspace pick failed", e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="desktop-startup-overlay" role="alertdialog" aria-modal="true">
      <div className="desktop-startup-card">
        <h1 className="desktop-startup-title">{t("desktopServerUnavailable")}</h1>
        <p className="desktop-startup-hint">{t("desktopServerHint")}</p>
        <div className="desktop-startup-error">{errorMsg}</div>
        {status.workspace ? (
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
            className="btn ghost"
            onClick={() => setShowLogs((v) => !v)}
            aria-expanded={showLogs}
          >
            {showLogs ? t("desktopHideLogs") : t("desktopShowLogs")}
          </button>
        </div>
        {showLogs ? (
          <pre className="desktop-startup-logs" aria-live="polite">
            {logs.length ? logs.join("\n") : "—"}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
