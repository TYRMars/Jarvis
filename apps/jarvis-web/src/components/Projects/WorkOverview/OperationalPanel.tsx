import { useNavigate } from "react-router-dom";
import { t } from "../../../utils/i18n";
import { resumeConversation } from "../../../services/conversations";
import type {
  RecentFailureRow,
  RunningRunRow,
  WorkOverview,
} from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Math.floor((Date.now() - then) / 1000);
  if (diff < 60) return t("relSecondsAgo", diff);
  if (diff < 3600) return t("relMinutesAgo", Math.floor(diff / 60));
  if (diff < 86400) return t("relHoursAgo", Math.floor(diff / 3600));
  return t("relDaysAgo", Math.floor(diff / 86400));
}

function RunningRow({
  row,
  onOpenConversation,
}: {
  row: RunningRunRow;
  onOpenConversation: (id: string) => void;
}) {
  return (
    <li className="work-op-row">
      <div className="work-op-row-main">
        <span className="work-op-row-title">
          {row.requirement_title ?? row.requirement_id.slice(0, 8)}
        </span>
        {row.project_name && (
          <span className="work-op-row-project">{row.project_name}</span>
        )}
      </div>
      <div className="work-op-row-meta">
        <span className="work-op-row-duration">
          {formatDuration(row.duration_ms)}
        </span>
        <button
          type="button"
          className="work-op-row-link"
          onClick={() => onOpenConversation(row.conversation_id)}
        >
          {t("workOpenConversation")}
        </button>
      </div>
    </li>
  );
}

function FailureRow({
  row,
  onOpenConversation,
}: {
  row: RecentFailureRow;
  onOpenConversation: (id: string) => void;
}) {
  return (
    <li className="work-op-row">
      <div className="work-op-row-main">
        <span className="work-op-row-title">
          {row.requirement_title ?? row.requirement_id.slice(0, 8)}
        </span>
        {row.project_name && (
          <span className="work-op-row-project">{row.project_name}</span>
        )}
        {row.error && (
          <span className="work-op-row-error" title={row.error}>
            {row.error}
          </span>
        )}
      </div>
      <div className="work-op-row-meta">
        <span className="work-op-row-time">
          {formatRelative(row.finished_at)}
        </span>
        <button
          type="button"
          className="work-op-row-link"
          onClick={() => onOpenConversation(row.conversation_id)}
        >
          {t("workOpenConversation")}
        </button>
      </div>
    </li>
  );
}

export function OperationalPanel({ overview }: Props) {
  const navigate = useNavigate();
  const open = (id: string) => {
    void resumeConversation(id);
    void navigate("/");
  };

  const running = overview?.running_now ?? [];
  const failures = overview?.recent_failures ?? [];
  const blocked = overview?.blocked_requirements ?? null;

  return (
    <div className="work-panel work-panel-operational">
      <header className="work-panel-header">
        <h3>{t("panelOperational")}</h3>
      </header>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          {t("workSectionRunning")}
          <span className="work-panel-section-count">{running.length}</span>
        </div>
        {running.length === 0 ? (
          <div className="work-panel-empty">{t("workNoRunning")}</div>
        ) : (
          <ul className="work-op-list">
            {running.map((r) => (
              <RunningRow key={r.id} row={r} onOpenConversation={open} />
            ))}
          </ul>
        )}
      </div>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          {t("workSectionFailures")}
          <span className="work-panel-section-count">{failures.length}</span>
        </div>
        {failures.length === 0 ? (
          <div className="work-panel-empty">{t("workNoFailures")}</div>
        ) : (
          <ul className="work-op-list">
            {failures.map((r) => (
              <FailureRow key={r.id} row={r} onOpenConversation={open} />
            ))}
          </ul>
        )}
      </div>

      <div className="work-panel-section">
        <div className="work-panel-section-label">
          {t("workSectionBlocked")}
          {blocked !== null && (
            <span className="work-panel-section-count">{blocked.length}</span>
          )}
        </div>
        {blocked === null ? (
          <div className="work-panel-empty">{t("workActivityUnavailable")}</div>
        ) : blocked.length === 0 ? (
          <div className="work-panel-empty">{t("workNoBlocked")}</div>
        ) : (
          <ul className="work-op-list">
            {blocked.map((r) => (
              <li key={r.id} className="work-op-row">
                <div className="work-op-row-main">
                  <span className="work-op-row-title">{r.title}</span>
                  {r.project_name && (
                    <span className="work-op-row-project">
                      {r.project_name}
                    </span>
                  )}
                  {r.reason && (
                    <span className="work-op-row-error" title={r.reason}>
                      {r.reason}
                    </span>
                  )}
                </div>
                <div className="work-op-row-meta">
                  <span className="work-op-row-time">
                    {formatRelative(r.blocked_since)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
