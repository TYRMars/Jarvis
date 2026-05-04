import { useMemo, useRef, useState } from "react";
import { t } from "../../../utils/i18n";
import type { WorkOverview } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
}

const W = 600;
const H = 200;
const PADDING = { top: 16, right: 12, bottom: 28, left: 32 };

interface Bar {
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
  completed: number;
  failed: number;
  other: number;
}
interface Layout {
  bars: Bar[];
  yTicks: { y: number; value: number }[];
  barWidth: number;
  slot: number;
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
  const bars: Bar[] = days.map((d, i) => {
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
      completed: d.runs_completed,
      failed: d.runs_failed,
      other: otherCount,
    };
  });
  // 4 evenly spaced y ticks rounded to a nice number.
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = Math.round((max * i) / tickCount);
    return { y: yScale(value), value };
  });
  return { bars, yTicks, barWidth, slot };
}

export function ThroughputChart({ overview }: Props) {
  const layout = useMemo(() => buildLayout(overview), [overview]);
  const totalStarted = overview?.throughput_by_day.reduce(
    (acc, d) => acc + d.runs_started,
    0,
  ) ?? 0;

  // v1.0 — interactive hover. Track which bar (by date) is under
  // the cursor; render a tooltip with the breakdown + a vertical
  // guide line. Nearest-bar lookup is by x-coordinate so the
  // tooltip "snaps" to the closest day even when the cursor is in
  // the gap between bars (no jittery hover-out).
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!layout || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // Convert client x to viewBox x.
    const xInView = ((e.clientX - rect.left) / rect.width) * W;
    let nearest: Bar | null = null;
    let bestDist = Infinity;
    for (const b of layout.bars) {
      const center = b.x + layout.barWidth / 2;
      const d = Math.abs(center - xInView);
      if (d < bestDist) {
        bestDist = d;
        nearest = b;
      }
    }
    if (nearest && nearest.date !== hoverDate) {
      setHoverDate(nearest.date);
    }
  };

  const hovered = hoverDate
    ? (layout?.bars.find((b) => b.date === hoverDate) ?? null)
    : null;

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
        <div className="work-throughput-wrap">
          <svg
            ref={svgRef}
            className="work-throughput-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={t("panelThroughput")}
            onMouseMove={onSvgMouseMove}
            onMouseLeave={() => setHoverDate(null)}
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
            {/* Vertical guide line on hovered bar — drawn before the
                bars so the bars sit on top. */}
            {hovered && (
              <line
                x1={hovered.x + layout.barWidth / 2}
                x2={hovered.x + layout.barWidth / 2}
                y1={PADDING.top}
                y2={H - PADDING.bottom}
                stroke="currentColor"
                strokeOpacity="0.18"
                strokeDasharray="3 3"
              />
            )}
            {layout.bars.map((b) => {
              const isHover = b.date === hoverDate;
              const dim = hoverDate !== null && !isHover;
              return (
                <g key={b.date} className={dim ? "is-dim" : isHover ? "is-hover" : undefined}>
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
                  {/* Native <title> stays as a fallback for non-mouse
                      input (touch with long-press, screen readers
                      announcing the SVG). */}
                  <title>
                    {`${b.date}: ${b.total} runs`}
                  </title>
                </g>
              );
            })}
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
          {hovered && (
            <ThroughputTooltip
              bar={hovered}
              chartW={W}
              chartH={H}
              barWidth={layout.barWidth}
            />
          )}
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
        </div>
      )}
    </div>
  );
}

// Hover tooltip — positioned in viewBox % so it scales with the SVG
// frame (the svg uses preserveAspectRatio default, so percent
// positioning maps cleanly to the rendered DOM box). We avoid a
// portal and absolute pixel coords so the tooltip stays glued to
// the bar through window resize / responsive width.
function ThroughputTooltip({
  bar,
  chartW,
  chartH,
  barWidth,
}: {
  bar: Bar;
  chartW: number;
  chartH: number;
  barWidth: number;
}) {
  const centerPct = ((bar.x + barWidth / 2) / chartW) * 100;
  // Place above the bar's top (the failed segment is bottom-most so
  // failedY - failedH would be the topmost hand-rolled top; easier
  // to use otherY which is already the topmost segment Y).
  const topY = Math.min(bar.failedY, bar.completedY, bar.otherY);
  const topPct = (topY / chartH) * 100;
  // Tooltip is anchored at the top of the highest bar segment, then
  // translated up so its bottom-edge sits just above. CSS handles
  // edge-clamping so it never overflows the chart frame.
  return (
    <div
      className="work-throughput-tooltip"
      style={{
        left: `${centerPct}%`,
        top: `${topPct}%`,
      }}
      role="tooltip"
    >
      <div className="work-throughput-tooltip-date tabular-nums">{bar.date}</div>
      <div className="work-throughput-tooltip-row">
        <span className="dot dot-completed" aria-hidden="true" />
        <span className="label">{t("workLegendCompleted")}</span>
        <span className="value tabular-nums">{bar.completed}</span>
      </div>
      <div className="work-throughput-tooltip-row">
        <span className="dot dot-failed" aria-hidden="true" />
        <span className="label">{t("workLegendFailed")}</span>
        <span className="value tabular-nums">{bar.failed}</span>
      </div>
      <div className="work-throughput-tooltip-row">
        <span className="dot dot-other" aria-hidden="true" />
        <span className="label">{t("workLegendOther")}</span>
        <span className="value tabular-nums">{bar.other}</span>
      </div>
      <div className="work-throughput-tooltip-total">
        {t("workThroughputTotal", bar.total)}
      </div>
    </div>
  );
}
