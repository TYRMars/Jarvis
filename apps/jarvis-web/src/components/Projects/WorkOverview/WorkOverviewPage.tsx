import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppStore } from "../../../store/appStore";
import { t } from "../../../utils/i18n";
import { newConversation } from "../../../services/conversations";
import type { WorkOverview, WindowDays } from "../../../services/workOverview";
import { useWorkOverview } from "./useWorkOverview";
import { HealthCenter } from "./HealthCenter";
import { ThroughputChart } from "./ThroughputChart";
import { ProjectLeaderboard } from "./ProjectLeaderboard";
import { UsagePanel } from "./UsagePanel";
import { ModelComparisonPanel } from "./ModelComparisonPanel";
import { HarnessObservabilityPanel } from "./HarnessObservabilityPanel";
import { SubAgentRunsRail } from "./SubAgentRunsRail";

const WINDOW_OPTIONS: WindowDays[] = [7, 30, 90];

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

function buildDiagnosisPrompt(overview: WorkOverview | null, windowDays: WindowDays): string {
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
// of the response.
export function WorkOverviewPage() {
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const state = useWorkOverview(windowDays);
  const navigate = useNavigate();
  const projectsById = useAppStore((s) => s.projectsById);
  const setComposerValue = useAppStore((s) => s.setComposerValue);

  const startDiagnosis = () => {
    const issueProjectIds = projectIdsWithRunIssues(state.overview);
    const projectId = issueProjectIds.length === 1 ? issueProjectIds[0] : null;
    const workspacePath = projectId
      ? projectsById[projectId]?.workspaces?.[0]?.path ?? null
      : null;
    void navigate("/");
    newConversation({ projectId, workspacePath });
    setComposerValue(buildDiagnosisPrompt(state.overview, windowDays));
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
            onClick={startDiagnosis}
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

      <div id="work-overview-operational" className="work-overview-anchor">
        <HealthCenter
          overview={state.overview}
          quality={state.quality}
          overviewUnavailable={state.overviewUnavailable}
          qualityUnavailable={state.qualityUnavailable}
          loading={state.loading}
          error={state.error}
          onRefresh={state.refetch}
        />
      </div>

      <section className="work-insights-group" aria-label={t("workInsightsTitle")}>
        <header className="work-insights-head">
          <div>
            <h3>{t("workInsightsTitle")}</h3>
            <p>{t("workInsightsSubtitle")}</p>
          </div>
        </header>
        <div className="work-insights-grid">
          <div
            id="work-overview-throughput"
            className="work-insights-cell work-insights-cell-throughput"
          >
            <ThroughputChart overview={state.overview} />
          </div>
          <div className="work-insights-cell work-insights-cell-usage">
            <UsagePanel windowDays={windowDays} />
          </div>
          <div className="work-insights-cell work-insights-cell-models">
            <ModelComparisonPanel windowDays={windowDays} />
          </div>
        </div>
      </section>

      <SubAgentRunsRail />

      <HarnessObservabilityPanel windowDays={windowDays} />

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
