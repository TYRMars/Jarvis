// Reusable diagnostics body — three "异常项" sections (orphan
// worktrees with cleanup, stuck Pending/Running runs, recent failed
// runs) extracted from the original `DiagnosticsPage` so the same
// markup can be embedded inside Work Overview without duplicating
// hooks / fetchers. The outer page chrome (`<main>` + `<header>`)
// stays in `DiagnosticsPage` for legacy `/diagnostics` callers.
//
// Each section degrades gracefully: 503 from the service helper
// returns `null` and the section renders a "feature unavailable"
// note rather than vanishing. That way an operator embedding this
// inside Work Overview always sees what's missing instead of being
// surprised by a blank gap.

import { useCallback, useEffect, useState } from "react";
import { t } from "../../utils/i18n";
import {
  cleanupOrphanWorktrees,
  listFailedRuns,
  listOrphanWorktrees,
  listStuckRuns,
  type CleanupReport,
  type OrphanWorktree,
  type StuckRun,
} from "../../services/diagnostics";
import type { RequirementRun } from "../../types/frames";

type Loadable<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; error: string };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function DiagnosticsPanels() {
  const [orphans, setOrphans] = useState<Loadable<OrphanWorktree[] | null>>({
    state: "loading",
  });
  const [stuck, setStuck] = useState<Loadable<StuckRun[] | null>>({
    state: "loading",
  });
  const [failed, setFailed] = useState<Loadable<RequirementRun[] | null>>({
    state: "loading",
  });
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);

  const refreshOrphans = useCallback(async () => {
    setOrphans({ state: "loading" });
    try {
      setOrphans({ state: "ready", value: await listOrphanWorktrees() });
    } catch (e) {
      setOrphans({
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const refreshStuck = useCallback(async () => {
    setStuck({ state: "loading" });
    try {
      setStuck({ state: "ready", value: await listStuckRuns() });
    } catch (e) {
      setStuck({
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const refreshFailed = useCallback(async () => {
    setFailed({ state: "loading" });
    try {
      setFailed({ state: "ready", value: await listFailedRuns() });
    } catch (e) {
      setFailed({
        state: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void refreshOrphans();
    void refreshStuck();
    void refreshFailed();
  }, [refreshOrphans, refreshStuck, refreshFailed]);

  const handleCleanup = async () => {
    if (cleaningUp) return;
    if (!window.confirm(t("diagnosticsConfirmCleanup"))) return;
    setCleaningUp(true);
    setCleanupReport(null);
    try {
      const report = await cleanupOrphanWorktrees();
      setCleanupReport(report);
      void refreshOrphans();
    } catch (e) {
      setCleanupReport({
        attempted: 0,
        removed: 0,
        errors: [
          {
            path: "(top-level)",
            reason: e instanceof Error ? e.message : String(e),
          },
        ],
      });
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <>
      {/* ---- Orphan worktrees -------------------------------------- */}
      <section className="diagnostics-section">
        <div className="diagnostics-section-head">
          <h2>{t("diagnosticsOrphansHeading")}</h2>
          <div className="diagnostics-section-actions">
            <button
              type="button"
              className="settings-btn"
              onClick={() => void refreshOrphans()}
            >
              {t("diagnosticsRefresh")}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-danger"
              onClick={() => void handleCleanup()}
              disabled={
                cleaningUp ||
                orphans.state !== "ready" ||
                orphans.value === null ||
                orphans.value.length === 0
              }
            >
              {cleaningUp
                ? t("diagnosticsCleanupPending")
                : t("diagnosticsCleanupAll")}
            </button>
          </div>
        </div>
        {renderOrphans(orphans)}
        {cleanupReport && (
          <div className="diagnostics-cleanup-report">
            <div>
              {t(
                "diagnosticsCleanupSummary",
                cleanupReport.attempted,
                cleanupReport.removed,
              )}
            </div>
            {cleanupReport.errors.length > 0 && (
              <ul className="diagnostics-cleanup-errors">
                {cleanupReport.errors.map((e) => (
                  <li key={e.path}>
                    <code>{e.path}</code> — {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ---- Stuck runs --------------------------------------------- */}
      <section className="diagnostics-section">
        <div className="diagnostics-section-head">
          <h2>{t("diagnosticsStuckHeading")}</h2>
          <button
            type="button"
            className="settings-btn"
            onClick={() => void refreshStuck()}
          >
            {t("diagnosticsRefresh")}
          </button>
        </div>
        {renderStuck(stuck)}
      </section>

      {/* ---- Recent failed runs ------------------------------------- */}
      <section className="diagnostics-section">
        <div className="diagnostics-section-head">
          <h2>{t("diagnosticsFailedHeading")}</h2>
          <button
            type="button"
            className="settings-btn"
            onClick={() => void refreshFailed()}
          >
            {t("diagnosticsRefresh")}
          </button>
        </div>
        {renderFailed(failed)}
      </section>
    </>
  );
}

function renderOrphans(state: Loadable<OrphanWorktree[] | null>) {
  if (state.state === "loading")
    return <p className="text-soft">{t("diagnosticsLoading")}</p>;
  if (state.state === "error")
    return <p className="diagnostics-error">{state.error}</p>;
  if (state.value === null)
    return <p className="text-soft">{t("diagnosticsUnavailable")}</p>;
  if (state.value.length === 0)
    return <p className="text-soft">{t("diagnosticsNoOrphans")}</p>;
  return (
    <ul className="diagnostics-list">
      {state.value.map((o) => (
        <li key={o.path}>
          <code className="diagnostics-path">{o.path}</code>
          <span className="text-soft">
            {fmtBytes(o.size_bytes)} · {o.modified_at} · run{" "}
            <code>{o.run_id.slice(0, 8)}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderStuck(state: Loadable<StuckRun[] | null>) {
  if (state.state === "loading")
    return <p className="text-soft">{t("diagnosticsLoading")}</p>;
  if (state.state === "error")
    return <p className="diagnostics-error">{state.error}</p>;
  if (state.value === null)
    return <p className="text-soft">{t("diagnosticsRunStoreUnavailable")}</p>;
  if (state.value.length === 0)
    return <p className="text-soft">{t("diagnosticsNoStuck")}</p>;
  return (
    <ul className="diagnostics-list">
      {state.value.map((r) => (
        <li key={r.id}>
          <code>{r.id.slice(0, 8)}</code>
          <span>
            {t(
              "diagnosticsStuckEntry",
              r.status,
              fmtDuration(r.age_seconds),
            )}
          </span>
          <span className="text-soft">started {r.started_at}</span>
        </li>
      ))}
    </ul>
  );
}

function renderFailed(state: Loadable<RequirementRun[] | null>) {
  if (state.state === "loading")
    return <p className="text-soft">{t("diagnosticsLoading")}</p>;
  if (state.state === "error")
    return <p className="diagnostics-error">{state.error}</p>;
  if (state.value === null)
    return <p className="text-soft">{t("diagnosticsRunStoreUnavailable")}</p>;
  if (state.value.length === 0)
    return <p className="text-soft">{t("diagnosticsNoFailed")}</p>;
  return (
    <ul className="diagnostics-list">
      {state.value.map((r) => (
        <li key={r.id}>
          <code>{r.id.slice(0, 8)}</code>
          <span className="text-soft">
            req <code>{r.requirement_id.slice(0, 8)}</code> · finished{" "}
            {r.finished_at ?? "?"}
          </span>
          {r.error && (
            <span className="diagnostics-error-line">
              {r.error.slice(0, 200)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
