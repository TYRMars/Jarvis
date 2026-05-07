import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../../../utils/i18n";
import { resumeConversation } from "../../../services/conversations";
import {
  listOrphanWorktrees,
  listStuckRuns,
  type OrphanWorktree,
  type StuckRun,
} from "../../../services/diagnostics";
import {
  getAutoModeStatus,
  setAutoModeEnabled,
  type AutoModeStatus,
} from "../../../services/autoMode";
import { aggregateIssues, type Issue } from "../../../services/issueAggregator";
import type { WorkOverview, WorkQuality } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
  quality: WorkQuality | null;
  overviewUnavailable: boolean;
  qualityUnavailable: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

type Tone = "ok" | "warn" | "danger" | "neutral";

interface QualitySignal {
  currentRate: number | null;
  delta: number;
  topCommand: string | null;
  topCommandFails: number;
}

interface HealthSignal {
  tone: Tone;
  label: string;
  value: string;
  detail: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

function formatPercent(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diff < 60) return t("relSecondsAgo", diff);
  if (diff < 3600) return t("relMinutesAgo", Math.floor(diff / 60));
  if (diff < 86400) return t("relHoursAgo", Math.floor(diff / 3600));
  return t("relDaysAgo", Math.floor(diff / 86400));
}

function qualitySignal(quality: WorkQuality | null): QualitySignal {
  const buckets =
    quality?.verification_pass_rate_by_day
      .map((b) => {
        const total = b.passed + b.failed + b.needs_review;
        return {
          date: b.date,
          total,
          rate: total > 0 ? b.passed / total : null,
        };
      })
      .filter((b) => b.rate !== null) ?? [];
  const first = buckets[0]?.rate ?? null;
  const latest = buckets[buckets.length - 1]?.rate ?? null;
  const top = quality?.top_failing_commands[0] ?? null;
  return {
    currentRate: latest,
    delta: first !== null && latest !== null ? latest - first : 0,
    topCommand: top?.command_normalized ?? null,
    topCommandFails: top?.fail_count ?? 0,
  };
}

function healthTone(
  overview: WorkOverview | null,
  quality: QualitySignal,
  issues: Issue[],
  unavailable: boolean,
): Tone {
  if (unavailable) return "danger";
  const failed = overview?.run_status_counts.failed ?? 0;
  const blocked = overview?.blocked_requirements?.length ?? 0;
  const critical = issues.some((i) => i.severity === "critical");
  const high = issues.some((i) => i.severity === "high");
  if (critical || failed > 0 || (quality.currentRate !== null && quality.currentRate < 0.5)) {
    return "danger";
  }
  if (high || blocked > 0 || quality.delta <= -0.1 || (quality.currentRate !== null && quality.currentRate < 0.8)) {
    return "warn";
  }
  if ((overview?.running_now.length ?? 0) > 0 || (overview?.run_status_counts.completed ?? 0) > 0) {
    return "ok";
  }
  return "neutral";
}

function healthLabel(tone: Tone): string {
  if (tone === "danger") return t("healthCenterStateDanger");
  if (tone === "warn") return t("healthCenterStateWarn");
  if (tone === "ok") return t("healthCenterStateOk");
  return t("healthCenterStateNeutral");
}

function healthSummary(
  tone: Tone,
  overview: WorkOverview | null,
  quality: QualitySignal,
  issues: Issue[],
  unavailable: boolean,
): string {
  if (unavailable) return t("healthCenterSummaryUnavailable");
  const failed = overview?.run_status_counts.failed ?? 0;
  const blocked = overview?.blocked_requirements?.length ?? 0;
  const running = overview?.running_now.length ?? 0;
  const openIssues = issues.length;
  if (tone === "danger") {
    return t(
      "healthCenterSummaryDanger",
      failed,
      blocked,
      openIssues,
      formatPercent(quality.currentRate),
    );
  }
  if (tone === "warn") {
    return t(
      "healthCenterSummaryWarn",
      blocked,
      openIssues,
      formatPercent(quality.currentRate),
    );
  }
  if (running > 0) return t("healthCenterSummaryRunning", running);
  return t("healthCenterSummaryOk", formatPercent(quality.currentRate));
}

function topIssue(issues: Issue[]): Issue | null {
  return issues[0] ?? null;
}

export function HealthCenter({
  overview,
  quality,
  overviewUnavailable,
  qualityUnavailable,
  loading,
  error,
  onRefresh,
}: Props) {
  const [orphans, setOrphans] = useState<OrphanWorktree[]>([]);
  const [stuck, setStuck] = useState<StuckRun[]>([]);
  const [autoMode, setAutoMode] = useState<AutoModeStatus | null>(null);
  const [autoPending, setAutoPending] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const navigate = useNavigate();

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([listOrphanWorktrees(), listStuckRuns()]);
      setOrphans(o ?? []);
      setStuck(s ?? []);
    } catch {
      setOrphans([]);
      setStuck([]);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getAutoModeStatus().then((status) => {
        if (!cancelled) setAutoMode(status);
      });
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const issues = useMemo(
    () =>
      aggregateIssues({
        failures: overview?.recent_failures ?? [],
        orphans,
        stuck,
      }),
    [overview, orphans, stuck],
  );
  const qualityStats = useMemo(() => qualitySignal(quality), [quality]);
  const unavailable = overviewUnavailable || qualityUnavailable;
  const tone = healthTone(overview, qualityStats, issues, unavailable);
  const issue = topIssue(issues);

  const openConversation = (id: string) => {
    void resumeConversation(id);
    void navigate("/");
  };

  const toggleAutoMode = async () => {
    if (!autoMode?.configured || autoPending) return;
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

  const signals: HealthSignal[] = [];
  const failures = overview?.recent_failures ?? [];
  const blocked = overview?.blocked_requirements ?? [];
  const running = overview?.running_now ?? [];

  if (issue) {
    const affected = issue.affected.find((a) => a.conversation_id);
    signals.push({
      tone: issue.severity === "warning" ? "warn" : "danger",
      label: t("healthCenterSignalException"),
      value: `× ${issue.count}`,
      detail: issue.title,
      action: affected?.conversation_id
        ? {
            label: t("workOpenConversation"),
            onClick: () => openConversation(affected.conversation_id!),
          }
        : undefined,
    });
  }
  if (failures.length > 0) {
    const latest = failures
      .slice()
      .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""))[0];
    signals.push({
      tone: "danger",
      label: t("workSectionFailures"),
      value: String(failures.length),
      detail: latest?.error || latest?.requirement_title || t("healthCenterRecentRunFailed"),
      action: latest?.conversation_id
        ? {
            label: t("workOpenConversation"),
            onClick: () => openConversation(latest.conversation_id),
          }
        : undefined,
    });
  }
  if (blocked && blocked.length > 0) {
    const first = blocked[0];
    signals.push({
      tone: "warn",
      label: t("workSectionBlocked"),
      value: String(blocked.length),
      detail: first.reason || first.title,
    });
  }
  if (qualityStats.currentRate !== null) {
    const isDrop = qualityStats.delta <= -0.1;
    signals.push({
      tone:
        qualityStats.currentRate < 0.5 ? "danger" : isDrop || qualityStats.currentRate < 0.8 ? "warn" : "ok",
      label: t("panelQuality"),
      value: formatPercent(qualityStats.currentRate),
      detail:
        qualityStats.topCommand && qualityStats.topCommandFails > 0
          ? t(
              "healthCenterQualityTopCommand",
              qualityStats.topCommandFails,
              qualityStats.topCommand,
            )
          : t("healthCenterQualityTrend", Math.round(qualityStats.delta * 100)),
    });
  }
  if (running.length > 0) {
    signals.push({
      tone: "ok",
      label: t("workSectionRunning"),
      value: String(running.length),
      detail: t("healthCenterRunningDetail", running[0]?.requirement_title ?? ""),
      action: running[0]?.conversation_id
        ? {
            label: t("workOpenConversation"),
            onClick: () => openConversation(running[0].conversation_id),
          }
        : undefined,
    });
  }
  if (signals.length === 0) {
    signals.push({
      tone: "ok",
      label: t("healthCenterSignalAllClear"),
      value: formatPercent(qualityStats.currentRate),
      detail: t("healthCenterAllClearDetail"),
    });
  }

  return (
    <section className={"health-center health-center-" + tone} aria-label={t("healthCenterTitle")}>
      <header className="health-center-head">
        <div className="health-center-title-block">
          <span className={"health-center-state tone-" + tone}>
            <span className="health-center-state-dot" aria-hidden="true" />
            {healthLabel(tone)}
          </span>
          <h3>{t("healthCenterTitle")}</h3>
          <p>{healthSummary(tone, overview, qualityStats, issues, unavailable)}</p>
          {(error || autoError) && (
            <p className="health-center-error">
              {error
                ? t("workOverviewError", error)
                : t("autoModeFailed") + ": " + autoError}
            </p>
          )}
        </div>
        <div className="health-center-actions">
          <AutoModeControl
            status={autoMode}
            pending={autoPending}
            onToggle={toggleAutoMode}
          />
          <button
            type="button"
            className="health-center-refresh"
            onClick={() => {
              onRefresh();
              void refreshDiagnostics();
            }}
            disabled={loading}
            title={t("statusManualRefresh")}
          >
            {loading ? t("diagnosticsLoading") : t("statusRefresh")}
          </button>
        </div>
      </header>

      <div className="health-center-metrics" aria-label={t("healthCenterMetrics")}>
        <Metric label={t("workSectionFailures")} value={overview ? String(failures.length) : "—"} tone={failures.length > 0 ? "danger" : "ok"} />
        <Metric label={t("panelQuality")} value={formatPercent(qualityStats.currentRate)} tone={qualityStats.currentRate !== null && qualityStats.currentRate < 0.8 ? "warn" : "ok"} />
        <Metric label={t("exceptionsTitle")} value={String(issues.length)} tone={issues.length > 0 ? "danger" : "ok"} />
        <Metric label={t("workSectionRunning")} value={overview ? String(running.length) : "—"} tone={running.length > 0 ? "ok" : "neutral"} />
      </div>

      <div className="health-center-body">
        <div className="health-center-signals">
          <div className="health-center-section-label">{t("healthCenterNextActions")}</div>
          <ul className="health-signal-list">
            {signals.slice(0, 5).map((signal) => (
              <li key={signal.label + signal.value + signal.detail} className={"health-signal tone-" + signal.tone}>
                <span className="health-signal-label">{signal.label}</span>
                <span className="health-signal-value tabular-nums">{signal.value}</span>
                <span className="health-signal-detail" title={signal.detail}>
                  {signal.detail}
                </span>
                {signal.action && (
                  <button type="button" onClick={signal.action.onClick}>
                    {signal.action.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="health-center-context">
          <div className="health-center-section-label">{t("healthCenterContext")}</div>
          <dl>
            <div>
              <dt>{t("healthCenterLastUpdated")}</dt>
              <dd>{overview?.as_of ? formatRelative(overview.as_of) : t("statusNeverUpdated")}</dd>
            </div>
            <div>
              <dt>{t("healthCenterQualityDelta")}</dt>
              <dd className="tabular-nums">
                {qualityStats.currentRate === null
                  ? "—"
                  : `${qualityStats.delta > 0 ? "+" : ""}${Math.round(qualityStats.delta * 100)}%`}
              </dd>
            </div>
            <div>
              <dt>{t("exceptionsFilterHigh")}</dt>
              <dd className="tabular-nums">
                {issues.filter((i) => i.severity === "critical" || i.severity === "high").length}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function AutoModeControl({
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
      <span className="health-auto-toggle is-loading">
        <span className="health-auto-label">{t("statusPillLabelAuto")}</span>
        <span className="health-auto-value">…</span>
      </span>
    );
  }
  if (!status.configured) {
    return (
      <span className="health-auto-toggle is-unconfigured" title={t("statusAutoOffHint")}>
        <span className="health-auto-label">{t("statusPillLabelAuto")}</span>
        <span className="health-auto-value">{t("statusAutoUnconfigured")}</span>
      </span>
    );
  }
  const enabled = status.enabled;
  return (
    <button
      type="button"
      className={
        "health-auto-toggle " +
        (enabled ? "is-on" : "is-off") +
        (pending ? " is-pending" : "")
      }
      onClick={onToggle}
      disabled={pending}
      aria-pressed={enabled}
      title={enabled ? t("statusAutoToggleHintOff") : t("statusAutoToggleHintOn")}
    >
      <span className="health-auto-label">{t("statusPillLabelAuto")}</span>
      <span className="health-auto-switch" aria-hidden="true">
        <span className="health-auto-knob" />
      </span>
      <span className="health-auto-value">
        {enabled ? t("statusAutoOn") : t("statusAutoOff")}
      </span>
    </button>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: Tone;
}) {
  return (
    <div className={"health-metric tone-" + tone}>
      <span>{label}</span>
      <strong className="tabular-nums">{value}</strong>
    </div>
  );
}
