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
}

function KpiCard({ label, value, hint, tone = "neutral" }: KpiCardProps) {
  return (
    <div className={`work-kpi-card work-kpi-card-${tone}`}>
      <div className="work-kpi-label">{label}</div>
      <div className="work-kpi-value">{value}</div>
      {hint && <div className="work-kpi-hint">{hint}</div>}
    </div>
  );
}

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
      />
      <KpiCard
        label={t("kpiFailedInWindow")}
        value={failed === null ? placeholder : String(failed)}
        tone={failed && failed > 0 ? "danger" : "neutral"}
      />
      <KpiCard
        label={t("kpiCompletedInWindow")}
        value={completed === null ? placeholder : String(completed)}
      />
      <KpiCard
        label={t("kpiVerificationPassRate")}
        value={passRateLabel}
        hint={
          passRate === null || passRate === undefined
            ? t("kpiVerificationPassRateNoData")
            : undefined
        }
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
