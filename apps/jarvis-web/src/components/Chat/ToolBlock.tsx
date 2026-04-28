// Generic collapsible tool block. Header shows name + status badge;
// body holds the args (or specialised renderer for `fs.edit` /
// `fs.write`) and the captured output once the call finishes.
//
// Toggling opens/closes the body via `useState`. Output longer
// than `TOOL_PREVIEW_CHARS` collapses behind a "Show more"
// affordance.
//
// Tools that stream progress (`shell.exec` line-by-line) push
// `tool_progress` frames before `tool_end` lands. While the call
// is `running` and `progress` has bytes, the body opens
// automatically and renders the live scroll-back; once `output`
// arrives the formatted summary takes over.

import { useEffect, useRef, useState } from "react";
import type { ToolBlockEntry } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { FsEditDiff } from "./FsEditDiff";
import { FsWriteCard } from "./FsWriteCard";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";
import { WorkspaceContextCard } from "./WorkspaceContextCard";
import { ProjectChecksCard } from "./ProjectChecksCard";
import { DecisionSourceChip } from "../Approvals/DecisionSourceChip";
import {
  APPROVAL_GATED_TOOLS,
  SUMMARISABLE_TOOLS,
  summarise,
} from "./toolSummaries";

const TOOL_PREVIEW_CHARS = 1200;

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
  const status = entry.status;
  const streaming = status === "running" && entry.progress.length > 0;
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
            {entry.name === "fs.edit" ? (
              <>
                <div className="tool-label">{t("editing")}</div>
                <FsEditDiff args={entry.args || {}} />
              </>
            ) : entry.name === "fs.write" ? (
              <FsWriteCard args={entry.args || {}} />
            ) : entry.name === "fs.patch" && typeof entry.args?.diff === "string" ? (
              <>
                <div className="tool-label">{t("toolArguments")}</div>
                <UnifiedDiffViewer content={entry.args.diff} />
              </>
            ) : (
              <>
                <div className="tool-label">{t("toolArguments")}</div>
                <pre className="tool-pre">{safeStringify(entry.args)}</pre>
              </>
            )}
          </div>
          {entry.output == null && entry.progress.length > 0 && (
            <div className="tool-section">
              <div className="tool-label">{t("output")}</div>
              <ToolStreamingOutput content={entry.progress} />
            </div>
          )}
          {entry.output != null && (
            <div className="tool-section">
              <div className="tool-label">{t("output")}</div>
              {entry.name === "git.diff" && entry.output.trim() && entry.output !== "(no changes)" ? (
                <UnifiedDiffViewer content={entry.output} />
              ) : entry.name === "workspace.context" ? (
                <WorkspaceContextCard content={entry.output} />
              ) : entry.name === "project.checks" ? (
                <ProjectChecksCard content={entry.output} />
              ) : (
                <ToolOutput content={entry.output} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Auto-scrolling pre for live streaming output. Pinned to the
/// bottom while new chunks arrive so the user sees the latest
/// bytes; user can still scroll up — the auto-scroll only kicks
/// in when they're already near the bottom.
function ToolStreamingOutput({ content }: { content: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [content]);
  return (
    <pre ref={ref} className="tool-pre tool-pre-streaming">{content}</pre>
  );
}

function ToolOutput({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const total = content.length;
  const oversize = total > TOOL_PREVIEW_CHARS;
  const display = expanded || !oversize ? content : content.slice(0, TOOL_PREVIEW_CHARS) + "\n…";
  return (
    <>
      <pre className="tool-pre">{display}</pre>
      {oversize && (
        <div className="tool-show-more-row">
          <button
            type="button"
            className="tool-show-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? t("showLess") : t("showMore")}
          </button>
          <span className="tool-bytes">
            {t("bytesShown", expanded ? total : TOOL_PREVIEW_CHARS, total)}
          </span>
        </div>
      )}
    </>
  );
}

function safeStringify(value: any): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// Format the tool's wall-clock duration as a chip-friendly string.
/// Returns `null` when:
///   - the tool is still running (would just flicker as time passes)
///   - the timestamps are synthetic (history-restored entries — both
///     stored as 0 by `loadHistory`)
///   - the duration is zero (sub-millisecond; not worth surfacing)
function computeDuration(entry: ToolBlockEntry): string | null {
  if (entry.finishedAt == null) return null;
  if (entry.startedAt === 0 && entry.finishedAt === 0) return null;
  const ms = Math.max(0, entry.finishedAt - entry.startedAt);
  if (ms === 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}
