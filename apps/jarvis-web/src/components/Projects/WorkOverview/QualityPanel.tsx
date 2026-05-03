import { useMemo } from "react";
import { t } from "../../../utils/i18n";
import type {
  WorkQuality,
  VerificationDayBucket,
} from "../../../services/workOverview";

interface Props {
  quality: WorkQuality | null;
  unavailable: boolean;
}

const W = 280;
const H = 60;
const PAD = 4;

interface SparkPoint {
  x: number;
  y: number;
  rate: number;
  date: string;
}

function buildSpark(buckets: VerificationDayBucket[]): SparkPoint[] {
  if (buckets.length === 0) return [];
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const step = buckets.length > 1 ? innerW / (buckets.length - 1) : 0;
  return buckets.map((b, i) => {
    const total = b.passed + b.failed + b.needs_review;
    const rate = total > 0 ? b.passed / total : 0;
    return {
      x: PAD + step * i,
      y: PAD + innerH - rate * innerH,
      rate,
      date: b.date,
    };
  });
}

export function QualityPanel({ quality, unavailable }: Props) {
  const spark = useMemo(
    () => (quality ? buildSpark(quality.verification_pass_rate_by_day) : []),
    [quality],
  );
  const polyline = spark.map((p) => `${p.x},${p.y}`).join(" ");
  const fillPath =
    spark.length > 0
      ? `M ${spark[0].x},${H - PAD} ` +
        spark.map((p) => `L ${p.x},${p.y}`).join(" ") +
        ` L ${spark[spark.length - 1].x},${H - PAD} Z`
      : "";

  const top = quality?.top_failing_commands ?? [];
  const maxFail = top.length > 0 ? top[0].fail_count : 0;

  return (
    <div className="work-panel work-panel-quality">
      <header className="work-panel-header">
        <h3>{t("panelQuality")}</h3>
      </header>

      {unavailable ? (
        <div className="work-panel-empty">{t("workOverviewUnavailable")}</div>
      ) : (
        <>
          <div className="work-quality-spark">
            <div className="work-quality-spark-label">
              {t("workQualitySparkLabel")}
            </div>
            {spark.length === 0 ? (
              <div className="work-panel-empty">{t("workNoQualityData")}</div>
            ) : (
              <svg
                className="work-quality-spark-svg"
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={t("workQualitySparkLabel")}
              >
                <path d={fillPath} className="work-quality-spark-fill" />
                <polyline
                  className="work-quality-spark-line"
                  fill="none"
                  points={polyline}
                />
              </svg>
            )}
          </div>

          <div className="work-quality-list">
            <div className="work-panel-section-label">
              {t("workQualityTopFailing")}
              <span className="work-panel-section-count">{top.length}</span>
            </div>
            {top.length === 0 ? (
              <div className="work-panel-empty">{t("workNoFailures")}</div>
            ) : (
              <ul className="work-quality-failing">
                {top.map((row) => {
                  const pct =
                    maxFail > 0 ? (row.fail_count / maxFail) * 100 : 0;
                  return (
                    <li key={row.command_normalized}>
                      <div className="work-quality-failing-row">
                        <code className="work-quality-failing-cmd">
                          {row.command_normalized}
                        </code>
                        <span className="work-quality-failing-count">
                          {row.fail_count}
                        </span>
                      </div>
                      <div className="work-quality-failing-bar">
                        <div
                          className="work-quality-failing-bar-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {row.sample_stderr && (
                        <pre
                          className="work-quality-failing-sample"
                          title={row.sample_stderr}
                        >
                          {row.sample_stderr.slice(0, 120)}
                          {row.sample_stderr.length > 120 ? "…" : ""}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
