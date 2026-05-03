import { useMemo } from "react";
import { t } from "../../../utils/i18n";
import type { WorkOverview } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
}

const W = 600;
const H = 200;
const PADDING = { top: 16, right: 12, bottom: 28, left: 32 };

interface Layout {
  bars: {
    date: string;
    label: string;
    x: number;
    failedY: number;
    failedH: number;
    completedY: number;
    completedH: number;
    otherY: number;
    otherH: number;
    total: number;
  }[];
  yTicks: { y: number; value: number }[];
  barWidth: number;
}

function buildLayout(overview: WorkOverview | null): Layout | null {
  if (!overview) return null;
  const days = overview.throughput_by_day;
  if (days.length === 0) return null;
  const innerW = W - PADDING.left - PADDING.right;
  const innerH = H - PADDING.top - PADDING.bottom;
  const max = Math.max(
    1,
    ...days.map((d) => d.runs_started),
  );
  const yScale = (v: number) => PADDING.top + innerH - (v / max) * innerH;
  const slot = innerW / days.length;
  const barWidth = Math.max(6, slot * 0.6);
  const bars = days.map((d, i) => {
    const x = PADDING.left + slot * i + (slot - barWidth) / 2;
    const failedH = innerH * (d.runs_failed / max);
    const completedH = innerH * (d.runs_completed / max);
    const otherCount = Math.max(
      0,
      d.runs_started - d.runs_completed - d.runs_failed,
    );
    const otherH = innerH * (otherCount / max);
    const baseY = PADDING.top + innerH;
    const failedY = baseY - failedH;
    const completedY = failedY - completedH;
    const otherY = completedY - otherH;
    return {
      date: d.date,
      label: d.date.slice(5), // MM-DD
      x,
      failedY,
      failedH,
      completedY,
      completedH,
      otherY,
      otherH,
      total: d.runs_started,
    };
  });
  // 4 evenly spaced y ticks rounded to a nice number.
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = Math.round((max * i) / tickCount);
    return { y: yScale(value), value };
  });
  return { bars, yTicks, barWidth };
}

export function ThroughputChart({ overview }: Props) {
  const layout = useMemo(() => buildLayout(overview), [overview]);
  const totalStarted = overview?.throughput_by_day.reduce(
    (acc, d) => acc + d.runs_started,
    0,
  ) ?? 0;

  return (
    <div className="work-panel work-panel-throughput">
      <header className="work-panel-header">
        <h3>{t("panelThroughput")}</h3>
        <span className="work-panel-header-meta">
          {t("workThroughputTotal", totalStarted)}
        </span>
      </header>

      {!layout || totalStarted === 0 ? (
        <div className="work-panel-empty">{t("workNoThroughput")}</div>
      ) : (
        <>
          <svg
            className="work-throughput-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={t("panelThroughput")}
          >
            {layout.yTicks.map((tk, i) => (
              <g key={i}>
                <line
                  x1={PADDING.left}
                  x2={W - PADDING.right}
                  y1={tk.y}
                  y2={tk.y}
                  stroke="currentColor"
                  strokeOpacity="0.08"
                />
                <text
                  x={PADDING.left - 6}
                  y={tk.y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize="10"
                  fill="currentColor"
                  fillOpacity="0.5"
                >
                  {tk.value}
                </text>
              </g>
            ))}
            {layout.bars.map((b) => (
              <g key={b.date}>
                {b.failedH > 0 && (
                  <rect
                    x={b.x}
                    y={b.failedY}
                    width={layout.barWidth}
                    height={b.failedH}
                    className="work-throughput-bar work-throughput-bar-failed"
                  />
                )}
                {b.completedH > 0 && (
                  <rect
                    x={b.x}
                    y={b.completedY}
                    width={layout.barWidth}
                    height={b.completedH}
                    className="work-throughput-bar work-throughput-bar-completed"
                  />
                )}
                {b.otherH > 0 && (
                  <rect
                    x={b.x}
                    y={b.otherY}
                    width={layout.barWidth}
                    height={b.otherH}
                    className="work-throughput-bar work-throughput-bar-other"
                  />
                )}
                <title>
                  {`${b.date}: ${b.total} runs`}
                </title>
              </g>
            ))}
            {/* x labels — show every Nth so they don't overlap */}
            {layout.bars.map((b, i) => {
              const stride = Math.max(1, Math.ceil(layout.bars.length / 7));
              if (i % stride !== 0) return null;
              return (
                <text
                  key={`l-${b.date}`}
                  x={b.x + layout.barWidth / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize="10"
                  fill="currentColor"
                  fillOpacity="0.55"
                >
                  {b.label}
                </text>
              );
            })}
          </svg>
          <div className="work-throughput-legend">
            <span className="work-legend-chip work-legend-chip-completed">
              {t("workLegendCompleted")}
            </span>
            <span className="work-legend-chip work-legend-chip-failed">
              {t("workLegendFailed")}
            </span>
            <span className="work-legend-chip work-legend-chip-other">
              {t("workLegendOther")}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
