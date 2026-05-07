import { useMemo } from "react";
import { useAppStore } from "../../../store/appStore";
import { t } from "../../../utils/i18n";
import type { WorkOverview, WorkQuality } from "../../../services/workOverview";

interface Props {
  overview: WorkOverview | null;
  quality: WorkQuality | null;
  overviewUnavailable: boolean;
  qualityUnavailable: boolean;
}

type Tone = "ok" | "warn" | "danger" | "neutral";
type RecommendationKind =
  | "stabilize"
  | "verification"
  | "automation"
  | "observability"
  | "throughput"
  | "qualityCommand"
  | "next";

interface EvolutionMetric {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}

interface Recommendation {
  kind: RecommendationKind;
  title: string;
  detail: string;
  tone: Tone;
}

function pct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function qualityRate(quality: WorkQuality | null): {
  latest: number | null;
  delta: number | null;
  samples: number;
} {
  const buckets =
    quality?.verification_pass_rate_by_day
      .map((b) => {
        const samples = b.passed + b.failed + b.needs_review;
        return {
          samples,
          rate: samples > 0 ? b.passed / samples : null,
        };
      })
      .filter((b) => b.rate !== null) ?? [];
  const first = buckets[0]?.rate ?? null;
  const latest = buckets[buckets.length - 1]?.rate ?? null;
  return {
    latest,
    delta: first !== null && latest !== null ? latest - first : null,
    samples: buckets.reduce((sum, b) => sum + b.samples, 0),
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function HarnessEvolutionPanel({
  overview,
  quality,
  overviewUnavailable,
  qualityUnavailable,
}: Props) {
  const projects = useAppStore((s) => s.projects);
  const activeProjects = projects.filter((p) => !p.archived);
  const autoEnabled = activeProjects.filter(
    (p) => p.automation?.auto_mode_enabled ?? true,
  ).length;
  const automationCoverage =
    activeProjects.length > 0 ? autoEnabled / activeProjects.length : null;

  const failures = overview?.run_status_counts.failed ?? 0;
  const completed = overview?.run_status_counts.completed ?? 0;
  const running = overview?.running_now.length ?? 0;
  const blocked = overview?.blocked_requirements?.length ?? 0;
  const missingStores = overview?.missing_stores.length ?? 0;
  const throughput = overview?.throughput_by_day.reduce(
    (sum, d) => sum + d.runs_started,
    0,
  ) ?? 0;
  const topFail = quality?.top_failing_commands[0] ?? null;
  const q = qualityRate(quality);

  const evolutionScore = useMemo(() => {
    let score = 100;
    score -= Math.min(35, failures * 8);
    score -= Math.min(18, blocked * 6);
    if (q.latest !== null) score -= Math.max(0, 0.9 - q.latest) * 38;
    if (q.delta !== null && q.delta < 0) score -= Math.min(15, Math.abs(q.delta) * 60);
    if (automationCoverage !== null) score -= Math.max(0, 0.85 - automationCoverage) * 18;
    score -= Math.min(12, missingStores * 6);
    if (overviewUnavailable || qualityUnavailable) score -= 18;
    return clampScore(score);
  }, [
    automationCoverage,
    blocked,
    failures,
    missingStores,
    overviewUnavailable,
    q.delta,
    q.latest,
    qualityUnavailable,
  ]);

  const metrics: EvolutionMetric[] = [
    {
      label: t("harnessMetricScore"),
      value: String(evolutionScore),
      detail: t("harnessMetricScoreDetail"),
      tone: evolutionScore >= 80 ? "ok" : evolutionScore >= 60 ? "warn" : "danger",
    },
    {
      label: t("harnessMetricReliabilityDebt"),
      value: String(failures + blocked),
      detail: t("harnessMetricReliabilityDebtDetail", failures, blocked),
      tone: failures > 0 ? "danger" : blocked > 0 ? "warn" : "ok",
    },
    {
      label: t("harnessMetricVerification"),
      value: pct(q.latest),
      detail: t(
        "harnessMetricVerificationDetail",
        q.samples,
        q.delta === null ? "—" : `${q.delta > 0 ? "+" : ""}${Math.round(q.delta * 100)}%`,
      ),
      tone: q.latest === null ? "neutral" : q.latest >= 0.85 ? "ok" : q.latest >= 0.65 ? "warn" : "danger",
    },
    {
      label: t("harnessMetricAutomationCoverage"),
      value: pct(automationCoverage),
      detail: t("harnessMetricAutomationCoverageDetail", autoEnabled, activeProjects.length),
      tone:
        automationCoverage === null
          ? "neutral"
          : automationCoverage >= 0.85
            ? "ok"
            : automationCoverage >= 0.55
              ? "warn"
              : "danger",
    },
    {
      label: t("harnessMetricObservability"),
      value: missingStores === 0 ? t("harnessMetricReady") : String(missingStores),
      detail:
        missingStores === 0
          ? t("harnessMetricObservabilityReady")
          : t("harnessMetricObservabilityMissing", missingStores),
      tone: missingStores === 0 ? "ok" : "warn",
    },
    {
      label: t("harnessMetricThroughput"),
      value: String(throughput),
      detail: t("harnessMetricThroughputDetail", completed, running),
      tone: throughput > 0 ? "ok" : "neutral",
    },
  ];

  const recs: Recommendation[] = [];
  if (failures > 0) {
    recs.push({
      kind: "stabilize",
      title: t("harnessRecStabilizeTitle"),
      detail: t("harnessRecStabilizeDetail", failures),
      tone: "danger",
    });
  }
  if (q.latest !== null && q.latest < 0.85) {
    recs.push({
      kind: "verification",
      title: t("harnessRecVerificationTitle"),
      detail: t("harnessRecVerificationDetail", pct(q.latest)),
      tone: q.latest < 0.65 ? "danger" : "warn",
    });
  }
  if (topFail && topFail.fail_count > 0) {
    recs.push({
      kind: "qualityCommand",
      title: t("harnessRecCommandTitle"),
      detail: t("harnessRecCommandDetail", topFail.fail_count, topFail.command_normalized),
      tone: "warn",
    });
  }
  if (automationCoverage !== null && automationCoverage < 0.85) {
    recs.push({
      kind: "automation",
      title: t("harnessRecAutomationTitle"),
      detail: t("harnessRecAutomationDetail", autoEnabled, activeProjects.length),
      tone: "warn",
    });
  }
  if (missingStores > 0 || overviewUnavailable || qualityUnavailable) {
    recs.push({
      kind: "observability",
      title: t("harnessRecObservabilityTitle"),
      detail: t("harnessRecObservabilityDetail"),
      tone: "warn",
    });
  }
  if (throughput === 0 && activeProjects.length > 0) {
    recs.push({
      kind: "throughput",
      title: t("harnessRecThroughputTitle"),
      detail: t("harnessRecThroughputDetail"),
      tone: "neutral",
    });
  }
  if (recs.length === 0) {
    recs.push({
      kind: "next",
      title: t("harnessRecNextTitle"),
      detail: t("harnessRecNextDetail"),
      tone: "ok",
    });
  }

  return (
    <section className="harness-evolution" aria-label={t("harnessEvolutionTitle")}>
      <header className="harness-evolution-head">
        <div>
          <h3>{t("harnessEvolutionTitle")}</h3>
          <p>{t("harnessEvolutionSubtitle")}</p>
        </div>
      </header>

      <div className="harness-evolution-grid">
        {metrics.map((metric) => (
          <article key={metric.label} className={"harness-evolution-metric tone-" + metric.tone}>
            <span>{metric.label}</span>
            <strong className="tabular-nums">{metric.value}</strong>
            <p>{metric.detail}</p>
          </article>
        ))}
      </div>

      <div className="harness-evolution-recs">
        <div className="harness-evolution-section-label">
          {t("harnessEvolutionRecommendations")}
        </div>
        <ol>
          {recs.slice(0, 5).map((rec, idx) => (
            <li key={rec.kind} className={"tone-" + rec.tone}>
              <span className="harness-evolution-rank tabular-nums">
                {idx + 1}
              </span>
              <div>
                <strong>{rec.title}</strong>
                <p>{rec.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
