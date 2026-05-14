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
  formulaLines?: string[];
  tone?: "neutral" | "danger" | "ok";
  icon: ReactNode;
  loading?: boolean;
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

function LabelWithHint({ label, lines }: { label: string; lines?: string[] }) {
  if (!lines || lines.length === 0) return <span>{label}</span>;
  return (
    <span className="harness-metric-label-with-hint">
      {label}
      <FormulaHint lines={lines} />
    </span>
  );
}

function KpiCard({
  label,
  value,
  hint,
  formulaLines,
  tone = "neutral",
  icon,
  loading = false,
}: KpiCardProps) {
  const className = [
    "work-kpi-card",
    `work-kpi-card-${tone}`,
    loading ? "is-loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="work-kpi-card-head">
        <span className="work-kpi-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="work-kpi-label">
          <LabelWithHint label={label} lines={formulaLines} />
        </span>
      </div>
      {loading ? (
        <div className="work-kpi-skeleton" aria-hidden="true" />
      ) : (
        <div className="work-kpi-value tabular-nums">{value}</div>
      )}
      {hint && !loading && <div className="work-kpi-hint">{hint}</div>}
    </div>
  );
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
        formulaLines={[t("kpiRunningNowHint")]}
        tone={runningNow && runningNow > 0 ? "ok" : "neutral"}
        icon={<RunningIcon />}
        loading={loading && runningNow === null}
      />
      <KpiCard
        label={t("kpiFailedInWindow")}
        value={failed === null ? placeholder : String(failed)}
        formulaLines={[t("kpiFailedInWindowHint")]}
        tone={failed && failed > 0 ? "danger" : "neutral"}
        icon={<FailedIcon />}
        loading={loading && failed === null}
      />
      <KpiCard
        label={t("kpiCompletedInWindow")}
        value={completed === null ? placeholder : String(completed)}
        formulaLines={[t("kpiCompletedInWindowHint")]}
        tone={completed && completed > 0 ? "ok" : "neutral"}
        icon={<CompletedIcon />}
        loading={loading && completed === null}
      />
      <KpiCard
        label={t("kpiVerificationPassRate")}
        value={passRateLabel}
        hint={
          passRate === null || passRate === undefined
            ? t("kpiVerificationPassRateNoData")
            : undefined
        }
        formulaLines={[t("kpiVerificationPassRateHint")]}
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
