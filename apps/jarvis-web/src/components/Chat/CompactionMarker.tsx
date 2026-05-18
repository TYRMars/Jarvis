// Inline marker rendered in the chat transcript when the memory
// backend compacted earlier turns out of the next request.
//
// Mirrors the visual weight of `<CollapsedToolGroup>` so it doesn't
// look like a real assistant turn — the user's eye should skim
// over it unless they want to investigate. The disclosure shows a
// few quick metrics (chars, estimated tokens) that map back to the
// 10-counter view in Settings → Diagnostics → Memory.
//
// Source priority:
// - PtlRound{One,Two}: a budget escape hatch fired
// - Cache{Memory,Store}: cheap path — we paid for this once
// - FreshLlm: real summary call this iteration
// - SummaryUnavailable: circuit open / LLM error — degraded
// - WindowDropped: SlidingWindowMemory dropped without LLM
// - NoOp: filtered out by MessageList; never reaches this component

import { useState } from "react";
import type { CompactionMarker as CompactionMarkerData } from "../../store/slices/memorySlice";
import { t } from "../../utils/i18n";

interface Props {
  marker: CompactionMarkerData;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "cache_memory":
      return t("compactionSourceCacheMemory") || "cache hit";
    case "cache_store":
      return t("compactionSourceCacheStore") || "cache hit (store)";
    case "fresh_llm":
      return t("compactionSourceFreshLlm") || "fresh summary";
    case "ptl_round_one":
      return t("compactionSourcePtlRoundOne") || "fallback prune";
    case "ptl_round_two":
      return t("compactionSourcePtlRoundTwo") || "fallback prune (round 2)";
    case "window_dropped":
      return t("compactionSourceWindowDropped") || "window pruned";
    case "summary_unavailable":
      return t("compactionSourceSummaryUnavailable") || "summary unavailable";
    default:
      return source;
  }
}

function sourceTone(source: string): "info" | "warn" {
  return source === "summary_unavailable" ||
    source === "ptl_round_one" ||
    source === "ptl_round_two"
    ? "warn"
    : "info";
}

export function CompactionMarker({ marker }: Props) {
  const [open, setOpen] = useState(false);
  const headline =
    marker.turnsDropped > 0
      ? `${marker.turnsDropped} ${marker.turnsDropped === 1 ? "turn" : "turns"} summarized`
      : `compaction · ${sourceLabel(marker.source)}`;
  const tone = sourceTone(marker.source);
  return (
    <div className="compaction-marker" data-tone={tone}>
      <button
        type="button"
        className="compaction-marker-row"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide details" : "Show details"}
      >
        <span className="compaction-marker-icon" aria-hidden="true">⊟</span>
        <span className="compaction-marker-summary">
          Earlier history compacted · {headline}
        </span>
        <span className="compaction-marker-source">{sourceLabel(marker.source)}</span>
      </button>
      {open ? (
        <dl className="compaction-marker-detail">
          <div>
            <dt>turns kept</dt>
            <dd>{marker.turnsKept}</dd>
          </div>
          <div>
            <dt>turns dropped</dt>
            <dd>{marker.turnsDropped}</dd>
          </div>
          {typeof marker.summaryChars === "number" ? (
            <div>
              <dt>summary chars</dt>
              <dd>{marker.summaryChars}</dd>
            </div>
          ) : null}
          {typeof marker.workingContextChars === "number" ? (
            <div>
              <dt>working ctx chars</dt>
              <dd>{marker.workingContextChars}</dd>
            </div>
          ) : null}
          <div>
            <dt>est input tokens</dt>
            <dd>~{marker.modelInputTokensEst}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
