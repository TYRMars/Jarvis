import { useMemo } from "react";
import { t } from "../../utils/i18n";

interface OutlineItem {
  level: 1 | 2 | 3;
  text: string;
  /// 0-based byte offset of the heading line in the raw markdown.
  /// Used to scroll the textarea / preview to the heading on click.
  offset: number;
}

interface DocOutlineProps {
  body: string;
  onJump: (offset: number) => void;
}

/// Parse heading lines (`#`, `##`, `###`) out of the raw markdown
/// and render a 1-line-deep collapsible outline. Headings inside
/// fenced code blocks are skipped — we count opening/closing
/// triple-backtick fences and ignore any heading-shaped lines that
/// land inside them.
function parseOutline(body: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let inFence = false;
  let cursor = 0;
  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fenceMatch) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (m) {
        items.push({
          level: m[1].length as 1 | 2 | 3,
          text: m[2].replace(/[`*_~]/g, "").trim(),
          offset: cursor,
        });
      }
    }
    cursor += line.length + 1; // include the newline
  }
  return items;
}

export function DocOutline({ body, onJump }: DocOutlineProps) {
  const items = useMemo(() => parseOutline(body), [body]);
  if (items.length === 0) return null;
  return (
    <nav className="docs-outline" aria-label={t("docsOutlineAria")}>
      {items.map((it, i) => (
        <button
          key={`${it.offset}-${i}`}
          type="button"
          className={`docs-outline-item is-h${it.level}`}
          onClick={() => onJump(it.offset)}
          title={it.text}
        >
          <span className="docs-outline-bullet" aria-hidden>
            {it.level === 1 ? "•" : it.level === 2 ? "◦" : "·"}
          </span>
          <span className="docs-outline-text">{it.text}</span>
        </button>
      ))}
    </nav>
  );
}
