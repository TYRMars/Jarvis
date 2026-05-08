import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { t } from "../../../utils/i18n";
import type { WindowDays } from "../../../services/workOverview";
import { useWorkOverview } from "./useWorkOverview";
import { KpiStrip } from "./KpiStrip";
import { HealthCenter } from "./HealthCenter";
import { ThroughputChart } from "./ThroughputChart";
import { ProjectLeaderboard } from "./ProjectLeaderboard";
import { UsagePanel } from "./UsagePanel";
import { HarnessEvolutionPanel } from "./HarnessEvolutionPanel";
import { ModelComparisonPanel } from "./ModelComparisonPanel";
import { HarnessObservabilityPanel } from "./HarnessObservabilityPanel";

const WINDOW_OPTIONS: WindowDays[] = [7, 30, 90];

// Top-level dashboard shown on `/projects/overview`. Owns the
// time-window state + the data hook; child panels just render slices
// of the response.
export function WorkOverviewPage() {
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const state = useWorkOverview(windowDays);

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
          <Link className="work-overview-projects-link" to="/projects/auto-mode">
            {t("workOverviewAutoModeLink")}
          </Link>
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

      <KpiStrip
        overview={state.overview}
        loading={state.loading && !state.overview}
      />

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
          <div className="work-insights-cell work-insights-cell-leaderboard">
            <ProjectLeaderboard overview={state.overview} />
          </div>
          <div className="work-insights-cell work-insights-cell-usage">
            <UsagePanel windowDays={windowDays} />
          </div>
          <div className="work-insights-cell work-insights-cell-models">
            <ModelComparisonPanel windowDays={windowDays} />
          </div>
        </div>
      </section>

      <HarnessObservabilityPanel windowDays={windowDays} />

      <HarnessEvolutionPanel
        overview={state.overview}
        quality={state.quality}
        overviewUnavailable={state.overviewUnavailable}
        qualityUnavailable={state.qualityUnavailable}
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
