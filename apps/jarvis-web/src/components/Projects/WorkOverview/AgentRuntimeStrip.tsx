import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../../../utils/i18n";
import type { AutoModeStatus } from "../../../services/autoMode";

interface Props {
  status: AutoModeStatus | null;
}

type Tone = "ok" | "warn" | "danger" | "neutral";

interface RuntimeCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
  icon: ReactNode;
  /// Lines rendered behind the small `i` info icon — meaning,
  /// formula, interpretation. Mirrors the optimisation-metric
  /// tooltip pattern in HealthCenter so the dashboard reads as
  /// one consistent surface.
  formulaLines?: string[];
}

function FormulaHint({ lines }: { lines: string[] }) {
  return (
    <span className="harness-formula-hint">
      <button
        type="button"
        aria-label={t("harnessMetricFormulaLabel")}
        title={t("harnessMetricFormulaLabel")}
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

function RuntimeCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  formulaLines,
}: RuntimeCardProps) {
  const className = ["work-kpi-card", `work-kpi-card-${tone}`].join(" ");
  return (
    <div className={className}>
      <div className="work-kpi-card-head">
        <span className="work-kpi-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="work-kpi-label harness-metric-label-with-hint">
          {label}
          {formulaLines && formulaLines.length > 0 && (
            <FormulaHint lines={formulaLines} />
          )}
        </span>
      </div>
      <div className="work-kpi-value tabular-nums">{value}</div>
      {hint && <div className="work-kpi-hint">{hint}</div>}
    </div>
  );
}

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const HeartbeatIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);
const InFlightIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polygon points="3 11 22 2 13 21 11 13 3 11" />
  </svg>
);
const CadenceIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15 14" />
  </svg>
);
const BurstIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polyline points="3 17 9 11 13 15 21 7" />
    <polyline points="14 7 21 7 21 14" />
  </svg>
);
const RetryIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);
const TimeoutIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <circle cx="12" cy="13" r="8" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="2" x2="12" y2="4" />
    <line x1="9" y1="2" x2="15" y2="2" />
  </svg>
);

function relTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return t("runtimeHeartbeatNever");
  const ms = nowMs - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return t("runtimeRelJustNow");
  if (ms < 5_000) return t("runtimeRelJustNow");
  if (ms < 60_000) return t("runtimeRelSeconds", Math.floor(ms / 1000));
  if (ms < 3_600_000) return t("runtimeRelMinutes", Math.floor(ms / 60_000));
  return t("runtimeRelHours", Math.floor(ms / 3_600_000));
}

function heartbeatTone(
  lastTickIso: string | null | undefined,
  tickSeconds: number | undefined,
  enabled: boolean,
  nowMs: number,
): { tone: Tone; multiplier: number | null } {
  if (!enabled) return { tone: "neutral", multiplier: null };
  if (!lastTickIso || !tickSeconds || tickSeconds <= 0) {
    return { tone: "danger", multiplier: null };
  }
  const ageMs = nowMs - Date.parse(lastTickIso);
  if (Number.isNaN(ageMs) || ageMs < 0) return { tone: "ok", multiplier: 0 };
  const mult = ageMs / (tickSeconds * 1000);
  if (mult < 1.5) return { tone: "ok", multiplier: mult };
  if (mult < 3) return { tone: "warn", multiplier: mult };
  return { tone: "danger", multiplier: mult };
}

export function AgentRuntimeStrip({ status }: Props) {
  // Refresh once a second so the heartbeat tile reflects elapsed time
  // without re-fetching the status payload. Same cadence as the
  // banner's freshness clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!status) {
    return (
      <div
        className="agent-runtime-strip is-loading"
        aria-label={t("runtimeStripTitle")}
      >
        <div className="agent-runtime-strip-head">
          <span className="agent-runtime-strip-title">
            {t("runtimeStripTitle")}
          </span>
          <span className="agent-runtime-strip-sub">…</span>
        </div>
      </div>
    );
  }

  if (!status.configured) {
    return (
      <div
        className="agent-runtime-strip is-unconfigured"
        aria-label={t("runtimeStripTitle")}
      >
        <div className="agent-runtime-strip-head">
          <span className="agent-runtime-strip-title">
            {t("runtimeStripTitle")}
          </span>
          <span className="agent-runtime-strip-sub agent-runtime-strip-sub-warn">
            {t("runtimeStripUnconfigured")}
          </span>
        </div>
      </div>
    );
  }

  const tickSeconds = status.tick_seconds;
  const cap = status.max_concurrent_units ?? 0;
  const permits = status.available_permits;
  const used = permits != null && cap > 0 ? Math.max(0, cap - permits) : null;
  const inFlightTone: Tone =
    used === null || cap === 0
      ? "neutral"
      : used >= cap
        ? "danger"
        : used / cap >= 0.8
          ? "warn"
          : "ok";

  const hb = heartbeatTone(status.last_tick_at, tickSeconds, status.enabled, now);
  const heartbeatValue = relTime(status.last_tick_at, now);
  let heartbeatHint: string;
  if (!status.enabled) {
    heartbeatHint = t("runtimeStatHeartbeatPausedDetail");
  } else if (hb.tone === "ok") {
    heartbeatHint = tickSeconds
      ? t("runtimeStatHeartbeatFreshDetail", t("runtimeEverySeconds", tickSeconds))
      : t("runtimeStatHeartbeatFreshDetail", "—");
  } else if (hb.multiplier != null) {
    heartbeatHint = t(
      "runtimeStatHeartbeatStaleDetail",
      hb.multiplier.toFixed(1),
    );
  } else {
    heartbeatHint = t("runtimeStatHeartbeatNever");
  }

  const cadenceValue = tickSeconds
    ? t("runtimeEverySeconds", tickSeconds)
    : "—";
  const burstValue =
    status.max_units_per_tick != null ? String(status.max_units_per_tick) : "—";
  const retriesValue =
    status.max_retries != null ? String(status.max_retries) : "—";
  const timeoutValue =
    status.run_timeout_ms != null
      ? `${Math.round(status.run_timeout_ms / 1000)}s`
      : "—";

  return (
    <div className="agent-runtime-strip" aria-label={t("runtimeStripTitle")}>
      <div className="agent-runtime-strip-head">
        <span className="agent-runtime-strip-title">
          {t("runtimeStripTitle")}
        </span>
        <span className="agent-runtime-strip-sub">
          {status.enabled
            ? t("runtimeStripSubtitle")
            : `${t("runtimeStripSubtitle")} · ${t("runtimeStripPaused")}`}
        </span>
      </div>
      <div className="work-kpi-strip agent-runtime-strip-grid">
        <RuntimeCard
          label={t("runtimeStatHeartbeat")}
          value={heartbeatValue}
          hint={heartbeatHint}
          tone={hb.tone}
          icon={<HeartbeatIcon />}
          formulaLines={[
            t("runtimeHintHeartbeatMeaning"),
            t("runtimeHintHeartbeatFormula"),
            t("runtimeHintHeartbeatInterpretation"),
          ]}
        />
        <RuntimeCard
          label={t("runtimeStatInFlight")}
          value={used === null ? "—" : `${used}/${cap}`}
          hint={
            used !== null && used >= cap && cap > 0
              ? t("runtimeStatInFlightSaturatedDetail", cap)
              : used !== null
                ? t("runtimeStatInFlightDetail", used, cap)
                : undefined
          }
          tone={inFlightTone}
          icon={<InFlightIcon />}
          formulaLines={[
            t("runtimeHintInFlightMeaning"),
            t("runtimeHintInFlightFormula"),
            t("runtimeHintInFlightInterpretation"),
          ]}
        />
        <RuntimeCard
          label={t("runtimeStatTickCadence")}
          value={cadenceValue}
          hint={t("runtimeStatTickCadenceDetail")}
          icon={<CadenceIcon />}
          formulaLines={[
            t("runtimeHintTickCadenceMeaning"),
            t("runtimeHintTickCadenceFormula"),
            t("runtimeHintTickCadenceInterpretation"),
          ]}
        />
        <RuntimeCard
          label={t("runtimeStatBurst")}
          value={burstValue}
          hint={
            status.max_units_per_tick != null
              ? t("runtimeStatBurstDetail", status.max_units_per_tick)
              : undefined
          }
          icon={<BurstIcon />}
          formulaLines={[
            t("runtimeHintBurstMeaning"),
            t("runtimeHintBurstFormula"),
            t("runtimeHintBurstInterpretation"),
          ]}
        />
        <RuntimeCard
          label={t("runtimeStatRetries")}
          value={retriesValue}
          hint={
            status.max_retries != null
              ? t("runtimeStatRetriesDetail", status.max_retries)
              : undefined
          }
          icon={<RetryIcon />}
          formulaLines={[
            t("runtimeHintRetriesMeaning"),
            t("runtimeHintRetriesFormula"),
            t("runtimeHintRetriesInterpretation"),
          ]}
        />
        <RuntimeCard
          label={t("runtimeStatRunTimeout")}
          value={timeoutValue}
          hint={t("runtimeStatRunTimeoutDetail")}
          icon={<TimeoutIcon />}
          formulaLines={[
            t("runtimeHintRunTimeoutMeaning"),
            t("runtimeHintRunTimeoutFormula"),
            t("runtimeHintRunTimeoutInterpretation"),
          ]}
        />
      </div>
    </div>
  );
}
