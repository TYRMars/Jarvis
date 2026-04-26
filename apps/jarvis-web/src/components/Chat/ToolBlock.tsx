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

const TOOL_PREVIEW_CHARS = 1200;

export function ToolBlock({ entry }: { entry: ToolBlockEntry }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const status = entry.status;
  const streaming = status === "running" && entry.progress.length > 0;
  // Auto-open while streaming so the user watches output live; once
  // it finishes, fall back to whatever the user last clicked.
  const open = manualOpen ?? streaming;

  const badge = ({
    running: t("running"),
    ok: t("done"),
    denied: t("denied", ""),
    error: t("error"),
  } as Record<string, string>)[status] || status;

  return (
    <div className="tool" data-status={status} data-open={open ? "true" : "false"}>
      <div className="tool-header" onClick={() => setManualOpen(!open)}>
        <span className="tool-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="tool-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        </span>
        <span className="tool-name">{entry.name}</span>
        <span className="tool-badge">{badge}</span>
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
              <ToolOutput content={entry.output} />
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
