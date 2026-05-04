import { useEffect, useState } from "react";
import { t } from "../../../utils/i18n";
import type { WindowDays } from "../../../services/workOverview";
import { useWorkOverview } from "./useWorkOverview";
import { KpiStrip } from "./KpiStrip";
import { OperationalPanel } from "./OperationalPanel";
import { ThroughputChart } from "./ThroughputChart";
import { QualityPanel } from "./QualityPanel";
import { ProjectLeaderboard } from "./ProjectLeaderboard";
import { SystemStatusBanner } from "./SystemStatusBanner";
import { UsagePanel } from "./UsagePanel";
import { ExceptionsPanel } from "../../Diagnostics/ExceptionsPanel";

const WINDOW_OPTIONS: WindowDays[] = [7, 30, 90];

// Top-level dashboard shown on `/projects` when no project is
// selected. Owns the time-window state + the data hook; child panels
// just render slices of the response.
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

      {/* Top-of-page status banner. Owns the at-a-glance answers to
          "is the system working / failing / idle", "is auto on", and
          "is the data fresh". Replaces the old spread-out
          banner+footer pattern. */}
      <SystemStatusBanner
        overview={state.overview}
        unavailable={state.overviewUnavailable}
        loading={state.loading}
        error={state.error}
        onRefresh={state.refetch}
      />

      {state.overview?.truncated && (
        <div className="work-overview-banner">
          {t("workOverviewTruncated")}
        </div>
      )}

      <KpiStrip
        overview={state.overview}
        loading={state.loading && !state.overview}
      />

      {/* Anchor IDs match the `scrollTo` props on KPI cards so
          clicking a KPI smooth-scrolls to the relevant panel. The
          ids are on wrapper divs to avoid intruding into the panel
          components' own className contracts. */}
      <div className="work-overview-grid">
        <div id="work-overview-operational" className="work-overview-grid-cell">
          <OperationalPanel overview={state.overview} />
        </div>
        <div id="work-overview-throughput" className="work-overview-grid-cell">
          <ThroughputChart overview={state.overview} />
        </div>
        <div className="work-overview-grid-cell">
          <QualityPanel
            quality={state.quality}
            unavailable={state.qualityUnavailable}
          />
        </div>
        <div className="work-overview-grid-cell">
          <ProjectLeaderboard overview={state.overview} />
        </div>
        {/* Token / cost usage — fed by the WS `usage` frame stream
            via `usageCumulator`; persisted to localStorage so the
            "today / window" totals survive reload without a server
            schema change on RequirementRun. */}
        <div className="work-overview-grid-cell">
          <UsagePanel windowDays={windowDays} />
        </div>
      </div>

      {/* Sentry-style exceptions feed — replaces the old 3-section
          diagnostics body. Errors group by signature (so 12 retries
          of the same root cause read as one card with `× 12`),
          carry a severity badge + last-seen relative time, an
          optional resolution hint, and an `Ignore` button for
          known-noise. Source data: `state.overview.recent_failures`
          plus diagnostics service for orphans + stuck runs. */}
      <div className="work-overview-diagnostics">
        <ExceptionsPanel overview={state.overview} />
      </div>

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
