// Render a pre-formatted unified diff with line-level colouring.
//
// Used by:
//   - `git.diff` tool output (the diff is the output)
//   - `fs.patch` tool args.diff (the diff is the *input*; output is
//     a separate summary string)
//
// Differs from `renderEditDiff` (which lives in ../diff_render.ts):
// that module *computes* a diff between two strings via the `diff`
// crate. Here we already have a unified diff produced by git or by
// the model — we just need to colour it.

import { useState } from "react";
import { t } from "../../utils/i18n";

// `t()` returns the key when no translation is registered. Wrap with a
// fallback so brand-new strings render readable English instead of the
// raw key the moment they ship — translators can fill in messages.zh
// later without breaking the UI in the meantime.
function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const PREVIEW_LINES = 200;

interface Row {
  /** Visual class on the row. */
  kind: "add" | "del" | "ctx" | "hunk" | "file" | "noise";
  text: string;
}

function classify(line: string): Row["kind"] {
  // `+++ ` / `--- ` are file headers. Check before the bare-prefix
  // tests so "+++ b/foo.rs" doesn't get flagged as "add".
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "file";
  if (line.startsWith("diff --git ") || line.startsWith("index ")) return "noise";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function UnifiedDiffViewer({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const allLines = (content || "").split("\n");
  // Drop the trailing empty line `split` produces for diffs that
  // end with a newline — otherwise every diff renders an extra blank row.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const total = allLines.length;
  const lines = expanded || total <= PREVIEW_LINES ? allLines : allLines.slice(0, PREVIEW_LINES);

  // (added, removed) tally for the header chip — gives the user a
  // glance-able sense of "how big is this change".
  let added = 0;
  let removed = 0;
  for (const l of allLines) {
    const k = classify(l);
    if (k === "add") added++;
    else if (k === "del") removed++;
  }

  const rows: Row[] = lines.map((text) => ({ kind: classify(text), text }));

  return (
    <div className="udiff">
      <div className="udiff-meta">
        <span className="udiff-stat udiff-stat-add">+{added}</span>
        <span className="udiff-stat udiff-stat-del">-{removed}</span>
        <span className="udiff-stat udiff-stat-total">{total} {tx("linesShort", "lines")}</span>
      </div>
      <pre className="udiff-body">
        {rows.map((r, i) => (
          <span key={i} className={`udiff-row udiff-${r.kind}`}>{r.text || " "}{"\n"}</span>
        ))}
      </pre>
      {!expanded && total > PREVIEW_LINES && (
        <div className="tool-show-more-row">
          <button
            type="button"
            className="tool-show-more"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            {t("showMore")}
          </button>
          <span className="tool-bytes">
            {`${PREVIEW_LINES} / ${total} ${tx("linesShort", "lines")}`}
          </span>
        </div>
      )}
    </div>
  );
}
