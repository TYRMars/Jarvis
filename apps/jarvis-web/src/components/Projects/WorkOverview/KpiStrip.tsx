import type { ReactNode } from "react";
import { t } from "../../../utils/i18n";
import type { WorkOverview } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
  loading: boolean;
}

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "danger" | "ok";
  icon: ReactNode;
  loading?: boolean;
  /// Anchor id to scroll to when the card is clicked (e.g. the
  /// operational panel's #section). When set, the card becomes a
  /// `<button>` with an aria-label telling assistive tech where it
  /// jumps. Omit for non-interactive cards (e.g. pass-rate has no
  /// dedicated section to scroll to).
  scrollTo?: string;
}

function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  loading = false,
  scrollTo,
}: KpiCardProps) {
  const className = [
    "work-kpi-card",
    `work-kpi-card-${tone}`,
    loading ? "is-loading" : "",
    scrollTo ? "is-clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <div className="work-kpi-card-head">
        <span className="work-kpi-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="work-kpi-label">{label}</span>
      </div>
      {loading ? (
        <div className="work-kpi-skeleton" aria-hidden="true" />
      ) : (
        <div className="work-kpi-value tabular-nums">{value}</div>
      )}
      {hint && !loading && <div className="work-kpi-hint">{hint}</div>}
    </>
  );

  if (scrollTo) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          const el = document.getElementById(scrollTo);
          el?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        aria-label={`${label} — ${value}`}
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

// Shared icon constants — small (14px) so they sit alongside the
// label without dominating. Stroke-based so they pick up
// `currentColor` from the card's tone.
const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const RunningIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);
const FailedIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>
);
const CompletedIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const PassRateIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

export function KpiStrip({ overview, loading }: Props) {
  const placeholder = "—";
  const runningNow = overview?.running_now.length ?? null;
  const failed = overview?.run_status_counts.failed ?? null;
  const completed = overview?.run_status_counts.completed ?? null;
  const passRate = overview?.verification_pass_rate;

  const passRateLabel =
    passRate === null || passRate === undefined
      ? placeholder
      : `${Math.round(passRate * 100)}%`;

  return (
    <div className="work-kpi-strip" aria-busy={loading || undefined}>
      <KpiCard
        label={t("kpiRunningNow")}
        value={runningNow === null ? placeholder : String(runningNow)}
        tone={runningNow && runningNow > 0 ? "ok" : "neutral"}
        icon={<RunningIcon />}
        loading={loading && runningNow === null}
        scrollTo="work-overview-operational"
      />
      <KpiCard
        label={t("kpiFailedInWindow")}
        value={failed === null ? placeholder : String(failed)}
        tone={failed && failed > 0 ? "danger" : "neutral"}
        icon={<FailedIcon />}
        loading={loading && failed === null}
        scrollTo="work-overview-operational"
      />
      <KpiCard
        label={t("kpiCompletedInWindow")}
        value={completed === null ? placeholder : String(completed)}
        tone={completed && completed > 0 ? "ok" : "neutral"}
        icon={<CompletedIcon />}
        loading={loading && completed === null}
        scrollTo="work-overview-throughput"
      />
      <KpiCard
        label={t("kpiVerificationPassRate")}
        value={passRateLabel}
        hint={
          passRate === null || passRate === undefined
            ? t("kpiVerificationPassRateNoData")
            : undefined
        }
        icon={<PassRateIcon />}
        loading={loading && (passRate === null || passRate === undefined)}
        tone={
          passRate === null || passRate === undefined
            ? "neutral"
            : passRate >= 0.8
              ? "ok"
              : passRate >= 0.5
                ? "neutral"
                : "danger"
        }
      />
    </div>
  );
}
