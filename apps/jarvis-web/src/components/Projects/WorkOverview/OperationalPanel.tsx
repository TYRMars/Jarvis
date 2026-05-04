import type { ReactNode } from "react";
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
  // Server may return failures in insertion order; the panel reads
  // newest-first, so sort defensively. Falls back gracefully when
  // `finished_at` is missing.
  const failures = (overview?.recent_failures ?? [])
    .slice()
    .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  const blocked = overview?.blocked_requirements ?? null;

  return (
    <div className="work-panel work-panel-operational">
      <header className="work-panel-header">
        <h3>{t("panelOperational")}</h3>
      </header>

      {/* v1.0 — sections now carry urgency tone (running=ok,
          failures=danger, blocked=warn) which surfaces as a left
          accent bar + a coloured count chip. The order is also
          urgency-first (failures > blocked > running) so the eye
          lands on what needs attention. */}
      <Section
        tone="danger"
        label={t("workSectionFailures")}
        count={failures.length}
        emptyHint={t("workNoFailures")}
      >
        {failures.map((r) => (
          <FailureRow key={r.id} row={r} onOpenConversation={open} />
        ))}
      </Section>

      <Section
        tone="warn"
        label={t("workSectionBlocked")}
        count={blocked?.length ?? null}
        emptyHint={
          blocked === null ? t("workActivityUnavailable") : t("workNoBlocked")
        }
      >
        {(blocked ?? []).map((r) => (
          <li key={r.id} className="work-op-row">
            <div className="work-op-row-main">
              <span className="work-op-row-title">{r.title}</span>
              {r.project_name && (
                <span className="work-op-row-project">{r.project_name}</span>
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
      </Section>

      <Section
        tone="ok"
        label={t("workSectionRunning")}
        count={running.length}
        emptyHint={t("workNoRunning")}
      >
        {running.map((r) => (
          <RunningRow key={r.id} row={r} onOpenConversation={open} />
        ))}
      </Section>
    </div>
  );
}

// Reusable tone-aware section wrapper. Owns the label row, count
// chip, accent bar, and empty-state collapse so the panel body
// stays declarative.
function Section({
  tone,
  label,
  count,
  emptyHint,
  children,
}: {
  tone: "ok" | "danger" | "warn";
  label: string;
  /// `null` means "data unavailable" (different from "0 items").
  count: number | null;
  emptyHint: string;
  children: ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  // `children` from `.map(...).filter(Boolean)` includes truthy nodes
  // only; if count==null OR there are no rendered items, show empty
  // state instead of the list.
  const isEmpty =
    count === null || count === 0 || items.filter(Boolean).length === 0;
  return (
    <div className={"work-panel-section work-section-tone-" + tone}>
      <div className="work-panel-section-label">
        <span>{label}</span>
        {count !== null && (
          <span className={"work-panel-section-count tone-" + tone}>
            {count}
          </span>
        )}
      </div>
      {isEmpty ? (
        <div className="work-panel-empty">{emptyHint}</div>
      ) : (
        <ul className="work-op-list">{children}</ul>
      )}
    </div>
  );
}
