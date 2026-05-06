import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAppStore, type ProviderInfo } from "../store/appStore";
import { fetchServerInfo, type ServerInfoPayload } from "../services/serverInfo";
import { t } from "../utils/i18n";

type CapacitySource = "memory" | "model" | "unknown";

interface CapacityInfo {
  tokens: number | null;
  source: CapacitySource;
  model: string | null;
}

function selectedModel(providers: ProviderInfo[], routing: string | null): string | null {
  if (routing) {
    const [, model] = routing.split("|");
    return model || null;
  }
  return providers.find((p) => p.is_default)?.default_model || null;
}

function estimateContextWindow(model: string | null): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  const exact: Record<string, number> = {
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4.1": 1_047_576,
    "gpt-4.1-mini": 1_047_576,
    "gpt-4.1-nano": 1_047_576,
    "kimi-k2.6": 256_000,
    "kimi-for-coding": 128_000,
  };
  if (exact[m]) return exact[m];
  if (m.includes("gpt-5")) return 400_000;
  if (m.includes("gpt-4.1")) return 1_047_576;
  if (m.includes("gpt-4o")) return 128_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("kimi")) return 128_000;
  return null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function memoryCompressionLabel(info: ServerInfoPayload | null): string {
  const mode = info?.memory?.mode;
  if (mode === "summary") return t("contextCompressionSummary");
  if (mode === "window") return t("contextCompressionWindow");
  return t("contextCompressionOff");
}

function memoryCompressionDescription(info: ServerInfoPayload | null): string {
  const mode = info?.memory?.mode;
  if (mode === "summary" || mode === "window") {
    return t("contextCompressionAuto");
  }
  return t("contextCompressionDisabled");
}

function capacityInfo(
  info: ServerInfoPayload | null,
  providers: ProviderInfo[],
  routing: string | null,
): CapacityInfo {
  const memoryBudget = info?.memory?.budget_tokens;
  const model = selectedModel(providers, routing);
  if (typeof memoryBudget === "number" && memoryBudget > 0) {
    return { tokens: memoryBudget, source: "memory", model };
  }
  const estimated = estimateContextWindow(model);
  return { tokens: estimated, source: estimated ? "model" : "unknown", model };
}

export function ContextWindowBadge() {
  const usage = useAppStore((s) => s.usage);
  const providers = useAppStore((s) => s.providers);
  const routing = useAppStore((s) => s.routing);
  const [serverInfo, setServerInfo] = useState<ServerInfoPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchServerInfo().then((state) => {
      if (!cancelled && state.kind === "ready") setServerInfo(state.info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const info = useMemo(
    () => capacityInfo(serverInfo, providers, routing),
    [serverInfo, providers, routing],
  );
  const used = usage.prompt || 0;
  const pct =
    info.tokens && info.tokens > 0
      ? Math.max(0, Math.min(100, Math.round((used / info.tokens) * 100)))
      : 0;
  const sourceLabel =
    info.source === "memory"
      ? t("contextSourceMemory")
      : info.source === "model"
        ? t("contextSourceModel")
        : t("contextSourceUnknown");
  const compression = memoryCompressionLabel(serverInfo);
  const value = info.tokens ? formatTokens(info.tokens) : t("contextWindowUnknown");
  const ariaLabel = t(
    "contextWindowTitle",
    value,
    used ? formatTokens(used) : "0",
    sourceLabel,
    compression,
    info.model || t("serverDefault"),
  );
  const usedValue = used ? formatTokens(used) : "0";
  const compressionDescription = memoryCompressionDescription(serverInfo);
  const style = { "--context-pct": `${pct}%` } as CSSProperties;

  return (
    <span
      className="context-window-badge"
      style={style}
      aria-label={ariaLabel}
      tabIndex={0}
    >
      <span className="context-window-dot" aria-hidden="true" />
      <span className="context-window-tooltip" aria-hidden="true">
        <span className="context-window-tooltip-muted">
          {t("contextWindowPopupTitle")}
        </span>
        <strong>{t("contextWindowUsedPct", pct)}</strong>
        <span>{t("contextWindowUsedTotal", usedValue, value)}</span>
        <span>{compressionDescription}</span>
      </span>
    </span>
  );
}
