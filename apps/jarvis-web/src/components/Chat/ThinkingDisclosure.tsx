// Inline reasoning preview for assistant turns that carry hidden
// chain-of-thought (Codex / Anthropic / Google reasoning models).
//
// Two states:
//   • Collapsed (default): renders the first ~80 chars of reasoning
//     italic + muted, prefixed with `▸ 思考`. The user can tell
//     what the model is thinking without having to click anything.
//   • Expanded: full reasoning in a soft-bordered code block.
//
// Why an inline preview instead of a generic "Show thinking" toggle:
// multi-iteration agent turns produce 5+ thinking disclosures back-
// to-back. Generic toggles all read identical and look like noise.
// A preview line is glanceable AND collapsible.
//
// Returns null on empty / whitespace reasoning so we don't render
// dead chrome.

import { useState } from "react";

const PREVIEW_CHARS = 80;

export function ThinkingDisclosure({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning || !reasoning.trim()) return null;

  // Collapse to a single-line preview by stripping leading
  // whitespace, joining newlines, and capping length. Preserves
  // the model's actual first words so the user can decide
  // whether the full reasoning is worth opening.
  const preview = previewLine(reasoning);

  return (
    <div className="thinking-block" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {/* Same SVG chevron as the tool step row so the two row types
         * share one visual vocabulary — both rotate 90° when open,
         * both sized 12px stroke 2.4. The ROW chrome is identical to
         * a tool step row (padding, border-radius, hover background);
         * only the content (italic preview) signals "this is the
         * model's reasoning, not an action it took". */}
        <span className="thinking-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="thinking-preview">{preview}</span>
      </button>
      <div className="thinking-body">{reasoning}</div>
    </div>
  );
}

function previewLine(reasoning: string): string {
  // Replace any whitespace run (incl. newlines) with one space so
  // the preview is a single line. Strip leading/trailing space.
  const flat = reasoning.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_CHARS) return flat;
  return flat.slice(0, PREVIEW_CHARS).trimEnd() + "…";
}
