import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { t } from "../../../utils/i18n";
import {
  estimateCostUSD,
  subscribeUsageCumulator,
  totalsByModelForWindow,
  type ModelWindowTotals,
} from "../../../services/usageCumulator";
import type { WindowDays } from "../../../services/workOverview";

interface Props {
  windowDays: WindowDays;
}

interface ModelScoreRow extends ModelWindowTotals {
  cost: number | null;
  avgTokens: number;
  costPerCall: number | null;
  costEfficiency: number;
  tokenEfficiency: number;
  cacheUse: number;
  outputBalance: number;
  confidence: number;
  score: number;
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
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function scoreStyle(score: number): CSSProperties & { "--model-score": string } {
  return { "--model-score": `${score}%` };
}

export function ModelComparisonPanel({ windowDays }: Props) {
  const [, force] = useState(0);
  useEffect(() => subscribeUsageCumulator(() => force((n) => n + 1)), []);

  const rows = useMemo<ModelScoreRow[]>(() => {
    const totals = totalsByModelForWindow(windowDays);
    const enriched = totals.map((row) => {
      const cost = estimateCostUSD(row.model, row);
      const avgTokens = row.calls > 0 ? Math.round(row.total / row.calls) : 0;
      return {
        ...row,
        cost,
        avgTokens,
        costPerCall: cost !== null && row.calls > 0 ? cost / row.calls : null,
      };
    });
    const knownCosts = enriched
      .map((row) => row.costPerCall)
      .filter((cost): cost is number => cost !== null && cost > 0);
    const minCostPerCall = Math.min(...knownCosts);
    const maxCostPerCall = Math.max(...knownCosts, 0);
    const maxAvgTokens = Math.max(...enriched.map((row) => row.avgTokens), 0);

    return enriched
      .map((row) => {
        const costEfficiency =
          row.costPerCall === null || maxCostPerCall <= 0
            ? 0.55
            : maxCostPerCall === minCostPerCall
              ? 0.85
              : 1 - (row.costPerCall - minCostPerCall) / (maxCostPerCall - minCostPerCall);
        const tokenEfficiency =
          maxAvgTokens <= 0 ? 0.5 : 1 - row.avgTokens / maxAvgTokens;
        const cacheUse = row.prompt > 0 ? row.cached / row.prompt : 0;
        const outputRatio = row.total > 0 ? row.completion / row.total : 0;
        const outputBalance = 1 - Math.min(1, Math.abs(outputRatio - 0.34) / 0.34);
        const confidence = clamp01(row.calls / 8);
        const score = Math.round(
          (0.34 * clamp01(costEfficiency) +
            0.24 * clamp01(tokenEfficiency) +
            0.16 * clamp01(cacheUse) +
            0.16 * clamp01(outputBalance) +
            0.1 * confidence) *
            100,
        );

        return {
          ...row,
          costEfficiency: clamp01(costEfficiency),
          tokenEfficiency: clamp01(tokenEfficiency),
          cacheUse: clamp01(cacheUse),
          outputBalance: clamp01(outputBalance),
          confidence,
          score,
        };
      })
      .sort((a, b) => b.score - a.score || b.calls - a.calls || a.model.localeCompare(b.model));
  }, [windowDays]);

  const leader = rows[0] ?? null;
  const strongestSignal = rows.reduce<ModelScoreRow | null>(
    (best, row) => (best === null || row.confidence > best.confidence ? row : best),
    null,
  );

  return (
    <div className="work-panel model-score-panel">
      <header className="work-panel-header">
        <h3>{t("modelScoreTitle")}</h3>
        <span className="work-panel-header-meta">
          {t("modelScoreWindow", windowDays)}
        </span>
      </header>

      {rows.length === 0 ? (
        <div className="work-panel-empty">{t("modelScoreNoData")}</div>
      ) : (
        <>
          <div className="model-score-summary">
            <div>
              <span>{t("modelScoreBest")}</span>
              <strong title={leader?.model}>
                {leader ? `${leader.score}` : "—"}
              </strong>
            </div>
            <div>
              <span>{t("modelScoreConfidence")}</span>
              <strong title={strongestSignal?.model ?? undefined}>
                {strongestSignal ? pct(strongestSignal.confidence) : "—"}
              </strong>
            </div>
          </div>

          <div className="model-score-list" role="table" aria-label={t("modelScoreTitle")}>
            <div className="model-score-row model-score-row-head" role="row">
              <span role="columnheader">{t("modelScoreModel")}</span>
              <span role="columnheader">{t("modelScoreScore")}</span>
              <span role="columnheader">{t("modelScoreSignals")}</span>
            </div>
            {rows.slice(0, 6).map((row) => (
              <div className="model-score-row" role="row" key={row.model}>
                <div className="model-score-name-cell" role="cell">
                  <strong title={row.model}>{row.model}</strong>
                  <span>
                    {t("modelScoreUsageLine", row.calls, fmtTokens(row.total), fmtCost(row.costPerCall))}
                  </span>
                </div>
                <div className="model-score-value-cell" role="cell">
                  <strong className="tabular-nums">{row.score}</strong>
                  <span
                    className="model-score-bar"
                    style={scoreStyle(row.score)}
                    aria-hidden="true"
                  />
                </div>
                <div className="model-score-signals" role="cell">
                  <span>{t("modelScoreCostEfficiency", pct(row.costEfficiency))}</span>
                  <span>{t("modelScoreTokenEfficiency", pct(row.tokenEfficiency))}</span>
                  <span>{t("modelScoreCacheUse", pct(row.cacheUse))}</span>
                  <span>{t("modelScoreOutputBalance", pct(row.outputBalance))}</span>
                </div>
              </div>
            ))}
          </div>

          <footer className="model-score-note">
            {t("modelScoreNote")}
          </footer>
        </>
      )}
    </div>
  );
}
