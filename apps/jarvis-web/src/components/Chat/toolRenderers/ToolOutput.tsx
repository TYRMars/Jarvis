// Default tool-output viewer. Truncates content longer than
// `TOOL_PREVIEW_CHARS` behind a "Show more" button so long shell
// output / grep results don't blow up the chat scroller.

import { useState } from "react";
import { t } from "../../../utils/i18n";

export const TOOL_PREVIEW_CHARS = 1200;

export function ToolOutput({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const total = content.length;
  const oversize = total > TOOL_PREVIEW_CHARS;
  const display = expanded || !oversize
    ? content
    : content.slice(0, TOOL_PREVIEW_CHARS) + "\n…";
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
