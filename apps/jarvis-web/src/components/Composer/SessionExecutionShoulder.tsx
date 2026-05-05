// In-session execution-context shoulder.
//
// Renders above the Git/branch row in the in-session composer. Hidden
// when the active conversation isn't bound to a Requirement (Free chat).
// Click anywhere → opens the read-only `SessionExecutionDrawer` for
// the full Requirement / latest run / verification / activity payload.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useConversationWorkContext } from "../../hooks/useConversationWorkContext";
import {
  buildSessionExecutionDisplay,
  type DisplayLang,
} from "./sessionExecutionDisplay";
import { SessionExecutionDrawer } from "./SessionExecutionDrawer";

export function SessionExecutionShoulder() {
  const activeId = useAppStore((s) => s.activeId);
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  // Store's `lang` is already `"en" | "zh"` — same shape as
  // `DisplayLang`. Don't widen with an `as` cast (lint catches it).
  const lang: DisplayLang = useAppStore((s) => s.lang);
  const ctx = useConversationWorkContext(activeId, draftProjectId);

  const [now, setNow] = useState<number>(() => Date.now());
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tick once a second while a run is live so the elapsed counter
  // moves visibly. We compute display every render anyway, so the
  // tick is just a `setNow(Date.now())` cue.
  useEffect(() => {
    if (!ctx?.latestRun || ctx.latestRun.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ctx?.latestRun?.status, ctx?.latestRun?.id]);

  // No active session, or active session has no requirement → no shoulder.
  if (!activeId || !ctx) return null;
  const display = buildSessionExecutionDisplay(ctx, now, lang);
  if (!display) return null;

  return (
    <>
      <div
        className={"session-exec-shoulder tone-" + display.tone}
        role="button"
        tabIndex={0}
        onClick={() => setDrawerOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDrawerOpen(true);
          }
        }}
      >
        <span className="session-exec-shoulder-id">
          {display.requirementLabel}
        </span>
        <span className="session-exec-shoulder-title" title={display.title}>
          {display.title}
        </span>
        <span
          className={
            "session-exec-shoulder-status status-pill tone-" + display.tone
          }
        >
          {display.statusLabel}
        </span>
        {display.detailLabel && (
          <span
            className="session-exec-shoulder-detail"
            title={display.detailLabel}
          >
            {display.detailLabel}
          </span>
        )}
        <span className="session-exec-shoulder-action">
          {display.actionLabel} →
        </span>
      </div>
      {drawerOpen && (
        <SessionExecutionDrawer
          ctx={ctx}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}
