// v1.0 — top-of-page system-status bar for the WorkOverview surface.
//
// Goal: an operator skimming this page should know within 1s **what
// the agent runtime is doing right now and whether they need to act**.
//
// Design notes after the first round of feedback ("3 floating pills
// don't tell me what's going on"):
//
//   - Every pill names its dimension via a leading label — "运行 ·
//     空闲" beats a bare "空闲" because the prefix removes the "what
//     is this measuring?" question.
//   - The auto-mode pill is a real toggle (button), not a status
//     glyph. It looked clickable so it should behave clickable.
//   - A one-sentence plain-language summary lives under the pills.
//     This is the actual answer to "what's happening" — the pills
//     are the supporting evidence. The summary changes with state:
//       · idle + auto on   → "系统空闲，自动模式待命中。"
//       · running + auto on → "正在自动执行 N 个需求。"
//       · degraded         → "有 N 个失败 / N 个被阻塞，建议处理。"
//   - Data freshness ("19 秒前") is demoted to a tiny inline meta
//     row next to refresh, not a primary pill — operators skim for
//     state, not timestamps.
//
// Accessibility: the pulse animation respects `prefers-reduced-motion`
// (the dot freezes at 100% opacity rather than animating). Icons are
// SVG (no emoji). Pills carry both colour AND a label so colourblind
// operators aren't excluded.

import { useEffect, useState } from "react";
import { t } from "../../../utils/i18n";
import type { WorkOverview } from "../../../services/workOverview";
import {
  getAutoModeStatus,
  setAutoModeEnabled,
  type AutoModeStatus,
} from "../../../services/autoMode";

type Health = "running" | "active" | "degraded" | "idle" | "unavailable";

interface Props {
  overview: WorkOverview | null;
  unavailable: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function deriveHealth(
  overview: WorkOverview | null,
  unavailable: boolean,
): Health {
  if (unavailable) return "unavailable";
  if (!overview) return "idle";
  const failed = overview.run_status_counts?.failed ?? 0;
  const running = overview.running_now?.length ?? 0;
  const blocked = overview.blocked_requirements?.length ?? 0;
  if (failed > 0 || blocked > 0) return "degraded";
  if (running > 0) return "running";
  if ((overview.run_status_counts?.completed ?? 0) > 0) return "active";
  return "idle";
}

function formatRelative(ms: number): string {
  if (ms < 5_000) return t("statusJustNow");
  if (ms < 60_000) return t("statusSecondsAgo", Math.floor(ms / 1000));
  if (ms < 3_600_000) return t("statusMinutesAgo", Math.floor(ms / 60_000));
  return t("statusHoursAgo", Math.floor(ms / 3_600_000));
}

/// Build the one-sentence plain-language summary that anchors the
/// banner. This is the line operators read first; the pills below
/// are evidence for the claim it makes.
function buildSummary(
  health: Health,
  overview: WorkOverview | null,
  auto: AutoModeStatus | null,
): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (health === "unavailable") {
    return { text: t("statusSummaryUnavailable"), tone: "danger" };
  }
  const failed = overview?.run_status_counts?.failed ?? 0;
  const blocked = overview?.blocked_requirements?.length ?? 0;
  const running = overview?.running_now?.length ?? 0;
  const autoOn = !!auto?.enabled;

  if (health === "degraded") {
    return {
      text: t("statusSummaryDegraded", failed, blocked),
      tone: "danger",
    };
  }
  if (health === "running") {
    return autoOn
      ? { text: t("statusSummaryRunningAuto", running), tone: "ok" }
      : { text: t("statusSummaryRunningManual", running), tone: "ok" };
  }
  if (health === "active") {
    return autoOn
      ? { text: t("statusSummaryActiveAuto"), tone: "ok" }
      : { text: t("statusSummaryActiveManual"), tone: "neutral" };
  }
  // idle
  if (auto && !auto.configured) {
    return { text: t("statusSummaryIdleNoAuto"), tone: "neutral" };
  }
  return autoOn
    ? { text: t("statusSummaryIdleAuto"), tone: "ok" }
    : { text: t("statusSummaryIdleManual"), tone: "warn" };
}

export function SystemStatusBanner({
  overview,
  unavailable,
  loading,
  error,
  onRefresh,
}: Props) {
  const health = deriveHealth(overview, unavailable);

  // Auto-mode pill state. Refreshes once on mount + every time the
  // user toggles via the project-board (we lazily re-poll on focus).
  const [autoMode, setAutoMode] = useState<AutoModeStatus | null>(null);
  const [autoPending, setAutoPending] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getAutoModeStatus().then((s) => {
        if (!cancelled) setAutoMode(s);
      });
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const onToggleAuto = async () => {
    if (!autoMode || !autoMode.configured || autoPending) return;
    setAutoPending(true);
    setAutoError(null);
    try {
      const next = await setAutoModeEnabled(!autoMode.enabled);
      setAutoMode(next);
    } catch (e) {
      setAutoError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutoPending(false);
    }
  };

  // Live "X 秒前" tick. Recomputes once a second so the value never
  // sits more than ~1s stale; cheap enough to not bother memoising.
  const lastUpdateMs = overview?.as_of ? Date.parse(overview.as_of) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const ageMs = lastUpdateMs ? now - lastUpdateMs : null;

  const summary = buildSummary(health, overview, autoMode);
  const stale = ageMs !== null && ageMs >= 60_000;

  return (
    <div className="system-status-banner" role="status" aria-live="polite">
      <div className="system-status-summary-row">
        <SummaryIcon tone={summary.tone} />
        <div className="system-status-summary-body">
          <p className={"system-status-summary tone-" + summary.tone}>
            {summary.text}
          </p>
          <div className="system-status-pills">
            <HealthPill health={health} />
            <AutoModeToggle
              status={autoMode}
              pending={autoPending}
              onToggle={onToggleAuto}
            />
          </div>
        </div>
        <div className="system-status-meta">
          <span
            className={
              "system-status-freshness " +
              (loading ? "is-loading" : stale ? "is-stale" : "is-fresh")
            }
            title={
              ageMs === null
                ? t("statusNeverUpdated")
                : t("statusLastUpdated", formatRelative(ageMs))
            }
          >
            <span className="live-pulse-dot" aria-hidden="true" />
            <span>
              {t(
                "statusFreshnessLabel",
                ageMs === null ? t("statusNeverUpdated") : formatRelative(ageMs),
              )}
            </span>
          </span>
          <button
            type="button"
            className="system-status-refresh"
            onClick={onRefresh}
            disabled={loading}
            title={t("statusManualRefresh")}
            aria-label={t("statusManualRefresh")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={loading ? "is-spinning" : undefined}
            >
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 4v5h-5" />
            </svg>
            <span>{t("statusRefresh")}</span>
          </button>
        </div>
      </div>
      {(error || autoError) && (
        <div className="system-status-error" role="alert">
          {error
            ? t("workOverviewError", error)
            : t("autoModeFailed") + ": " + autoError}
        </div>
      )}
    </div>
  );
}

function SummaryIcon({ tone }: { tone: "ok" | "warn" | "danger" | "neutral" }) {
  // One bold glyph keyed to the summary's tone — gives the eye a
  // single hit-point before it lands on the sentence.
  const stroke = "currentColor";
  const cls = "system-status-summary-icon tone-" + tone;
  if (tone === "danger") {
    return (
      <span className={cls} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </span>
    );
  }
  if (tone === "warn") {
    return (
      <span className={cls} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>
    );
  }
  if (tone === "ok") {
    return (
      <span className={cls} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  return (
    <span className={cls} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
        <line x1="12" y1="12" x2="12" y2="16" />
      </svg>
    </span>
  );
}

function HealthPill({ health }: { health: Health }) {
  const labelMap: Record<Health, string> = {
    running: t("statusHealthRunning"),
    active: t("statusHealthActive"),
    degraded: t("statusHealthDegraded"),
    idle: t("statusHealthIdle"),
    unavailable: t("statusHealthUnavailable"),
  };
  return (
    <span
      className={"status-pill status-pill-health status-health-" + health}
      title={t("statusHealthTooltip", labelMap[health])}
    >
      <span className="status-pill-label">{t("statusPillLabelHealth")}</span>
      <HealthIcon health={health} />
      <span className="status-pill-value">{labelMap[health]}</span>
    </span>
  );
}

function HealthIcon({ health }: { health: Health }) {
  // Map each health state to a distinct glyph so the indicator is
  // not colour-only (a11y).
  const stroke = "currentColor";
  if (health === "running") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (health === "active") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    );
  }
  if (health === "degraded") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  if (health === "unavailable") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
    );
  }
  // idle
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function AutoModeToggle({
  status,
  pending,
  onToggle,
}: {
  status: AutoModeStatus | null;
  pending: boolean;
  onToggle: () => void;
}) {
  if (!status) {
    return (
      <span className="status-pill status-pill-auto status-auto-loading">
        <span className="status-pill-label">{t("statusPillLabelAuto")}</span>
        <span className="status-pill-value">…</span>
      </span>
    );
  }
  if (!status.configured) {
    return (
      <span
        className="status-pill status-pill-auto status-auto-unconfigured"
        title={t("statusAutoOffHint")}
      >
        <span className="status-pill-label">{t("statusPillLabelAuto")}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </svg>
        <span className="status-pill-value">{t("statusAutoUnconfigured")}</span>
      </span>
    );
  }
  const enabled = status.enabled;
  return (
    <button
      type="button"
      className={
        "status-pill status-pill-auto status-pill-toggle " +
        (enabled ? "status-auto-on" : "status-auto-off") +
        (pending ? " is-pending" : "")
      }
      onClick={onToggle}
      disabled={pending}
      aria-pressed={enabled}
      title={
        enabled
          ? t("statusAutoToggleHintOff")
          : t("statusAutoToggleHintOn")
      }
    >
      <span className="status-pill-label">{t("statusPillLabelAuto")}</span>
      <span
        className={"status-toggle-switch " + (enabled ? "is-on" : "is-off")}
        aria-hidden="true"
      >
        <span className="status-toggle-knob" />
      </span>
      <span className="status-pill-value">
        {enabled ? t("statusAutoOn") : t("statusAutoOff")}
      </span>
    </button>
  );
}
