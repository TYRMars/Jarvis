import { useNavigate } from "react-router-dom";
import { t } from "../../../utils/i18n";
import { chipColor } from "../../../utils/chipColor";
import type { WorkOverview } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
}

// v1.0 — colour the completion-rate bar by tone band, matching the
// KPI/health vocab used across the page (≥80% = ok, ≥50% = neutral,
// otherwise danger). Same thresholds as KpiStrip's pass-rate.
function rateTone(rate: number): "ok" | "neutral" | "danger" {
  if (rate >= 0.8) return "ok";
  if (rate >= 0.5) return "neutral";
  return "danger";
}

function FormulaHint({ lines }: { lines: string[] }) {
  return (
    <span className="harness-formula-hint">
      <button
        type="button"
        aria-label={t("harnessMetricFormulaLabel")}
        title={t("harnessMetricFormulaLabel")}
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

function SectionLabelWithHint({
  label,
  lines,
}: {
  label: string;
  lines: string[];
}) {
  return (
    <span className="harness-metric-label-with-hint">
      {label}
      <FormulaHint lines={lines} />
    </span>
  );
}

export function ProjectLeaderboard({ overview }: Props) {
  const items = overview?.project_leaderboard ?? null;
  const reqStatus = overview?.requirement_status_counts ?? null;
  const navigate = useNavigate();

  const open = (id: string) => {
    void navigate(`/projects/${id}`);
  };

  return (
    <div className="work-panel work-panel-leaderboard">
      <header className="work-panel-header">
        <h3>{t("panelLeaderboard")}</h3>
      </header>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          <SectionLabelWithHint
            label={t("workReqStatusBreakdown")}
            lines={[t("workReqStatusBreakdownHint")]}
          />
        </div>
        {reqStatus === null ? (
          <div className="work-panel-empty">
            {t("workOverviewUnavailable")}
          </div>
        ) : (
          <div className="work-status-breakdown">
            <StatusChip
              label={t("colBacklog")}
              count={reqStatus.backlog}
              tone="neutral"
            />
            <StatusChip
              label={t("colInProgress")}
              count={reqStatus.in_progress}
              tone="active"
            />
            <StatusChip
              label={t("colReview")}
              count={reqStatus.review}
              tone="warning"
            />
            <StatusChip
              label={t("colDone")}
              count={reqStatus.done}
              tone="ok"
            />
          </div>
        )}
      </div>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          <SectionLabelWithHint
            label={t("workLeaderboardTopProjects")}
            lines={[
              t("workLeaderboardTopProjectsHint"),
              t("leaderCompletionHint"),
            ]}
          />
        </div>
        {items === null ? (
          <div className="work-panel-empty">
            {t("workOverviewUnavailable")}
          </div>
        ) : items.length === 0 ? (
          <div className="work-panel-empty">{t("workNoLeaderboardData")}</div>
        ) : (
          <ul className="work-leaderboard-list">
            {items.map((row, idx) => {
              const pct = Math.round(row.completion_rate * 100);
              const tone = rateTone(row.completion_rate);
              return (
                <li key={row.project_id}>
                  <button
                    type="button"
                    className="work-leaderboard-row"
                    onClick={() => open(row.project_id)}
                    title={row.project_name}
                  >
                    <span className="work-leaderboard-rank tabular-nums">
                      {t("leaderRank", idx + 1)}
                    </span>
                    <span
                      className="work-leaderboard-dot"
                      style={{ background: chipColor(row.project_id) }}
                      aria-hidden="true"
                    />
                    <span className="work-leaderboard-name">
                      {row.project_name}
                    </span>
                    <span className="work-leaderboard-runs tabular-nums">
                      {t("workRunsCount", row.runs_in_window)}
                    </span>
                    <span
                      className={"work-leaderboard-bar tone-" + tone}
                      title={`${t("leaderCompletion")}: ${pct}% · ${t("leaderCompletionHint")}`}
                    >
                      <span
                        className="work-leaderboard-bar-fill"
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                      <span className="work-leaderboard-bar-label tabular-nums">
                        {pct}%
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "neutral" | "active" | "warning" | "ok";
}) {
  return (
    <div className={`work-status-chip work-status-chip-${tone}`}>
      <span className="work-status-chip-count">{count}</span>
      <span className="work-status-chip-label">{label}</span>
    </div>
  );
}
