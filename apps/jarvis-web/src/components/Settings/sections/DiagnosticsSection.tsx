// Settings → Diagnostics tab. Phase 5b.
//
// Today: lists orphan worktrees (directories under
// `JARVIS_WORKTREE_ROOT` whose run id no longer exists in the
// store) and offers a single "Clean up all" button. Future
// shapes (stuck runs, failed-run digests) will land alongside
// once `RequirementRunStore::list_all` exists.

import { useEffect, useState } from "react";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import type { RequirementRun } from "../../../types/frames";
import {
  cleanupOrphanWorktrees,
  listFailedRuns,
  listOrphanWorktrees,
  listStuckRuns,
  type CleanupReport,
  type OrphanWorktree,
  type StuckRun,
} from "../../../services/diagnostics";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MiB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function DiagnosticsSection() {
  const [orphans, setOrphans] = useState<OrphanWorktree[] | null>(null);
  const [stuck, setStuck] = useState<StuckRun[] | null>(null);
  const [failed, setFailed] = useState<RequirementRun[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    setBusy(true);
    try {
      const items = await listOrphanWorktrees();
      if (items === null) {
        setUnavailable(true);
        setOrphans([]);
      } else {
        setUnavailable(false);
        setOrphans(items);
      }
      // The two run-store-only queries are independent of the
      // worktree feature — they work whenever a run store is
      // configured (which is "any persistent setup").
      const stuckRows = await listStuckRuns();
      setStuck(stuckRows);
      const failedRows = await listFailedRuns();
      setFailed(failedRows);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const cleanup = async () => {
    if (!confirm(tx("diagnosticsConfirmCleanup", "Remove every orphan worktree?"))) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = await cleanupOrphanWorktrees();
      setReport(r);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="diagnostics"
      titleKey="settingsDiagnosticsTitle"
      titleFallback="Diagnostics"
      descKey="settingsDiagnosticsDesc"
      descFallback="Lists worktree directories whose run id no longer exists. These pile up after crashes or after a run was deleted without DELETE /v1/runs/:id/worktree being called first."
    >
      <h3 className="settings-diagnostics-subhead">{t("diagnosticsOrphansHeading")}</h3>
      {unavailable ? (
        <p className="settings-diagnostics-empty">
          {tx(
            "diagnosticsUnavailable",
            "Worktree feature not configured (set JARVIS_WORKTREE_MODE=per_run).",
          )}
        </p>
      ) : (
        <>
          <div className="settings-diagnostics-toolbar">
            <button type="button" onClick={refresh} disabled={busy}>
              {tx("diagnosticsRefresh", "Refresh")}
            </button>
            <button
              type="button"
              onClick={cleanup}
              disabled={busy || !orphans || orphans.length === 0}
              className="danger"
            >
              {tx("diagnosticsCleanupAll", "Clean up all")}
            </button>
          </div>
          {error && <p className="settings-diagnostics-error">{error}</p>}
          {report && (
            <p className="settings-diagnostics-report">
              {tx(
                "diagnosticsCleanupReport",
                `Removed ${report.removed}/${report.attempted} orphan worktree(s).`,
              )}
              {report.errors.length > 0 && (
                <span> ({report.errors.length} errors)</span>
              )}
            </p>
          )}
          {orphans && orphans.length === 0 ? (
            <p className="settings-diagnostics-empty">
              {tx("diagnosticsNoOrphans", "No orphan worktrees. ✨")}
            </p>
          ) : (
            <ul className="settings-diagnostics-list" role="list">
              {(orphans ?? []).map((o) => (
                <li key={o.path} className="settings-diagnostics-row">
                  <code className="settings-diagnostics-path" title={o.path}>
                    {o.path}
                  </code>
                  <span className="settings-diagnostics-meta">
                    {formatBytes(o.size_bytes)} · {formatTime(o.modified_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="settings-diagnostics-subhead">{t("diagnosticsStuckHeading")}</h3>
      {stuck === null ? (
        <p className="settings-diagnostics-empty">{t("diagnosticsRunStoreUnavailable")}</p>
      ) : stuck.length === 0 ? (
        <p className="settings-diagnostics-empty">{t("diagnosticsNoStuck")}</p>
      ) : (
        <ul className="settings-diagnostics-list" role="list">
          {stuck.map((r) => (
            <li key={r.id} className="settings-diagnostics-row">
              <code className="settings-diagnostics-path" title={r.id}>
                {r.id.slice(0, 8)} · {r.status}
              </code>
              <span className="settings-diagnostics-meta">
                age {formatAge(r.age_seconds)} · started {formatTime(r.started_at)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="settings-diagnostics-subhead">{t("diagnosticsFailedHeading")}</h3>
      {failed === null ? (
        <p className="settings-diagnostics-empty">{t("diagnosticsRunStoreUnavailable")}</p>
      ) : failed.length === 0 ? (
        <p className="settings-diagnostics-empty">{t("diagnosticsNoFailed")}</p>
      ) : (
        <ul className="settings-diagnostics-list" role="list">
          {failed.map((r) => (
            <li key={r.id} className="settings-diagnostics-row">
              <code className="settings-diagnostics-path" title={r.id}>
                {r.id.slice(0, 8)}
                {r.error ? ` · ${r.error.slice(0, 60)}` : ""}
              </code>
              <span className="settings-diagnostics-meta">
                {r.finished_at
                  ? `finished ${formatTime(r.finished_at)}`
                  : `started ${formatTime(r.started_at)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
