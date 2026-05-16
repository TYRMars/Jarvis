import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppStore } from "../../../store/appStore";
import { t } from "../../../utils/i18n";
import { newConversation } from "../../../services/conversations";
import type { WorkOverview, WindowDays } from "../../../services/workOverview";
import { getAutoModeStatus, type AutoModeStatus } from "../../../services/autoMode";
import { Tabs, type TabItem } from "../../ui/Tabs";
import { useWorkOverview } from "./useWorkOverview";
import {
  HealthCenterCompact,
  HealthCenterDetails,
  useHealthCenterState,
} from "./HealthCenter";
import { ThroughputChart } from "./ThroughputChart";
import { ProjectLeaderboard } from "./ProjectLeaderboard";
import { UsagePanel } from "./UsagePanel";
import { ModelComparisonPanel } from "./ModelComparisonPanel";
import { HarnessObservabilityPanel } from "./HarnessObservabilityPanel";
import { SubAgentRunsRail } from "./SubAgentRunsRail";

const WINDOW_OPTIONS: WindowDays[] = [7, 30, 90];

type OverviewTab =
  | "overview"
  | "quality"
  | "usage"
  | "activity"
  | "observability";

const TAB_IDS: OverviewTab[] = [
  "overview",
  "quality",
  "usage",
  "activity",
  "observability",
];

function readTabFromHash(): OverviewTab {
  if (typeof window === "undefined") return "overview";
  const raw = window.location.hash.replace(/^#/, "");
  return (TAB_IDS as string[]).includes(raw) ? (raw as OverviewTab) : "overview";
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined
    ? t("workOverviewDiagnoseNoData")
    : `${Math.round(value * 100)}%`;
}

function concise(value: string | null | undefined, fallback: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  return v.length > 140 ? `${v.slice(0, 140)}...` : v;
}

function describeHeartbeat(status: AutoModeStatus | null): string {
  if (!status || !status.configured) return t("workOverviewDiagnoseNoData");
  if (!status.last_tick_at) return t("runtimeHeartbeatNever");
  const ageMs = Date.now() - Date.parse(status.last_tick_at);
  if (Number.isNaN(ageMs) || ageMs < 0) return t("runtimeRelJustNow");
  if (ageMs < 5_000) return t("runtimeRelJustNow");
  if (ageMs < 60_000) return t("runtimeRelSeconds", Math.floor(ageMs / 1000));
  if (ageMs < 3_600_000) return t("runtimeRelMinutes", Math.floor(ageMs / 60_000));
  return t("runtimeRelHours", Math.floor(ageMs / 3_600_000));
}

function describeInFlight(status: AutoModeStatus | null): string {
  if (
    !status ||
    !status.configured ||
    status.max_concurrent_units == null ||
    status.available_permits == null
  ) {
    return t("workOverviewDiagnoseNoData");
  }
  const cap = status.max_concurrent_units;
  const used = Math.max(0, cap - status.available_permits);
  return `${used}/${cap}`;
}

function buildDiagnosisPrompt(
  overview: WorkOverview | null,
  windowDays: WindowDays,
  autoMode: AutoModeStatus | null,
): string {
  const failures = overview?.recent_failures ?? [];
  const blocked = overview?.blocked_requirements ?? [];
  const failureLines = failures.slice(0, 5).map((row, idx) =>
    `${idx + 1}. ${row.project_name ?? t("workOverviewDiagnoseUnknownProject")} / ${row.requirement_title ?? row.id}: ${concise(row.error, t("workOverviewDiagnoseNoError"))}`,
  );
  const blockedLines = blocked.slice(0, 5).map((row, idx) =>
    `${idx + 1}. ${row.project_name ?? t("workOverviewDiagnoseUnknownProject")} / ${row.title}: ${concise(row.reason, t("workOverviewDiagnoseNoBlockedReason"))}`,
  );
  return t(
    "workOverviewDiagnosePrompt",
    windowDays,
    overview?.run_status_counts.failed ?? 0,
    blocked.length,
    overview?.running_now.length ?? 0,
    pct(overview?.verification_pass_rate),
    overview?.missing_stores.length ? overview.missing_stores.join(", ") : t("workOverviewDiagnoseNoMissingStores"),
    failureLines.length ? failureLines.join("\n") : t("workOverviewDiagnoseNoFailures"),
    blockedLines.length ? blockedLines.join("\n") : t("workOverviewDiagnoseNoBlocked"),
    describeHeartbeat(autoMode),
    describeInFlight(autoMode),
  );
}

function projectIdsWithRunIssues(overview: WorkOverview | null): string[] {
  if (!overview) return [];
  const ids = new Set<string>();
  for (const row of overview.recent_failures) {
    if (row.project_id) ids.add(row.project_id);
  }
  for (const row of overview.blocked_requirements ?? []) {
    if (row.project_id) ids.add(row.project_id);
  }
  for (const row of overview.running_now) {
    if (row.project_id) ids.add(row.project_id);
  }
  return [...ids];
}

// Top-level dashboard shown on `/projects/overview`. Owns the
// time-window state + the data hook; child panels just render slices
// of the response. Layout is two-tier:
//
//   1. Always-visible header: title row, ProjectLeaderboard,
//      HealthCenterCompact (status + KPI strip + runtime + top-3
//      next actions).
//   2. Tab body: Overview / Quality / Usage / Activity / Observability —
//      synced to URL hash so deep-links + back button work.
export function WorkOverviewPage() {
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const state = useWorkOverview(windowDays);
  const navigate = useNavigate();
  const projectsById = useAppStore((s) => s.projectsById);
  const setComposerValue = useAppStore((s) => s.setComposerValue);
  const [activeTab, setActiveTab] = useState<OverviewTab>(() => readTabFromHash());
  const healthState = useHealthCenterState({
    overview: state.overview,
    quality: state.quality,
    overviewUnavailable: state.overviewUnavailable,
    qualityUnavailable: state.qualityUnavailable,
    loading: state.loading,
    error: state.error,
    onRefresh: state.refetch,
  });

  // Keep URL hash in sync with the active tab without polluting
  // history. Use replaceState so back-button still steps out of the
  // page rather than cycling through tabs.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = window.location.hash.replace(/^#/, "");
    if (current === activeTab) return;
    history.replaceState(null, "", "#" + activeTab);
  }, [activeTab]);

  // Pick up hash changes that came from elsewhere (manual edit,
  // back/forward navigation across other state changes).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      setActiveTab(readTabFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const startDiagnosis = async () => {
    const issueProjectIds = projectIdsWithRunIssues(state.overview);
    const projectId = issueProjectIds.length === 1 ? issueProjectIds[0] : null;
    const workspacePath = projectId
      ? projectsById[projectId]?.workspaces?.[0]?.path ?? null
      : null;
    // Fetch a fresh runtime snapshot so the diagnose prompt sees the
    // current scheduler state, not whatever was cached at page load.
    // Falls back to null on error — the prompt still renders, just
    // with "no data" for the runtime lines.
    const autoModeSnapshot = await getAutoModeStatus().catch(() => null);
    void navigate("/");
    newConversation({ projectId, workspacePath });
    setComposerValue(
      buildDiagnosisPrompt(state.overview, windowDays, autoModeSnapshot),
    );
    const submitWhenReady = (attempt = 0) => {
      const form = document.getElementById("input-form") as HTMLFormElement | null;
      if (form?.requestSubmit) {
        form.requestSubmit();
      } else if (attempt < 8) {
        window.setTimeout(() => submitWhenReady(attempt + 1), 50);
      } else {
        document.getElementById("input")?.focus();
      }
    };
    window.setTimeout(() => submitWhenReady(), 50);
  };

  // Keyboard shortcut: bare `R` triggers manual refresh (matches the
  // banner's button affordance). Skipped while focus is in any
  // editable element so search inputs / textareas stay usable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;
      e.preventDefault();
      state.refetch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.refetch]);

  const tabItems: TabItem[] = useMemo(
    () => [
      {
        id: "overview",
        label: t("workOverviewTabOverview"),
        content: <ThroughputChart overview={state.overview} />,
      },
      {
        id: "quality",
        label: t("workOverviewTabQuality"),
        content: <HealthCenterDetails state={healthState} />,
      },
      {
        id: "usage",
        label: t("workOverviewTabUsage"),
        content: (
          <div className="work-insights-grid work-overview-tab-usage-grid">
            <div className="work-insights-cell work-insights-cell-usage">
              <UsagePanel windowDays={windowDays} />
            </div>
            <div className="work-insights-cell work-insights-cell-models">
              <ModelComparisonPanel windowDays={windowDays} />
            </div>
          </div>
        ),
      },
      {
        id: "activity",
        label: t("workOverviewTabActivity"),
        content: <SubAgentRunsRail />,
      },
      {
        id: "observability",
        label: t("workOverviewTabObservability"),
        content: <HarnessObservabilityPanel windowDays={windowDays} />,
      },
    ],
    [healthState, state.overview, windowDays],
  );

  return (
    <section className="work-overview" aria-label={t("workOverviewTitle")}>
      <div className="work-overview-header">
        <div className="work-overview-title">
          <h2>{t("workOverviewTitle")}</h2>
          <p className="work-overview-subtitle">
            {t("workOverviewSubtitle")}
          </p>
        </div>
        <div className="work-overview-header-actions">
          <Link className="work-overview-projects-link" to="/projects/list">
            {t("workOverviewProjectsLink")}
          </Link>
          <button
            type="button"
            className="work-overview-projects-link work-overview-diagnose-btn"
            onClick={() => void startDiagnosis()}
            title={t("workOverviewDiagnoseHint")}
          >
            {t("workOverviewDiagnoseButton")}
          </button>
          <div
            className="work-overview-window"
            role="tablist"
            aria-label={t("workOverviewWindow")}
          >
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt}
                type="button"
                role="tab"
                aria-selected={windowDays === opt}
                className={
                  "work-overview-window-tab" +
                  (windowDays === opt ? " active" : "")
                }
                onClick={() => setWindowDays(opt)}
              >
                {t(`workOverviewWindow${opt}d` as const)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {state.overview?.truncated && (
        <div className="work-overview-banner">
          {t("workOverviewTruncated")}
        </div>
      )}

      <div className="work-overview-projects-top">
        <ProjectLeaderboard overview={state.overview} />
      </div>

      <HealthCenterCompact
        state={healthState}
        onExpandSignals={() => setActiveTab("quality")}
      />

      <Tabs
        ariaLabel={t("workOverviewTabsLabel")}
        className="work-overview-tabs"
        value={activeTab}
        onChange={(id) => setActiveTab(id as OverviewTab)}
        items={tabItems}
      />

      {/* Footer kept for absolute timestamp (the banner already shows
          relative time, but exact wall-clock is useful for ops
          forensics). */}
      <footer className="work-overview-footer">
        {state.overview && (
          <span>
            {t("workOverviewAsOf", new Date(state.overview.as_of).toLocaleString())}
          </span>
        )}
      </footer>
    </section>
  );
}
