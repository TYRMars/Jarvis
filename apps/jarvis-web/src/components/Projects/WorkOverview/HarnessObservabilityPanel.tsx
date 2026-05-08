import { useEffect, useMemo, useState } from "react";
import { t } from "../../../utils/i18n";
import {
  fetchEvalCases,
  fetchHarnessDirection,
  fetchObservabilityDashboard,
  fetchSubagentSummary,
  fetchToolSummary,
  type EvalCaseResult,
  type HarnessDirectionSnapshot,
  type HarnessObservabilityDashboard,
  type ObservedRunSummary,
  type WindowDays,
} from "../../../services/workOverview";

interface Props {
  windowDays: WindowDays;
}

interface HarnessObsState {
  dashboard: HarnessObservabilityDashboard | null;
  tools: ObservedRunSummary[] | null;
  subagents: ObservedRunSummary[] | null;
  cases: EvalCaseResult[] | null;
  direction: HarnessDirectionSnapshot | null;
  loading: boolean;
  error: string | null;
}

type Tone = "ok" | "warn" | "danger" | "neutral";

function pct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function fmtMs(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function fmtBytes(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function toneFromRate(rate: number | null): Tone {
  if (rate === null) return "neutral";
  if (rate >= 0.9) return "ok";
  if (rate >= 0.75) return "warn";
  return "danger";
}

function evalPassRate(cases: EvalCaseResult[] | null): number | null {
  if (!cases || cases.length === 0) return null;
  const passed = cases.filter((c) => c.outcome === "success").length;
  return passed / cases.length;
}

function latestEvalSuite(cases: EvalCaseResult[] | null): string {
  return cases?.[0]?.suite ?? "-";
}

function recTitle(rec: { key: string; title: string }): string {
  const key = `harnessObsRec_${rec.key}_title`;
  const translated = t(key);
  return translated === key ? rec.title : translated;
}

function recDetail(rec: { key: string; detail: string }): string {
  const key = `harnessObsRec_${rec.key}_detail`;
  const translated = t(key);
  return translated === key ? rec.detail : translated;
}

interface SummaryListProps {
  title: string;
  empty: string;
  rows: ObservedRunSummary[] | null;
  secondary: "output" | "delegation";
}

function SummaryList({ title, empty, rows, secondary }: SummaryListProps) {
  const topRows = rows?.slice(0, 5) ?? [];
  return (
    <div className="harness-obs-list">
      <div className="harness-obs-list-head">
        <strong>{title}</strong>
        <span>{t("harnessObsRuns")}</span>
        <span>{t("harnessObsSuccess")}</span>
        <span>{secondary === "output" ? t("harnessObsOutput") : t("harnessObsDelegation")}</span>
      </div>
      {topRows.length === 0 ? (
        <div className="work-panel-empty">{empty}</div>
      ) : (
        topRows.map((row) => (
          <div className="harness-obs-row" key={row.name}>
            <div className="harness-obs-name" title={row.name}>
              {row.name}
            </div>
            <span className="tabular-nums">{row.runs}</span>
            <span className={"tabular-nums tone-" + toneFromRate(row.success_rate)}>
              {pct(row.success_rate)}
            </span>
            <span className="tabular-nums">
              {secondary === "output"
                ? fmtBytes(row.avg_output_bytes)
                : (row.avg_tool_calls ?? row.avg_frames ?? null)?.toFixed(1) ?? "-"}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export function HarnessObservabilityPanel({ windowDays }: Props) {
  const [state, setState] = useState<HarnessObsState>({
    dashboard: null,
    tools: null,
    subagents: null,
    cases: null,
    direction: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    Promise.all([
      fetchObservabilityDashboard(windowDays),
      fetchToolSummary(),
      fetchSubagentSummary(),
      fetchEvalCases(),
      fetchHarnessDirection(),
    ])
      .then(([dashboard, tools, subagents, cases, direction]) => {
        if (cancelled) return;
        setState({
          dashboard,
          tools,
          subagents,
          cases,
          direction,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const evalRate = useMemo(() => evalPassRate(state.cases), [state.cases]);
  const hasData =
    !!state.dashboard ||
    !!state.tools?.length ||
    !!state.subagents?.length ||
    !!state.cases?.length ||
    !!state.direction;
  const unavailable =
    !state.loading && !state.error && !state.dashboard && !state.tools && !state.subagents;

  const metrics = [
    {
      label: t("harnessObsMetricDirection"),
      value: state.direction ? String(state.direction.score) : "-",
      detail: t(
        "harnessObsMetricDirectionDetail",
        t(`harnessObsFocus_${state.direction?.primary_focus ?? "observability"}`),
      ),
      tone:
        state.direction === null
          ? "neutral"
          : state.direction.score >= 80
            ? "ok"
            : state.direction.score >= 60
              ? "warn"
              : "danger",
    },
    {
      label: t("harnessObsMetricSuccess"),
      value: pct(state.dashboard?.run_success_rate ?? null),
      detail: t(
        "harnessObsMetricSuccessDetail",
        state.dashboard?.successful_runs ?? 0,
        state.dashboard?.failed_runs ?? 0,
      ),
      tone: toneFromRate(state.dashboard?.run_success_rate ?? null),
    },
    {
      label: t("harnessObsMetricLatency"),
      value: fmtMs(state.dashboard?.p95_latency_ms ?? null),
      detail: t("harnessObsMetricLatencyDetail"),
      tone:
        state.dashboard?.p95_latency_ms === null || state.dashboard?.p95_latency_ms === undefined
          ? "neutral"
          : state.dashboard.p95_latency_ms < 15_000
            ? "ok"
            : state.dashboard.p95_latency_ms < 45_000
              ? "warn"
              : "danger",
    },
    {
      label: t("harnessObsMetricEval"),
      value: pct(evalRate),
      detail: t("harnessObsMetricEvalDetail", latestEvalSuite(state.cases)),
      tone: toneFromRate(evalRate),
    },
  ];

  return (
    <section className="harness-observability" aria-label={t("harnessObsTitle")}>
      <header className="harness-observability-head">
        <div>
          <h3>{t("harnessObsTitle")}</h3>
          <p>{t("harnessObsSubtitle")}</p>
        </div>
        <span className="work-panel-header-meta">
          {t("harnessObsWindow", windowDays)}
        </span>
      </header>

      {state.error && (
        <div className="work-overview-banner work-overview-banner-error">
          {t("workOverviewError", state.error)}
        </div>
      )}

      {unavailable && (
        <div className="work-overview-banner">
          {t("harnessObsUnavailable")}
        </div>
      )}

      <div className="harness-obs-metrics">
        {metrics.map((metric) => (
          <article key={metric.label} className={"harness-obs-metric tone-" + metric.tone}>
            <span>{metric.label}</span>
            <strong className="tabular-nums">{state.loading ? "..." : metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
      </div>

      {state.direction && (
        <div className="harness-direction">
          <div className="harness-direction-components">
            {state.direction.components.map((component) => (
              <div className="harness-direction-component" key={component.key}>
                <div className="harness-direction-component-head">
                  <span>{t(`harnessObsComponent_${component.key}`)}</span>
                  <strong className="tabular-nums">{component.score}</strong>
                </div>
                <div className="harness-direction-bar" aria-hidden="true">
                  <span style={{ width: `${component.score}%` }} />
                </div>
              </div>
            ))}
          </div>

          <div className="harness-direction-recs">
            <div className="harness-evolution-section-label">
              {t("harnessObsRecommendations")}
            </div>
            <ol>
              {state.direction.recommendations.map((rec) => (
                <li key={rec.key} className={"tone-" + rec.tone}>
                  <span className="harness-evolution-rank tabular-nums">
                    {rec.priority}
                  </span>
                  <div>
                    <strong>{recTitle(rec)}</strong>
                    <p>{recDetail(rec)}</p>
                    {rec.metric && <em>{rec.metric}</em>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {!state.loading && !hasData && !state.error && !unavailable ? (
        <div className="work-panel-empty">{t("harnessObsNoData")}</div>
      ) : (
        <div className="harness-obs-grid">
          <SummaryList
            title={t("harnessObsToolsTitle")}
            empty={t("harnessObsNoTools")}
            rows={state.tools}
            secondary="output"
          />
          <SummaryList
            title={t("harnessObsSubagentsTitle")}
            empty={t("harnessObsNoSubagents")}
            rows={state.subagents}
            secondary="delegation"
          />
        </div>
      )}
    </section>
  );
}
