// Folded card for a run of consecutive assistant iterations whose
// tool calls are all read-only (`fs.read`, `code.grep`, `git.*`,
// `workspace.context`, etc.) and whose visible content is empty.
//
// Without this fold, a long investigation loop (read → grep → read
// → grep → read → ... before finally writing a patch) bloats the
// transcript with 5–10 near-identical "Read 1 file" rows the user
// has to skim past. The fold collapses them into one summary like
// "Read 6 files, ran 3 greps (across 9 steps) ▸" with a click-to-
// expand that re-shows the original `AssistantBubble`s inline.
//
// The fold rule is enforced upstream in `<MessageList>`; this
// component just renders whatever it's handed. Folding is
// strictly opt-in by the upstream classifier — anything that
// touched a write/exec/mutating tool stays as its own bubble.

import { useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { AssistantBubble } from "./AssistantBubble";
import {
  aggregateStepStatus,
  describeStep,
} from "./toolStepSummary";
import { t } from "../../utils/i18n";
import type { UiMessage } from "../../store/types";

interface Props {
  /// Consecutive assistant `UiMessage`s being folded. Must each
  /// carry only read-only tool calls and no visible content —
  /// the classifier in `<MessageList>` is the source of truth for
  /// that invariant.
  messages: Array<Extract<UiMessage, { kind: "assistant" }>>;
}

export function CollapsedToolGroup({ messages }: Props) {
  // Same Zustand discipline as ToolStepRow: subscribe to the raw
  // map and derive the flat block list via useMemo so the selector
  // doesn't churn on every store snapshot.
  const allBlocks = useAppStore((s) => s.toolBlocks);
  const blocks = useMemo(() => {
    const flat = [];
    for (const m of messages) {
      for (const id of m.toolCallIds) {
        const b = allBlocks[id];
        if (b) flat.push(b);
      }
    }
    return flat;
  }, [messages, allBlocks]);

  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const status = aggregateStepStatus(blocks);
  // Auto-expand while anything in the run is still working so the
  // user sees live progress, mirroring `ToolStepRow`'s pattern.
  const defaultOpen = status === "running";
  const open = manualOpen ?? defaultOpen;

  if (blocks.length === 0) return null;
  const summary = describeStep(blocks);
  const badge =
    status === "ok" || status === "empty"
      ? null
      : (({
          running: t("running"),
          denied: t("denied", ""),
          error: t("error"),
        } as Record<string, string>)[status] || status);

  return (
    <div
      className="tool-step tool-step-grouped"
      data-status={status}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="tool-step-row"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        title={open ? t("toolStepCollapse") : t("toolStepExpand")}
      >
        <span className="tool-step-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="tool-step-summary">
          {summary}
          <span className="tool-step-step-count">
            {" "}· {t("chatMsgASteps", messages.length)}
          </span>
        </span>
        {badge ? <span className="tool-step-badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="tool-step-body tool-step-body-grouped">
          {messages.map((m, idx) => (
            <AssistantBubble
              key={m.uid}
              uid={m.uid}
              content={m.content}
              reasoning={m.reasoning}
              toolCallIds={m.toolCallIds}
              finalised={m.finalised}
              // First expanded child gets the full header; the
              // rest stack as continuations so the expanded list
              // reads as one logical run rather than N separate
              // "Jarvis" bubbles.
              continuation={idx > 0}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
