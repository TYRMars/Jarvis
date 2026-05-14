import { useEffect, useMemo, useState } from "react";
import { t } from "../../../utils/i18n";
import {
  fetchEvalCases,
  fetchEvalSummary,
  fetchHarnessCapabilityScore,
  fetchHarnessDirection,
  fetchObservabilityDashboard,
  fetchSubagentSummary,
  fetchTelemetryExporter,
  fetchToolSummary,
  type EvalCaseResult,
  type EvalSummarySnapshot,
  type HarnessCapabilityScoreSnapshot,
  type HarnessDirectionSnapshot,
  type HarnessObservabilityDashboard,
  type ObservedRunSummary,
  type TelemetryExporterStatus,
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
  evalSummary: EvalSummarySnapshot | null;
  direction: HarnessDirectionSnapshot | null;
  capability: HarnessCapabilityScoreSnapshot | null;
  exporter: TelemetryExporterStatus | null;
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

function toneFromScore(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 80) return "ok";
  if (score >= 60) return "warn";
  return "danger";
}

function capabilityLabel(key: string, fallback: string): string {
  const translated = t(`harnessCapability_${key}`);
  return translated === `harnessCapability_${key}` ? fallback : translated;
}

function driverLabel(key: string, fallback: string): string {
  const translated = t(`harnessCapabilityDriver_${key}`);
  return translated === `harnessCapabilityDriver_${key}` ? fallback : translated;
}

function confidenceLabel(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  if (value >= 0.75) return t("harnessCapabilityConfidenceHigh");
  if (value >= 0.45) return t("harnessCapabilityConfidenceMedium");
  return t("harnessCapabilityConfidenceLow");
}

function FormulaHint({ label, lines }: { label: string; lines: string[] }) {
  return (
    <span className="harness-formula-hint">
      <button
        type="button"
        aria-label={label}
        title={label}
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
      <FormulaHint label={t("harnessMetricFormulaLabel")} lines={lines} />
    </span>
  );
}

function evalPassRate(cases: EvalCaseResult[] | null): number | null {
  if (!cases || cases.length === 0) return null;
  const passed = cases.filter((c) => c.outcome === "success").length;
  return passed / cases.length;
}

function latestEvalSuite(cases: EvalCaseResult[] | null): string {
  return cases?.[0]?.suite ?? "-";
}

function countKeys(row: Record<string, number> | null | undefined): string {
  if (!row) return "-";
  const total = Object.values(row).reduce((sum, n) => sum + n, 0);
  return total > 0 ? String(total) : "-";
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

export function HarnessObservabilityPanel({
  windowDays,
}: Props) {
  const [state, setState] = useState<HarnessObsState>({
    dashboard: null,
    tools: null,
    subagents: null,
    cases: null,
    evalSummary: null,
    direction: null,
    capability: null,
    exporter: null,
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
      fetchEvalSummary(),
      fetchHarnessDirection(),
      fetchHarnessCapabilityScore(),
      fetchTelemetryExporter(),
    ])
      .then(([dashboard, tools, subagents, cases, evalSummary, direction, capability, exporter]) => {
        if (cancelled) return;
        setState({
          dashboard,
          tools,
          subagents,
          cases,
          evalSummary,
          direction,
          capability,
          exporter,
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
    !!state.evalSummary ||
    !!state.direction ||
    !!state.capability;
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
      hint: [
        t("harnessObsMetricDirectionHintFormula"),
        t("harnessObsMetricDirectionHintFocus"),
      ],
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
      hint: [t("harnessObsMetricSuccessHint")],
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
      hint: [t("harnessObsMetricLatencyHint")],
    },
    {
      label: t("harnessObsMetricEval"),
      value: pct(evalRate),
      detail: t("harnessObsMetricEvalDetail", latestEvalSuite(state.cases)),
      tone: toneFromRate(evalRate),
      hint: [t("harnessObsMetricEvalHint")],
    },
  ];

  const overallFormulaLines = state.capability
    ? [
        t("harnessCapabilityOverallFormula"),
        t("harnessCapabilityDeliveryCapFormula"),
        t(
          "harnessCapabilityConfidenceFormula",
          state.capability.sample_count,
          pct(state.capability.confidence),
        ),
      ]
    : [];

  return (
    <section className="harness-observability" aria-label={t("harnessObsTitle")}>
      <header className="harness-observability-head">
        <div>
          <h3>{t("harnessObsTitle")}</h3>
          <p>{t("harnessObsSubtitle")}</p>
        </div>
        <div className="harness-observability-head-meta">
          {state.exporter && (
            <span
              className={
                "harness-otel-chip " +
                (state.exporter.enabled ? "harness-otel-chip-on" : "harness-otel-chip-off")
              }
              title={
                state.exporter.enabled
                  ? `OTLP ${state.exporter.protocol ?? "grpc"} → ${state.exporter.endpoint ?? ""} (service.name=${state.exporter.service_name}, env=${state.exporter.service_env}, sample=${state.exporter.sample_ratio})`
                  : "Set JARVIS_OTEL_ENABLED=1 and start a collector at JARVIS_OTEL_ENDPOINT to enable OTLP export."
              }
            >
              <span className="harness-otel-chip-dot" aria-hidden="true" />
              OTLP: {state.exporter.enabled ? "on" : "off"}
            </span>
          )}
          <span className="work-panel-header-meta">
            {t("harnessObsWindow", windowDays)}
          </span>
        </div>
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
            <LabelWithHint label={metric.label} lines={metric.hint} />
            <strong className="tabular-nums">{state.loading ? "..." : metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
      </div>

      {state.capability && (
        <div className="harness-capability-score">
          <div className="harness-capability-head">
            <div>
              <div className="harness-evolution-section-label">
                {t("harnessCapabilityTitle")}
              </div>
              <p>{t("harnessCapabilitySubtitle")}</p>
            </div>
            <div className={"harness-capability-overall tone-" + toneFromScore(state.capability.overall_score)}>
              <span className="harness-capability-label-with-hint">
                {t("harnessCapabilityOverall")}
                <FormulaHint
                  label={t("harnessCapabilityFormulaLabel")}
                  lines={overallFormulaLines}
                />
              </span>
              <strong className="tabular-nums">{state.capability.overall_score}</strong>
              <em>{confidenceLabel(state.capability.confidence)}</em>
            </div>
          </div>

          <div className="harness-capability-grid">
            {state.capability.dimensions.map((dimension) => {
              const primaryDriver = [...dimension.drivers].sort(
                (a, b) => b.weight - a.weight,
              )[0];
              const evidence = dimension.evidence[0] ?? null;
              const formulaLines = [
                t(
                  "harnessCapabilityDimensionFormula",
                  dimension.drivers
                    .map(
                      (driver) =>
                        `${driverLabel(driver.key, driver.label)} ${driver.score}×${Math.round(driver.weight * 100)}%`,
                    )
                    .join(" + "),
                ),
                t("harnessCapabilityMissingFormula"),
                t("harnessCapabilityDimensionConfidenceFormula"),
              ];
              return (
                <article
                  key={dimension.key}
                  className={"harness-capability-card tone-" + toneFromScore(dimension.score)}
                >
                  <div className="harness-capability-card-head">
                    <span className="harness-capability-label-with-hint">
                      {capabilityLabel(dimension.key, dimension.label)}
                      <FormulaHint
                        label={t("harnessCapabilityFormulaLabel")}
                        lines={formulaLines}
                      />
                    </span>
                    <strong className="tabular-nums">{dimension.score}</strong>
                  </div>
                  <p>{t(`harnessCapabilitySummary_${dimension.key}`)}</p>
                  <div className="harness-capability-driver">
                    <span>{t("harnessCapabilityPrimaryDriver")}</span>
                    <strong>
                      {primaryDriver
                        ? `${driverLabel(primaryDriver.key, primaryDriver.label)}: ${primaryDriver.score}`
                        : "-"}
                    </strong>
                  </div>
                  <div className="harness-capability-confidence">
                    {t("harnessCapabilityConfidence", confidenceLabel(dimension.confidence))}
                  </div>
                  {evidence ? (
                    <div className={"harness-capability-evidence tone-" + evidence.tone}>
                      <span>{t("harnessCapabilityEvidence")}</span>
                      <strong title={evidence.title}>{evidence.title}</strong>
                      <p>{evidence.detail}</p>
                      {evidence.metric && <em>{evidence.metric}</em>}
                    </div>
                  ) : (
                    <div className="harness-capability-evidence tone-neutral">
                      {t("harnessCapabilityNoEvidence")}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {state.evalSummary && (
        <div className="harness-eval-maturity">
          <div className="harness-evolution-section-label">
            {t("harnessObsEvalMaturity")}
          </div>
          <div className="harness-eval-maturity-grid">
            <div>
              <LabelWithHint
                label={t("harnessObsEvalCapability")}
                lines={[t("harnessObsEvalCapabilityHint")]}
              />
              <strong className="tabular-nums">
                {pct(state.evalSummary.capability_pass_rate)}
              </strong>
            </div>
            <div>
              <LabelWithHint
                label={t("harnessObsEvalRegression")}
                lines={[t("harnessObsEvalRegressionHint")]}
              />
              <strong className="tabular-nums">
                {pct(state.evalSummary.regression_pass_rate)}
              </strong>
            </div>
            <div>
              <LabelWithHint
                label={t("harnessObsEvalPassAtK")}
                lines={[t("harnessObsEvalPassAtKHint")]}
              />
              <strong className="tabular-nums">
                {pct(state.evalSummary.trial_reliability.pass_at_k)}
              </strong>
            </div>
            <div>
              <LabelWithHint
                label={t("harnessObsEvalPassAll")}
                lines={[t("harnessObsEvalPassAllHint")]}
              />
              <strong className="tabular-nums">
                {pct(state.evalSummary.trial_reliability.pass_all)}
              </strong>
            </div>
            <div>
              <LabelWithHint
                label={t("harnessObsEvalGraders")}
                lines={[t("harnessObsEvalGradersHint")]}
              />
              <strong className="tabular-nums">
                {countKeys(state.evalSummary.by_grader_kind)}
              </strong>
            </div>
            <div>
              <LabelWithHint
                label={t("harnessObsEvalTranscripts")}
                lines={[t("harnessObsEvalTranscriptsHint")]}
              />
              <strong className="tabular-nums">
                {state.evalSummary.transcript_cases}/{state.evalSummary.total_cases}
              </strong>
            </div>
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

      {state.direction && (
        <div className="harness-diagnosis">
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
    </section>
  );
}
