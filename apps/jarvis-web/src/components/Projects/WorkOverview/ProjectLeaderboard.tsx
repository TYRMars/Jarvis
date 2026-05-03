import { t } from "../../../utils/i18n";
import type { WorkOverview } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
}

export function ProjectLeaderboard({ overview }: Props) {
  const items = overview?.project_leaderboard ?? null;
  const reqStatus = overview?.requirement_status_counts ?? null;

  const open = (id: string) => {
    window.dispatchEvent(
      new CustomEvent<string>("jarvis:open-project", { detail: id }),
    );
  };

  return (
    <div className="work-panel work-panel-leaderboard">
      <header className="work-panel-header">
        <h3>{t("panelLeaderboard")}</h3>
      </header>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          {t("workReqStatusBreakdown")}
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
          {t("workLeaderboardTopProjects")}
        </div>
        {items === null ? (
          <div className="work-panel-empty">
            {t("workOverviewUnavailable")}
          </div>
        ) : items.length === 0 ? (
          <div className="work-panel-empty">{t("workNoLeaderboardData")}</div>
        ) : (
          <ul className="work-leaderboard-list">
            {items.map((row) => (
              <li key={row.project_id}>
                <button
                  type="button"
                  className="work-leaderboard-row"
                  onClick={() => open(row.project_id)}
                >
                  <span className="work-leaderboard-name">
                    {row.project_name}
                  </span>
                  <span className="work-leaderboard-stats">
                    <span>{t("workRunsCount", row.runs_in_window)}</span>
                    <span className="work-leaderboard-rate">
                      {Math.round(row.completion_rate * 100)}%
                    </span>
                  </span>
                </button>
              </li>
            ))}
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
