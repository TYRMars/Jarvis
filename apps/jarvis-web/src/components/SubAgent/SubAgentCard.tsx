// Inline collapsible card for a single subagent run, designed to
// drop into the main agent's message stream. Header is one row
// (name · status · elapsed · chevron); body is a scrollable timeline
// of tool calls + status notes + (optionally) text deltas.
//
// State machine (driven by `SubAgentRun.status`):
//
//  running → blue dot, animated, header shows "{name} · {model?} · {elapsed}"
//  done    → green ✓, header collapses by default and shows the final
//            message; body still expandable
//  error   → red ✕, header shows "{name} 失败 · {elapsed}", body
//            shows errorMessage on top
//
// Renderers shouldn't care about the underlying transport — they get
// a `SubAgentRun` value (built by `applyFrame` reducing the WS event
// stream) and lay it out.

import { useEffect, useState } from "react";
import { t } from "../../utils/i18n";
import {
  fmtElapsed,
  type SubAgentRun,
  type TimelineEntry,
} from "./types";

interface Props {
  run: SubAgentRun;
  /// Whether the body is expanded. Controlled so a parent can sync
  /// state across the inline card and the side-panel detail view.
  /// If omitted, the card manages its own state with a sensible
  /// default (expanded while running, collapsed once done).
  expanded?: boolean;
  onToggle?: (next: boolean) => void;
}

export function SubAgentCard({ run, expanded, onToggle }: Props) {
  // Auto-expand running runs; auto-collapse on done (unless caller
  // controls). Manual toggle wins over the auto-collapse so a user
  // who opened a finished run keeps it open.
  const [autoExpanded, setAutoExpanded] = useState(true);
  useEffect(() => {
    if (run.status !== "running" && expanded === undefined) {
      setAutoExpanded(false);
    }
  }, [run.status, expanded]);

  const isExpanded = expanded ?? autoExpanded;
  const toggle = () => {
    const next = !isExpanded;
    setAutoExpanded(next);
    onToggle?.(next);
  };

  // Re-render once a second while running so the elapsed timer
  // updates. Cheap enough at small N (each card costs one setState
  // per second).
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.status !== "running") return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [run.status]);

  const elapsed = fmtElapsed(
    (run.endedAt ?? Date.now()) - run.startedAt,
  );
  const toolEntries = run.timeline.filter((entry) => entry.kind === "tool");
  const completedTools = toolEntries.filter((entry) => entry.tEnd !== undefined).length;

  const statusLabel = (() => {
    switch (run.status) {
      case "running":
        return t("subagentStatusRunning");
      case "done":
        return t("subagentStatusDone");
      case "error":
        return t("subagentStatusError");
    }
  })();

  return (
    <div
      className={`subagent-card subagent-card-${run.status}${
        isExpanded ? " is-expanded" : ""
      }`}
    >
      <button
        type="button"
        className="subagent-card-header"
        onClick={toggle}
        aria-expanded={isExpanded}
      >
        <span className="subagent-card-title">
          <span className={`subagent-status-dot subagent-status-${run.status}`} aria-hidden="true" />
          <span className="subagent-card-name">subagent.{run.name}</span>
        </span>
        <span className="subagent-card-status">{statusLabel}</span>
        {run.model ? (
          <span className="subagent-card-model mono">{run.model}</span>
        ) : null}
        <span className="subagent-card-elapsed tabular-nums">{elapsed}</span>
        <span className="subagent-card-spacer" />
        <span className="subagent-card-chevron" aria-hidden="true">
          {isExpanded ? "▾" : "▸"}
        </span>
      </button>

      {/* Task + (when collapsed) summary line shown even in the
          collapsed state so users know what the subagent did. */}
      <div className="subagent-card-summary">
        <span className="subagent-card-summary-label">
          {t("subagentTaskLabel")}:
        </span>
        <span className="subagent-card-summary-text">{run.task}</span>
      </div>

      {isExpanded ? (
        <div className="subagent-card-body">
          {run.status === "error" && run.errorMessage ? (
            <div className="subagent-card-error" role="alert">
              {run.errorMessage}
            </div>
          ) : null}
          <ol className="subagent-timeline">
            {toolEntries.length > 0 ? (
              <li className="subagent-timeline-overview">
                <span>{t("subagentTimelineTools")}</span>
                <strong className="tabular-nums">
                  {completedTools}/{toolEntries.length}
                </strong>
              </li>
            ) : null}
            {run.timeline.length === 0 ? (
              <li className="subagent-timeline-empty">
                {t("subagentTimelineWaiting")}
              </li>
            ) : (
              run.timeline.map((entry, i) => (
                <TimelineRow key={i} entry={entry} />
              ))
            )}
          </ol>
          {run.status === "done" && run.finalMessage ? (
            <div className="subagent-card-final">
              <span className="subagent-card-final-label">
                {t("subagentFinalLabel")}:
              </span>
              <span className="subagent-card-final-text">{run.finalMessage}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === "tool") {
    const ended = entry.tEnd !== undefined;
    return (
      <li
        className={`subagent-timeline-row subagent-tool-row${
          ended ? " subagent-tool-done" : " subagent-tool-running"
        }`}
      >
        <span className="subagent-timeline-glyph mono" aria-hidden="true">
          {ended ? "✓" : "…"}
        </span>
        <span className="subagent-timeline-head">
          <span className="subagent-timeline-name mono">{entry.name}</span>
          <span className="subagent-timeline-state">
            {ended ? t("subagentToolDone") : t("subagentToolRunning")}
          </span>
        </span>
        <span className="subagent-timeline-args">
          {summariseArgs(entry.args)}
        </span>
        {ended && entry.output ? (
          <span className="subagent-timeline-output">
            {summariseOutput(entry.output)}
          </span>
        ) : null}
      </li>
    );
  }
  if (entry.kind === "status") {
    return (
      <li className="subagent-timeline-row status">
        <span className="subagent-timeline-glyph" aria-hidden="true">
          ⋯
        </span>
        <span className="subagent-timeline-status-text">{entry.message}</span>
      </li>
    );
  }
  // delta — assistant text from the subagent. Render lightly so the
  // tool calls stay the focal point.
  return (
    <li className="subagent-timeline-row delta">
      <span className="subagent-timeline-delta-text">{entry.text}</span>
    </li>
  );
}

function summariseArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args.length > 60 ? args.slice(0, 60) + "…" : args;
  try {
    const json = JSON.stringify(args);
    return json.length > 80 ? json.slice(0, 80) + "…" : json;
  } catch {
    return "";
  }
}

function summariseOutput(out: string): string {
  const trimmed = out.trim().replace(/\s+/g, " ");
  return trimmed.length > 100 ? trimmed.slice(0, 100) + "…" : trimmed;
}
