// Jarvis loading footer.
//
// Pinned to the bottom of `<MessageList>` whenever the agent loop
// is running. The visual is deliberately quiet: three breathing
// dots, elapsed wall-clock, and optional generated-token count.
// It covers silent moments before the first delta, during tool
// execution, and between iterations of a multi-step turn.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";

export function AgentLoadingFooter() {
  const inFlight = useAppStore((s) => s.inFlight);
  const turnStartedAt = useAppStore((s) => s.turnStartedAt);
  const usage = useAppStore((s) => s.usage);

  // Manually-driven "now" so the elapsed counter ticks every second
  // without the rest of the chat re-rendering. Only schedule the
  // interval while inFlight is true so settled turns don't burn one.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!inFlight) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inFlight]);

  if (!inFlight) return null;

  const elapsedSec =
    turnStartedAt != null ? Math.max(0, Math.floor((now - turnStartedAt) / 1000)) : 0;
  const elapsedLabel = formatElapsed(elapsedSec);

  // "Tokens received" = LLM-generated tokens for this turn. Includes
  // reasoning (visible-or-hidden chain-of-thought) since that's
  // billable and matches what the user pays for.
  const tokensIn = usage.completion + usage.reasoning;
  const tokensLabel = formatTokens(tokensIn);

  return (
    <div className="agent-loading" role="status" aria-live="polite" aria-label="Jarvis is thinking">
      <span className="agent-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="agent-loading-text">
        <span className="agent-loading-elapsed">{elapsedLabel}</span>
        {tokensIn > 0 ? (
          <>
            <span className="agent-loading-sep" aria-hidden="true">·</span>
            <span className="agent-loading-tokens">
              <span className="agent-loading-arrow" aria-hidden="true">↓</span>
              {tokensLabel} tokens
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

/// Compact elapsed string. Sub-minute reports `Ns`. Past a minute
/// switches to `<m>m <s>s` with a space separator (matches the
/// Claude Code reference: `3m 1s`, not `3m1s`).
function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/// Token count humaniser. < 1k → raw; < 1M → e.g. `2.4k`; bigger
/// → `12.3M`. One decimal place keeps the UI compact while still
/// distinguishing between 2.1k and 2.9k responses.
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return v >= 10 ? `${Math.round(v)}k` : `${v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(1)}M`;
}
