// fs.write specialised card. Renders file path + size summary
// (lines, bytes) + a preview of the first 24 lines or 800 chars
// (whichever hits first), with a fold-out for the full content.

import { useState } from "react";
import { t } from "../../utils/i18n";

const PREVIEW_LINES = 24;
const PREVIEW_BYTES = 800;

interface Props {
  args: { path?: string; content?: string };
}

export function FsWriteCard({ args }: Props) {
  const [expanded, setExpanded] = useState(false);
  const path = args.path || "?";
  const content = typeof args.content === "string" ? args.content : "";
  const bytes = new Blob([content]).size;
  const totalLines = content === "" ? 0 : content.split("\n").length;

  const lines = content.split("\n");
  let preview = lines.slice(0, PREVIEW_LINES).join("\n");
  let truncated = lines.length > PREVIEW_LINES;
  if (preview.length > PREVIEW_BYTES) {
    preview = preview.slice(0, PREVIEW_BYTES);
    truncated = true;
  }
  const display = expanded ? content : preview + (truncated ? "\n…" : "");

  return (
    <div className="fs-write-card">
      <div className="fs-write-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
        </svg>
        <span className="fs-write-path">{path}</span>
        <span className="fs-write-size">{t("fsWriteSize", totalLines, bytes)}</span>
      </div>
      <pre className="fs-write-pre">{display}</pre>
      {truncated && (
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
        </div>
      )}
    </div>
  );
}
