// Per-message hover-revealed action chip. Renders a single copy
// button today; future per-message affordances (regenerate, reply
// inline, mark as system note, etc.) plug in here so each message
// row stays clean.
//
// Why a React component instead of the legacy click-delegation in
// `services/copy.ts`: the delegation pattern was inherited from a
// pre-React era and required a marker class (`.msg-copy-btn`) plus
// a single boot-time `addEventListener` on `#messages`. With every
// bubble being a React component now, owning the handler locally
// gives us colocation (the click reads the React `content` prop
// directly, no DOM `_raw` sidecar) and survives any future move
// out of `#messages`.

import { useState } from "react";
import { copyToClipboard } from "../../services/copy";
import { t } from "../../utils/i18n";

interface MessageActionsProps {
  /// The text to copy. Pass the raw markdown source, not the
  /// rendered HTML — the user expects the prose they wrote / saw,
  /// not its HTML markup.
  text: string;
}

export function MessageActions({ text }: MessageActionsProps) {
  // Local "copied" state used to swap the button label briefly so
  // the user gets immediate visual feedback. `copyToClipboard` also
  // adds a `.flash` class via the optional sourceBtn argument; we
  // don't pass it so the React state owns the affordance entirely.
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`msg-copy-btn${copied ? " flash" : ""}`}
      title={copied ? t("copied") : t("copy")}
      aria-label={t("copy")}
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(text);
        setCopied(true);
        // 900ms matches the existing `.flash` CSS animation length
        // in styles.css so the button state and the visual flash
        // resolve together.
        window.setTimeout(() => setCopied(false), 900);
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}
