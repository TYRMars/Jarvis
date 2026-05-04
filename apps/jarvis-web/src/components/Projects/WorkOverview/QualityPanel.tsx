import { useMemo, useRef, useState } from "react";
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
  total: number;
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
      total,
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

  // v1.0 — headline current rate + window delta + trend tone.
  // Picks the latest non-empty bucket for "current"; the first
  // non-empty bucket for "baseline". Trend arrow reflects delta;
  // line tone (line color) follows the same trend so the spark
  // reads "rising / flat / falling" at a glance without reading
  // the number.
  const sparkWithData = spark.filter((p) => p.total > 0);
  const current = sparkWithData[sparkWithData.length - 1] ?? null;
  const baseline = sparkWithData[0] ?? null;
  const delta =
    current && baseline && current !== baseline ? current.rate - baseline.rate : 0;
  const trend: "up" | "flat" | "down" =
    Math.abs(delta) < 0.01 ? "flat" : delta > 0 ? "up" : "down";

  // Hover state for spark tooltip — same pattern as ThroughputChart.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const sparkRef = useRef<SVGSVGElement | null>(null);
  const onSparkMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!sparkRef.current || spark.length === 0) return;
    const rect = sparkRef.current.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * W;
    let nearestIdx = 0;
    let bestDist = Infinity;
    spark.forEach((p, i) => {
      const d = Math.abs(p.x - xInView);
      if (d < bestDist) {
        bestDist = d;
        nearestIdx = i;
      }
    });
    setHoverIdx(nearestIdx);
  };
  const hovered = hoverIdx !== null ? spark[hoverIdx] ?? null : null;

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
          <div className={"work-quality-spark spark-trend-" + trend}>
            <div className="work-quality-spark-head">
              <span className="work-quality-spark-label">
                {t("workQualitySparkLabel")}
              </span>
              {current && (
                <span className="work-quality-spark-headline">
                  <span className="work-quality-spark-value tabular-nums">
                    {Math.round(current.rate * 100)}%
                  </span>
                  {baseline && current !== baseline && (
                    <span
                      className={"work-quality-spark-delta tone-" + trend}
                      title={t("workQualitySparkDeltaTitle")}
                    >
                      <TrendIcon trend={trend} />
                      <span className="tabular-nums">
                        {delta > 0 ? "+" : ""}
                        {Math.round(delta * 100)}%
                      </span>
                    </span>
                  )}
                </span>
              )}
            </div>
            {spark.length === 0 ? (
              <div className="work-panel-empty">{t("workNoQualityData")}</div>
            ) : (
              <div className="work-quality-spark-wrap">
                <svg
                  ref={sparkRef}
                  className="work-quality-spark-svg"
                  viewBox={`0 0 ${W} ${H}`}
                  role="img"
                  aria-label={t("workQualitySparkLabel")}
                  onMouseMove={onSparkMove}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <path d={fillPath} className="work-quality-spark-fill" />
                  <polyline
                    className="work-quality-spark-line"
                    fill="none"
                    points={polyline}
                  />
                  {hovered && (
                    <>
                      <line
                        x1={hovered.x}
                        x2={hovered.x}
                        y1={PAD}
                        y2={H - PAD}
                        stroke="currentColor"
                        strokeOpacity="0.2"
                        strokeDasharray="3 3"
                      />
                      <circle
                        cx={hovered.x}
                        cy={hovered.y}
                        r="3"
                        className="work-quality-spark-dot"
                      />
                    </>
                  )}
                </svg>
                {hovered && (
                  <div
                    className="work-quality-spark-tooltip"
                    style={{
                      left: `${(hovered.x / W) * 100}%`,
                      top: `${(hovered.y / H) * 100}%`,
                    }}
                    role="tooltip"
                  >
                    <div className="work-quality-spark-tooltip-date tabular-nums">
                      {hovered.date}
                    </div>
                    <div className="work-quality-spark-tooltip-row">
                      <span className="label">{t("kpiVerificationPassRate")}</span>
                      <span className="value tabular-nums">
                        {hovered.total === 0
                          ? "—"
                          : `${Math.round(hovered.rate * 100)}%`}
                      </span>
                    </div>
                    <div className="work-quality-spark-tooltip-row">
                      <span className="label">{t("workQualitySampleSize")}</span>
                      <span className="value tabular-nums">{hovered.total}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="work-quality-list work-section-tone-danger">
            <div className="work-panel-section-label">
              <span>{t("workQualityTopFailing")}</span>
              <span className="work-panel-section-count tone-danger">
                {top.length}
              </span>
            </div>
            {top.length === 0 ? (
              <div className="work-panel-empty">{t("workNoFailures")}</div>
            ) : (
              <ul className="work-quality-failing">
                {top.map((row) => {
                  const pct =
                    maxFail > 0 ? (row.fail_count / maxFail) * 100 : 0;
                  return (
                    <FailingCommandRow
                      key={row.command_normalized}
                      cmd={row.command_normalized}
                      count={row.fail_count}
                      pct={pct}
                      sampleStderr={row.sample_stderr ?? null}
                    />
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


// Trend arrow used next to the headline pass-rate. SVG so it
// inherits color from the parent `tone-{up,flat,down}` class.
function TrendIcon({ trend }: { trend: "up" | "flat" | "down" }) {
  const stroke = "currentColor";
  if (trend === "up") {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 14 12 8 18 14" />
      </svg>
    );
  }
  if (trend === "down") {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 10 12 16 18 10" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// One row in the top-failing-commands list. Click toggles the full
// stderr snippet so the inline preview can stay short while still
// surfacing the long form on demand.
function FailingCommandRow({
  cmd,
  count,
  pct,
  sampleStderr,
}: {
  cmd: string;
  count: number;
  pct: number;
  sampleStderr: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = sampleStderr ? sampleStderr.slice(0, 120) : null;
  return (
    <li>
      <div className="work-quality-failing-row">
        <code className="work-quality-failing-cmd">{cmd}</code>
        <span className="work-quality-failing-count">{count}</span>
      </div>
      <div className="work-quality-failing-bar" aria-hidden="true">
        <div
          className="work-quality-failing-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      {sampleStderr && (
        <button
          type="button"
          className={"work-quality-failing-sample-toggle" + (expanded ? " is-expanded" : "")}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? t("workQualityHideSample") : t("workQualityShowSample")}
        </button>
      )}
      {sampleStderr && (
        <pre
          className={"work-quality-failing-sample" + (expanded ? " is-expanded" : "")}
          title={sampleStderr}
        >
          {expanded ? sampleStderr : preview}
          {!expanded && sampleStderr.length > 120 ? "…" : ""}
        </pre>
      )}
    </li>
  );
}
