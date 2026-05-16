import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { useAppStore } from "../../../store/appStore";
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
import {
  fetchHarnessDirection,
  type HarnessDirectionSnapshot,
  type WorkOverview,
  type WorkQuality,
} from "../../../services/workOverview";
import { KpiStrip } from "./KpiStrip";
import { AgentRuntimeStrip } from "./AgentRuntimeStrip";

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
  samples: number;
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

interface OptimizationMetric {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  hint: string[];
}

export interface HealthCenterState {
  // Inputs (passthrough for child sections that still need them)
  overview: WorkOverview | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  refreshDiagnostics: () => Promise<void>;
  // Tone + labels
  tone: Tone;
  toneLabel: string;
  summary: string;
  unavailable: boolean;
  // Derived stats
  qualityStats: QualitySignal;
  optimizationScore: number;
  optimizationMetrics: OptimizationMetric[];
  direction: HarnessDirectionSnapshot | null;
  signals: HealthSignal[];
  // Auto-mode runtime
  autoMode: AutoModeStatus | null;
  autoPending: boolean;
  autoError: string | null;
  toggleAutoMode: () => Promise<void>;
  // Navigation helper for action buttons
  navigate: NavigateFunction;
}

function formatPercent(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
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
    samples: buckets.reduce((sum, b) => sum + b.total, 0),
    topCommand: top?.command_normalized ?? null,
    topCommandFails: top?.fail_count ?? 0,
  };
}

function FormulaHint({ label, lines }: { label: string; lines: string[] }) {
  return (
    <span className="harness-formula-hint">
      <button
        type="button"
        aria-label={label}
        title={label}
        className="harness-formula-icon"
      >
        i
      </button>
      <span className="harness-formula-tooltip" role="tooltip">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </span>
  );
}

function LabelWithHint({ label, lines }: { label: string; lines?: string[] }) {
  if (!lines || lines.length === 0) return <span>{label}</span>;
  return (
    <span className="harness-metric-label-with-hint">
      {label}
      <FormulaHint label={t("harnessMetricFormulaLabel")} lines={lines} />
    </span>
  );
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

// Owns all data fetches + derivations for the health center. Called
// once in `WorkOverviewPage`; the returned state is fanned out to
// both `HealthCenterCompact` (top of page) and `HealthCenterDetails`
// (the "Quality" tab) so we don't double-poll the auto-mode endpoint
// or re-derive the optimization grid twice per render.
export function useHealthCenterState(props: Props): HealthCenterState {
  const {
    overview,
    quality,
    overviewUnavailable,
    qualityUnavailable,
    loading,
    error,
    onRefresh,
  } = props;
  const [orphans, setOrphans] = useState<OrphanWorktree[]>([]);
  const [stuck, setStuck] = useState<StuckRun[]>([]);
  const [autoMode, setAutoMode] = useState<AutoModeStatus | null>(null);
  const [direction, setDirection] = useState<HarnessDirectionSnapshot | null>(null);
  const [autoPending, setAutoPending] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);

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
    // Re-poll the runtime status so the AgentRuntimeStrip's
    // heartbeat tile reflects new ticks. 5s sits at the lower end of
    // typical tick cadences (default 30s, dev override 5–10s) so the
    // displayed last-tick stays under 1.5× the tick interval and
    // doesn't visually drift toward the "stale" tone between polls.
    // The endpoint hits a single in-memory atomic on the server, so
    // the cost is trivial.
    const pollId = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.clearInterval(pollId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchHarnessDirection()
      .then((snapshot) => {
        if (!cancelled) setDirection(snapshot);
      })
      .catch(() => {
        if (!cancelled) setDirection(null);
      });
    return () => {
      cancelled = true;
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
  const activeProjects = projects.filter((p) => !p.archived);
  const autoEnabled = activeProjects.filter(
    (p) => p.automation?.auto_mode_enabled ?? true,
  ).length;
  const automationCoverage =
    activeProjects.length > 0 ? autoEnabled / activeProjects.length : null;
  const failuresCount = overview?.run_status_counts.failed ?? 0;
  const completedCount = overview?.run_status_counts.completed ?? 0;
  const runningCount = overview?.running_now.length ?? 0;
  const blockedCount = overview?.blocked_requirements?.length ?? 0;
  const missingStores = overview?.missing_stores.length ?? 0;
  const throughput =
    overview?.throughput_by_day.reduce((sum, d) => sum + d.runs_started, 0) ?? 0;
  const optimizationScore = useMemo(() => {
    let score = 100;
    score -= Math.min(35, failuresCount * 8);
    score -= Math.min(18, blockedCount * 6);
    if (qualityStats.currentRate !== null) {
      score -= Math.max(0, 0.9 - qualityStats.currentRate) * 38;
    }
    if (qualityStats.delta < 0) {
      score -= Math.min(15, Math.abs(qualityStats.delta) * 60);
    }
    if (automationCoverage !== null) {
      score -= Math.max(0, 0.85 - automationCoverage) * 18;
    }
    score -= Math.min(12, missingStores * 6);
    if (overviewUnavailable || qualityUnavailable) score -= 18;
    return clampScore(score);
  }, [
    automationCoverage,
    blockedCount,
    failuresCount,
    missingStores,
    overviewUnavailable,
    qualityStats.currentRate,
    qualityStats.delta,
    qualityUnavailable,
  ]);
  const optimizationMetrics: OptimizationMetric[] = [
    {
      label: t("harnessMetricScore"),
      value: String(optimizationScore),
      detail: t("harnessMetricScoreDetail"),
      tone: optimizationScore >= 80 ? "ok" : optimizationScore >= 60 ? "warn" : "danger",
      hint: [t("harnessMetricScoreHintFormula"), t("harnessMetricScoreHintPenalty")],
    },
    {
      label: t("harnessMetricReliabilityDebt"),
      value: String(failuresCount + blockedCount),
      detail: t("harnessMetricReliabilityDebtDetail", failuresCount, blockedCount),
      tone: failuresCount > 0 ? "danger" : blockedCount > 0 ? "warn" : "ok",
      hint: [t("harnessMetricReliabilityDebtHint")],
    },
    {
      label: t("harnessMetricVerification"),
      value: formatPercent(qualityStats.currentRate),
      detail: t(
        "harnessMetricVerificationDetail",
        qualityStats.samples,
        `${qualityStats.delta > 0 ? "+" : ""}${Math.round(qualityStats.delta * 100)}%`,
      ),
      tone:
        qualityStats.currentRate === null
          ? "neutral"
          : qualityStats.currentRate >= 0.85
            ? "ok"
            : qualityStats.currentRate >= 0.65
              ? "warn"
              : "danger",
      hint: [t("harnessMetricVerificationHint")],
    },
    {
      label: t("harnessMetricAutomationCoverage"),
      value: formatPercent(automationCoverage),
      detail: t("harnessMetricAutomationCoverageDetail", autoEnabled, activeProjects.length),
      tone:
        automationCoverage === null
          ? "neutral"
          : automationCoverage >= 0.85
            ? "ok"
            : automationCoverage >= 0.55
              ? "warn"
              : "danger",
      hint: [t("harnessMetricAutomationCoverageHint")],
    },
    {
      label: t("harnessMetricObservability"),
      value: missingStores === 0 ? t("harnessMetricReady") : String(missingStores),
      detail:
        missingStores === 0
          ? t("harnessMetricObservabilityReady")
          : t("harnessMetricObservabilityMissing", missingStores),
      tone: missingStores === 0 ? "ok" : "warn",
      hint: [t("harnessMetricObservabilityHint")],
    },
    {
      label: t("harnessMetricThroughput"),
      value: String(throughput),
      detail: t("harnessMetricThroughputDetail", completedCount, runningCount),
      tone: throughput > 0 ? "ok" : "neutral",
      hint: [t("harnessMetricThroughputHint")],
    },
  ];

  const openConversation = useCallback((id: string) => {
    void resumeConversation(id);
  }, []);

  const toggleAutoMode = useCallback(async () => {
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
  }, [autoMode, autoPending]);

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

  return {
    overview,
    loading,
    error,
    onRefresh,
    refreshDiagnostics,
    tone,
    toneLabel: healthLabel(tone),
    summary: healthSummary(tone, overview, qualityStats, issues, unavailable),
    unavailable,
    qualityStats,
    optimizationScore,
    optimizationMetrics,
    direction,
    signals,
    autoMode,
    autoPending,
    autoError,
    toggleAutoMode,
    navigate,
  };
}

interface CompactProps {
  state: HealthCenterState;
  /// Triggered when the user clicks "view all" under a truncated
  /// signals list. The page wires this to switch into the Quality tab
  /// where the full list lives.
  onExpandSignals?: () => void;
}

// Top-of-page strip: status pill + summary + KpiStrip +
// AgentRuntimeStrip + top-3 Next Actions. Always visible.
export function HealthCenterCompact({ state, onExpandSignals }: CompactProps) {
  const {
    tone,
    toneLabel,
    summary,
    error,
    autoError,
    loading,
    onRefresh,
    refreshDiagnostics,
    autoMode,
    autoPending,
    toggleAutoMode,
    overview,
    navigate,
    signals,
  } = state;
  const visibleSignals = signals.slice(0, 3);
  const hasMore = signals.length > visibleSignals.length;

  return (
    <section
      className={"health-center health-center-compact health-center-" + tone}
      aria-label={t("healthCenterTitle")}
    >
      <header className="health-center-head">
        <div className="health-center-title-block">
          <span className={"health-center-state tone-" + tone}>
            <span className="health-center-state-dot" aria-hidden="true" />
            {toneLabel}
          </span>
          <h3>{t("healthCenterTitle")}</h3>
          <p>{summary}</p>
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
            onToggle={() => void toggleAutoMode()}
          />
          <button
            type="button"
            className="health-center-refresh"
            onClick={() => void navigate("/projects/auto-mode")}
            title={t("healthCenterAutoModeDashboard")}
          >
            {t("healthCenterAutoModeDashboard")}
          </button>
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

      <KpiStrip overview={overview} loading={loading && !overview} />

      <AgentRuntimeStrip status={autoMode} />

      <div className="health-center-body">
        <div className="health-center-signals">
          <div className="health-center-section-label">
            {t("healthCenterNextActions")}
            {hasMore && onExpandSignals && (
              <button
                type="button"
                className="health-center-section-link"
                onClick={onExpandSignals}
                title={t("healthCenterSignalsViewAllHint")}
              >
                {t("healthCenterSignalsViewAll", signals.length)}
              </button>
            )}
          </div>
          <ul className="health-signal-list">
            {visibleSignals.map((signal) => (
              <li
                key={signal.label + signal.value + signal.detail}
                className={"health-signal tone-" + signal.tone}
              >
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
      </div>
    </section>
  );
}

interface DetailsProps {
  state: HealthCenterState;
}

// Quality-tab body: optimization grid + Direction components + the
// full (untruncated) Next Actions list. Reuses the same derived
// state — no extra fetches.
export function HealthCenterDetails({ state }: DetailsProps) {
  const { tone, optimizationMetrics, direction, signals } = state;
  return (
    <section
      className={"health-center health-center-details health-center-" + tone}
      aria-label={t("harnessEvolutionTitle")}
    >
      <div className="health-optimization">
        <div className="health-center-section-label">
          <span className="harness-metric-label-with-hint">
            {t("harnessEvolutionTitle")}
            <FormulaHint
              label={t("harnessMetricFormulaLabel")}
              lines={[
                t("harnessEvolutionHintMeaning"),
                t("harnessEvolutionHintFormula"),
                t("harnessEvolutionHintInterpretation"),
              ]}
            />
          </span>
        </div>
        <div className="harness-evolution-grid">
          {optimizationMetrics.map((metric) => (
            <div key={metric.label} className={"harness-evolution-metric tone-" + metric.tone}>
              <LabelWithHint label={metric.label} lines={metric.hint} />
              <strong className="tabular-nums">{metric.value}</strong>
              <p>{metric.detail}</p>
            </div>
          ))}
        </div>
        {direction && (
          <div className="health-direction">
            <div className="health-center-section-label">
              <span className="harness-metric-label-with-hint">
                {t("harnessDirectionComponentsTitle")}
                <FormulaHint
                  label={t("harnessMetricFormulaLabel")}
                  lines={[
                    t("harnessObsMetricDirectionHintFormula"),
                    t("harnessDirectionComponentsHint"),
                  ]}
                />
              </span>
            </div>
            <div className="harness-direction-components">
              {direction.components.map((component) => (
                <div className="harness-direction-component" key={component.key}>
                  <div className="harness-direction-component-head">
                    <span>{t(`harnessObsComponent_${component.key}`)}</span>
                    <strong className="tabular-nums">{component.score}</strong>
                  </div>
                  <div className="harness-direction-bar" aria-hidden="true">
                    <span style={{ width: `${component.score}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="health-center-body">
        <div className="health-center-signals">
          <div className="health-center-section-label">{t("healthCenterNextActions")}</div>
          <ul className="health-signal-list">
            {signals.map((signal) => (
              <li
                key={signal.label + signal.value + signal.detail}
                className={"health-signal tone-" + signal.tone}
              >
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
      </div>
    </section>
  );
}

// Back-compat composite — renders compact + details inline. Not used
// by the redesigned overview page; kept so any other call sites
// (tests, embedded views) keep working without code changes.
export function HealthCenter(props: Props) {
  const state = useHealthCenterState(props);
  return (
    <>
      <HealthCenterCompact state={state} />
      <HealthCenterDetails state={state} />
    </>
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
