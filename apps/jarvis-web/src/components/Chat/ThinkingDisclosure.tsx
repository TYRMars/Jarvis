// Collapsible "Thinking" panel for assistant turns that carry
// reasoning_content (Codex / Anthropic / Google reasoning models).
// Folded by default — chain-of-thought is rarely the user's first
// interest, but it's invaluable when debugging why the model picked
// a particular tool. Clicking the toggle flips a local `useState`.

import { useState } from "react";
import { t } from "../../utils/i18n";

export function ThinkingDisclosure({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning || !reasoning.trim()) return null;
  return (
    <div className="thinking-block" data-open={open ? "true" : "false"}>
      <button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-chevron">▶</span>
        <span className="thinking-label">{t(open ? "thinkingHide" : "thinkingShow")}</span>
      </button>
      <div className="thinking-body">{reasoning}</div>
    </div>
  );
}
