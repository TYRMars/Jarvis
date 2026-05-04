// Store-bound wrapper around `<SubAgentRail>`. Pulls runs from the
// `subAgentRuns` slice and renders the same rail used by the
// `/demo/subagent` static prototype — only with real WS frame data
// instead of a scripted mock.

import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { SubAgentRail } from "./SubAgentRail";
import type { SubAgentRun } from "./types";

export function SubAgentRailLive() {
  const runs = useAppStore((s) => s.subAgentRuns);
  // Convert the keyed map into a stable array. Newest startedAt first
  // so the rail sees a sensible order regardless of insertion timing.
  const list = useMemo<SubAgentRun[]>(
    () =>
      Object.values(runs).sort((a, b) => b.startedAt - a.startedAt),
    [runs],
  );
  return <SubAgentRail runs={list} />;
}

/// `<TaskCountSpan />`-style live count for the workspace rail's
/// header subtitle. Mirrors the existing pattern (PlanCountSpan,
/// TaskCountSpan, etc.) so the rail panel header reads consistently.
export function SubAgentCountSpan() {
  const runs = useAppStore((s) => s.subAgentRuns);
  const total = Object.keys(runs).length;
  const running = Object.values(runs).filter((r) => r.status === "running")
    .length;
  return (
    <span className="tabular-nums">
      {running > 0 ? `${running} / ${total}` : String(total)}
    </span>
  );
}
