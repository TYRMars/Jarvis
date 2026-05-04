// v1.0 — Token usage + estimated cost panel for the WorkOverview.
//
// Reads from `usageCumulator` (browser-local daily buckets fed by
// the WS `usage` frame stream) so the dashboard surfaces what the
// agent is actually burning without needing a server schema change.
//
// What the panel shows:
//   1. Today's headline tokens + estimated cost (current model)
//   2. Window totals (matches the page's window selector)
//   3. Per-bucket sparkline (last N days)
//   4. Reset button — clears localStorage history; useful before
//      starting a billable demo / measuring a specific session.
//
// Honest limitations rendered next to the cost line:
//   - "browser-local" — each device tracks separately
//   - "estimated" — based on a hardcoded price table; codex /
//     ollama show $0 because they're flat-rate / local

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../utils/i18n";
import {
  activeModelLabel,
  estimateCostUSD,
  listDailyBuckets,
  resetUsageHistory,
  subscribeUsageCumulator,
  todaysTotals,
  totalsForWindow,
  type DailyBucket,
} from "../../../services/usageCumulator";
import type { WindowDays } from "../../../services/workOverview";

interface Props {
  windowDays: WindowDays;
}

const SPARK_W = 280;
const SPARK_H = 56;
const SPARK_PAD = 4;

interface SparkPoint {
  x: number;
  y: number;
  date: string;
  total: number;
}

function buildSpark(buckets: DailyBucket[], windowDays: number): SparkPoint[] {
  if (buckets.length === 0) return [];
  // Keep only buckets within the window. Sort ascending by date so
  // the line reads left-to-right as time progresses.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (windowDays - 1));
  cutoff.setHours(0, 0, 0, 0);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  const filtered = buckets
    .filter((b) => b.date >= cutoffKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (filtered.length === 0) return [];
  const max = Math.max(1, ...filtered.map((b) => b.prompt + b.completion));
  const innerW = SPARK_W - SPARK_PAD * 2;
  const innerH = SPARK_H - SPARK_PAD * 2;
  const step = filtered.length > 1 ? innerW / (filtered.length - 1) : 0;
  return filtered.map((b, i) => {
    const total = b.prompt + b.completion;
    return {
      x: SPARK_PAD + step * i,
      y: SPARK_PAD + innerH - (total / max) * innerH,
      date: b.date,
      total,
    };
  });
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function UsagePanel({ windowDays }: Props) {
  // Re-render on every cumulator mutation. The cumulator already
  // batches per-frame so this is cheap.
  const [, force] = useState(0);
  useEffect(() => subscribeUsageCumulator(() => force((n) => n + 1)), []);

  const today = todaysTotals();
  // Renamed from `window` to avoid shadowing the global object.
  const windowTotals = totalsForWindow(windowDays);
  const model = activeModelLabel();
  const todayCost = estimateCostUSD(model, today);
  const windowCost = estimateCostUSD(model, windowTotals);

  const buckets = listDailyBuckets();
  const spark = useMemo(
    () => buildSpark(buckets, windowDays),
    // The cumulator notifier triggers a re-render via `force`; the
    // memo dep array therefore captures the buckets reference each
    // render so the spark stays in lockstep without an extra
    // version counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets.length, windowDays, buckets[buckets.length - 1]?.date],
  );
  const polyline = spark.map((p) => `${p.x},${p.y}`).join(" ");
  const fillPath =
    spark.length > 0
      ? `M ${spark[0].x},${SPARK_H - SPARK_PAD} ` +
        spark.map((p) => `L ${p.x},${p.y}`).join(" ") +
        ` L ${spark[spark.length - 1].x},${SPARK_H - SPARK_PAD} Z`
      : "";

  // Hover tooltip — same nearest-point pattern as the other charts.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const sparkRef = useRef<SVGSVGElement | null>(null);
  const onSparkMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!sparkRef.current || spark.length === 0) return;
    const rect = sparkRef.current.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * SPARK_W;
    let nearest = 0;
    let best = Infinity;
    spark.forEach((p, i) => {
      const d = Math.abs(p.x - xInView);
      if (d < best) {
        best = d;
        nearest = i;
      }
    });
    setHoverIdx(nearest);
  };
  const hovered = hoverIdx !== null ? spark[hoverIdx] ?? null : null;

  const handleReset = () => {
    if (!windowTotals.total && !today.total) return;
    if (!confirm(t("usagePanelResetConfirm"))) return;
    resetUsageHistory();
  };

  return (
    <div className="work-panel work-panel-usage">
      <header className="work-panel-header">
        <h3>{t("usagePanelTitle")}</h3>
        <button
          type="button"
          className="usage-reset-btn"
          onClick={handleReset}
          title={t("usagePanelResetHint")}
          disabled={!windowTotals.total && !today.total}
        >
          {t("usagePanelReset")}
        </button>
      </header>

      {/* Headline today block */}
      <div className="usage-headline">
        <div className="usage-headline-block">
          <div className="usage-headline-label">{t("usagePanelToday")}</div>
          <div className="usage-headline-value tabular-nums">
            {fmtTokens(today.total)}
          </div>
          <div className="usage-headline-cost tabular-nums">
            {fmtCost(todayCost)}
          </div>
        </div>
        <div className="usage-headline-block">
          <div className="usage-headline-label">
            {t("usagePanelWindow", windowDays)}
          </div>
          <div className="usage-headline-value tabular-nums">
            {fmtTokens(windowTotals.total)}
          </div>
          <div className="usage-headline-cost tabular-nums">
            {fmtCost(windowCost)}
          </div>
        </div>
      </div>

      {/* Token-type breakdown */}
      <div className="usage-breakdown">
        <BreakdownChip
          label={t("usagePanelPrompt")}
          value={fmtTokens(windowTotals.prompt)}
          tone="prompt"
        />
        <BreakdownChip
          label={t("usagePanelCompletion")}
          value={fmtTokens(windowTotals.completion)}
          tone="completion"
        />
        <BreakdownChip
          label={t("usagePanelCached")}
          value={fmtTokens(windowTotals.cached)}
          tone="cached"
          hint={t("usagePanelCachedHint")}
        />
        <BreakdownChip
          label={t("usagePanelCalls")}
          value={String(windowTotals.calls)}
          tone="calls"
        />
      </div>

      {/* Sparkline of daily totals across the window */}
      <div className="usage-spark-wrap">
        {spark.length === 0 ? (
          <div className="work-panel-empty">{t("usagePanelNoData")}</div>
        ) : (
          <>
            <svg
              ref={sparkRef}
              className="usage-spark-svg"
              viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
              role="img"
              aria-label={t("usagePanelSparkLabel")}
              onMouseMove={onSparkMove}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <path d={fillPath} className="usage-spark-fill" />
              <polyline
                className="usage-spark-line"
                fill="none"
                points={polyline}
              />
              {hovered && (
                <>
                  <line
                    x1={hovered.x}
                    x2={hovered.x}
                    y1={SPARK_PAD}
                    y2={SPARK_H - SPARK_PAD}
                    stroke="currentColor"
                    strokeOpacity="0.2"
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={hovered.x}
                    cy={hovered.y}
                    r="3"
                    className="usage-spark-dot"
                  />
                </>
              )}
            </svg>
            {hovered && (
              <div
                className="usage-spark-tooltip"
                style={{
                  left: `${(hovered.x / SPARK_W) * 100}%`,
                  top: `${(hovered.y / SPARK_H) * 100}%`,
                }}
                role="tooltip"
              >
                <div className="usage-spark-tooltip-date tabular-nums">
                  {hovered.date}
                </div>
                <div className="usage-spark-tooltip-row">
                  <span className="label">{t("usagePanelTotal")}</span>
                  <span className="value tabular-nums">
                    {fmtTokens(hovered.total)}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer: model + caveat */}
      <footer className="usage-footnote">
        <span>
          {t("usagePanelCostBasis", model)}
          {todayCost === null && (
            <span className="usage-unknown-model"> · {t("usagePanelUnknownModel")}</span>
          )}
        </span>
      </footer>
    </div>
  );
}

function BreakdownChip({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "prompt" | "completion" | "cached" | "calls";
  hint?: string;
}) {
  return (
    <div className={"usage-chip usage-chip-" + tone} title={hint || undefined}>
      <span className="usage-chip-label">{label}</span>
      <span className="usage-chip-value tabular-nums">{value}</span>
    </div>
  );
}
