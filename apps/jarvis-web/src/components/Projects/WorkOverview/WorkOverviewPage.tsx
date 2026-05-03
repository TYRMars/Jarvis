import { useState } from "react";
import { t } from "../../../utils/i18n";
import type { WindowDays } from "../../../services/workOverview";
import { useWorkOverview } from "./useWorkOverview";
import { KpiStrip } from "./KpiStrip";
import { OperationalPanel } from "./OperationalPanel";
import { ThroughputChart } from "./ThroughputChart";
import { QualityPanel } from "./QualityPanel";
import { ProjectLeaderboard } from "./ProjectLeaderboard";

const WINDOW_OPTIONS: WindowDays[] = [7, 30, 90];

// Top-level dashboard shown on `/projects` when no project is
// selected. Owns the time-window state + the data hook; child panels
// just render slices of the response.
export function WorkOverviewPage() {
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const state = useWorkOverview(windowDays);

  return (
    <section className="work-overview" aria-label={t("workOverviewTitle")}>
      <div className="work-overview-header">
        <div className="work-overview-title">
          <h2>{t("workOverviewTitle")}</h2>
          <p className="work-overview-subtitle">
            {t("workOverviewSubtitle")}
          </p>
        </div>
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

      {state.error && (
        <div className="work-overview-banner work-overview-banner-error">
          {t("workOverviewError", state.error)}
        </div>
      )}
      {state.overviewUnavailable && (
        <div className="work-overview-banner">
          {t("workOverviewUnavailable")}
        </div>
      )}
      {state.overview?.truncated && (
        <div className="work-overview-banner">
          {t("workOverviewTruncated")}
        </div>
      )}

      <KpiStrip
        overview={state.overview}
        loading={state.loading && !state.overview}
      />

      <div className="work-overview-grid">
        <OperationalPanel overview={state.overview} />
        <ThroughputChart overview={state.overview} />
        <QualityPanel
          quality={state.quality}
          unavailable={state.qualityUnavailable}
        />
        <ProjectLeaderboard overview={state.overview} />
      </div>

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
