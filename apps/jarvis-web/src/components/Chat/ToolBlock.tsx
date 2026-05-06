// Generic collapsible tool block. Header shows name + status badge
// + duration / summary chips; the body delegates rendering of the
// args and output sections to `toolRenderers/`.
//
// Toggling opens/closes the body via `useState`. Tools that stream
// progress (`shell.exec` line-by-line) push `tool_progress` frames
// before `tool_end` lands. While the call is `running` and
// `progress` has bytes, the body opens automatically and renders
// the live scroll-back; once `output` arrives the formatted summary
// takes over.

import { useMemo, useState } from "react";
import type { ToolBlockEntry } from "../../store/appStore";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { DecisionSourceChip } from "../Approvals/DecisionSourceChip";
import { SubAgentCard } from "../SubAgent/SubAgentCard";
import type { SubAgentRun } from "../SubAgent/types";
import {
  APPROVAL_GATED_TOOLS,
  SUMMARISABLE_TOOLS,
  summarise,
} from "./toolSummaries";
import { renderArgsSection, renderOutputBody } from "./toolRenderers";
import { ToolStreamingOutput } from "./toolRenderers/ToolStreamingOutput";
import { computeDuration } from "./toolRenderers/util";

interface ToolBlockProps {
  entry: ToolBlockEntry;
  /// When the parent has decided this block should default to OPEN
  /// (e.g. the step row above is expanded → the user has already
  /// said "show me more"), pass `true` so we don't force a second
  /// click to see args + output. The user's manual chevron click
  /// still overrides — `manualOpen ?? defaultOpen` keeps the same
  /// "user toggle wins" semantics.
  forceOpen?: boolean;
}

export function ToolBlock({ entry, forceOpen = false }: ToolBlockProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const subAgentRuns = useAppStore((s) => s.subAgentRuns);
  const status = entry.status;
  const streaming = status === "running" && entry.progress.length > 0;
  const subAgentRun = useMemo(
    () => findSubAgentRun(entry, subAgentRuns),
    [entry, subAgentRuns],
  );
  // Four-tier default for the open state, overridable by user click:
  //   • errored / denied → open (user needs to debug the failure)
  //   • streaming → open (live scroll-back is the point)
  //   • parent says forceOpen → open (drill-into-step UX)
  //   • approval-gated + finished → open (diff / output IS the result)
  //   • read-only inspection finished cleanly → closed, with a
  //     one-line teaser chip in the header.
  const defaultOpen =
    status === "error" || status === "denied"
      ? true
      : streaming
        ? true
        : forceOpen
          ? true
          : status === "ok" && APPROVAL_GATED_TOOLS.has(entry.name)
            ? true
            : false;
  const open = manualOpen ?? defaultOpen;

  // Status badge is rendered only when the result is informative:
  //   - running: show "Running" so the user sees the live state
  //   - error / denied: show in red (must surface the failure)
  //   - ok: SUPPRESS — success is the default expectation, a green
  //     "Done" badge on every row is celebratory noise that crowds
  //     out the actually-interesting signals (duration, summary
  //     chip, decision-source). The chevron / row state already
  //     conveys "this finished".
  const badge =
    status === "ok"
      ? null
      : (({
          running: t("running"),
          denied: t("denied", ""),
          error: t("error"),
        } as Record<string, string>)[status] || status);

  // Compute the header teaser: only for known read-only tools that
  // have finished running. Streaming tools still write into
  // `entry.progress`, but the final `entry.output` may differ
  // (error vs. ok), so we wait for completion before parsing.
  const teaser =
    status !== "running" && SUMMARISABLE_TOOLS.has(entry.name)
      ? summarise(entry.name, entry.args, entry.output)
      : null;

  // Execution duration chip — gives the user a glanceable signal
  // for "how slow was this tool". Hidden when timestamps are
  // synthetic (history-restored entries; both stamps == 0) or
  // still running (would just be flickering).
  const duration = computeDuration(entry);

  return (
    <div className="tool" data-status={status} data-open={open ? "true" : "false"}>
      <div className="tool-header" onClick={() => setManualOpen(!open)}>
        <span className="tool-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="tool-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        </span>
        <span className="tool-name">{entry.name}</span>
        {badge ? <span className="tool-badge">{badge}</span> : null}
        {duration ? <span className="tool-duration" title={t("toolDurationHint") || "Execution time"}>{duration}</span> : null}
        {teaser ? (
          <span className="tool-summary" title={teaser}>{teaser}</span>
        ) : null}
        {entry.decisionSource ? <DecisionSourceChip source={entry.decisionSource} /> : null}
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            {renderArgsSection(entry.name, entry.args)}
          </div>
          {entry.output == null && entry.progress.length > 0 && (
            <div className="tool-section">
              <div className="tool-label">{t("output")}</div>
              <ToolStreamingOutput content={entry.progress} />
            </div>
          )}
          {subAgentRun ? (
            <div className="tool-section">
              <div className="tool-label">{t("tasksSubagentSection")}</div>
              <SubAgentCard run={subAgentRun} expanded={forceOpen ? true : undefined} />
            </div>
          ) : null}
          {entry.output != null && !subAgentRun && (
            <div className="tool-section">
              <div className="tool-label">{t("output")}</div>
              {renderOutputBody(entry.name, entry.output)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function findSubAgentRun(
  entry: ToolBlockEntry,
  runs: Record<string, SubAgentRun>,
): SubAgentRun | null {
  if (!entry.name.startsWith("subagent.")) return null;
  const subName = entry.name.slice("subagent.".length);
  const startedAt = entry.startedAt || 0;
  const finishedAt = entry.finishedAt ?? Date.now();
  const candidates = Object.values(runs)
    .filter((run) => {
      if (run.name !== subName) return false;
      if (!startedAt) return true;
      return run.startedAt >= startedAt - 250 && run.startedAt <= finishedAt + 1000;
    })
    .sort((a, b) => Math.abs(a.startedAt - startedAt) - Math.abs(b.startedAt - startedAt));
  return candidates[0] ?? null;
}
