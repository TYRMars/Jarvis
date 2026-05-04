// Inline subagent cards shown in the main chat message stream.
// Renders one `<SubAgentCard>` per active or recent run, ordered by
// startedAt ascending so the user sees them in the same sequence
// the assistant dispatched. Mounted at the bottom of the message
// list so cards appear after the latest assistant bubble.
//
// Future enhancement: correlate `subagent_id` with the assistant
// message that triggered the dispatch (via the wrapping
// `subagent.<name>` tool_call_id) so cards render *next to* the
// assistant message rather than at the end. v1.0 takes the simpler
// path; the rail provides the global view.

import { useMemo } from "react";
import { useAppStore } from "../../store/appStore";
import { SubAgentCard } from "./SubAgentCard";
import type { SubAgentRun } from "./types";

export function SubAgentInlineList() {
  const runs = useAppStore((s) => s.subAgentRuns);
  const list = useMemo<SubAgentRun[]>(
    () => Object.values(runs).sort((a, b) => a.startedAt - b.startedAt),
    [runs],
  );
  if (list.length === 0) return null;
  return (
    <div className="subagent-inline-stack">
      {list.map((r) => (
        <SubAgentCard key={r.id} run={r} />
      ))}
    </div>
  );
}
