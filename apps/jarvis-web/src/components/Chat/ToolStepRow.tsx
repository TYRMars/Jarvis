// Coalesced "agent step" row — one line that summarises every tool
// call from a single LLM response. Modeled on the Claude Code
// transcript pattern:
//
//   ▸ Read 3 files, ran a command, edited workspace_diff.rs (+429 −0)
//
// Click anywhere on the row → expand to show the original
// `<ToolBlock>` for every tool call inline below. The inner
// ToolBlocks keep their own per-tool fold state + summary chip
// behaviour, so a power-user can drill from the step row into
// individual tool args / output without losing context.
//
// Auto-expand while ANY underlying tool is still running so the
// user sees live `tool_progress` chunks; once all settle, fall
// back to the user's last manual toggle (or collapsed default).

import { useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { ToolBlock } from "./ToolBlock";
import {
  aggregateStepStatus,
  describeStep,
} from "./toolStepSummary";
import { t } from "../../utils/i18n";

interface Props {
  toolCallIds: string[];
}

export function ToolStepRow({ toolCallIds }: Props) {
  // CRITICAL: subscribe to the raw `toolBlocks` map (a single
  // reference Zustand can compare with `Object.is`), then derive
  // the per-step list via `useMemo`. An inline selector that does
  // `.map(...).filter(...)` would return a brand-new array on every
  // store snapshot — Zustand v5 sees the new reference, triggers a
  // re-render, the selector runs again, returns yet another new
  // array, and React bails with "Maximum update depth exceeded"
  // (error #185).
  const allBlocks = useAppStore((s) => s.toolBlocks);
  const blocks = useMemo(
    () => toolCallIds.map((id) => allBlocks[id]).filter(Boolean),
    [toolCallIds, allBlocks],
  );
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  const status = aggregateStepStatus(blocks);
  const someRunning = status === "running";

  // Default open while any underlying tool is still running so live
  // progress is visible. Once everything settles, default closed
  // (the row's verb summary is enough at a glance). User toggle
  // always wins after the first click — sticky across status flips
  // within this turn so a row the user expanded mid-stream stays
  // expanded after the stream ends.
  const defaultOpen = someRunning;
  const open = manualOpen ?? defaultOpen;

  if (blocks.length === 0) return null;

  const summary = describeStep(blocks);
  // Mirror the per-tool badge policy in `ToolBlock`: success is the
  // default expectation, so we don't paint a green "Done" chip on
  // every settled step row — that crowds the timeline. Running /
  // denied / errored states still surface so the user notices
  // anything that needs attention.
  const badge =
    status === "ok" || status === "empty"
      ? null
      : (({
          running: t("running"),
          denied: t("denied", ""),
          error: t("error"),
        } as Record<string, string>)[status] || status);

  return (
    <div className="tool-step" data-status={status} data-open={open ? "true" : "false"}>
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
        <span className="tool-step-summary">{summary}</span>
        {badge ? <span className="tool-step-badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="tool-step-body">
          {/* `forceOpen` so each inner block auto-shows args + output
           * once the user has expanded the step row. The user already
           * said "show me details" by clicking the step; making them
           * click each tool's own chevron a second time is friction.
           * They can still individually collapse via that chevron. */}
          {blocks.map((b) => (
            <ToolBlock key={b.id} entry={b} forceOpen />
          ))}
        </div>
      ) : null}
    </div>
  );
}
