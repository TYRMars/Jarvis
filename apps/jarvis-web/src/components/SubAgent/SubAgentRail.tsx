// Side-panel listing all subagent runs visible to the current
// session. Two sections: "running" (live, ordered by startedAt) and
// "recent" (last N completed/failed runs, newest first). Each row
// is a compact summary that opens the full collapsible card on
// click — same `<SubAgentCard>` component the inline rendering uses,
// just inside a popover/drawer.
//
// This is the "tasks panel" the user asked for: 「希望在 side-panel
// 任务中面看到 subagent」. It complements the inline card by giving
// a global view across the whole conversation, including subagents
// that have already scrolled out of the chat.

import { useState } from "react";
import { t } from "../../utils/i18n";
import { fmtElapsed, type SubAgentRun } from "./types";
import { SubAgentCard } from "./SubAgentCard";

interface Props {
  runs: SubAgentRun[];
  /// Max recent entries to keep in the "recent" section. Older runs
  /// drop off. Default 8 is enough for a typical session without
  /// burying the live list.
  maxRecent?: number;
}

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function SubAgentRail({ runs, maxRecent = 8 }: Props) {
  const running = runs.filter((r) => r.status === "running");
  // Sort recent newest-first so the most recent finish is on top.
  const recent = runs
    .filter((r) => r.status !== "running")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, maxRecent);

  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId
    ? runs.find((r) => r.id === openId) ?? null
    : null;

  return (
    <aside className="subagent-rail" aria-label={tx("subagentRailLabel", "SubAgent activity")}>
      <header className="subagent-rail-header">
        <h3>{tx("subagentRailTitle", "SubAgents")}</h3>
        <span className="subagent-rail-count tabular-nums">
          {running.length > 0
            ? tx("subagentRailRunning", "%d running").replace("%d", String(running.length))
            : tx("subagentRailIdle", "Idle")}
        </span>
      </header>

      {running.length === 0 && recent.length === 0 ? (
        <p className="subagent-rail-empty">
          {tx(
            "subagentRailEmpty",
            "Subagents you delegate to will appear here as they run.",
          )}
        </p>
      ) : null}

      {running.length > 0 ? (
        <section className="subagent-rail-section">
          <div className="subagent-rail-section-label">
            {tx("subagentRailSectionRunning", "Running")}
          </div>
          <ul className="subagent-rail-list">
            {running.map((r) => (
              <li key={r.id}>
                <SubAgentRailRow run={r} onOpen={() => setOpenId(r.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="subagent-rail-section">
          <div className="subagent-rail-section-label">
            {tx("subagentRailSectionRecent", "Recent")}
          </div>
          <ul className="subagent-rail-list">
            {recent.map((r) => (
              <li key={r.id}>
                <SubAgentRailRow run={r} onOpen={() => setOpenId(r.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <div
          className="subagent-rail-popover"
          role="dialog"
          aria-label={tx("subagentRailDetail", "SubAgent detail")}
        >
          <button
            type="button"
            className="subagent-rail-popover-close"
            onClick={() => setOpenId(null)}
            aria-label={tx("subagentRailClose", "Close")}
          >
            ×
          </button>
          <SubAgentCard run={open} expanded onToggle={() => undefined} />
        </div>
      ) : null}
    </aside>
  );
}

function SubAgentRailRow({
  run,
  onOpen,
}: {
  run: SubAgentRun;
  onOpen: () => void;
}) {
  const elapsed = fmtElapsed(
    (run.endedAt ?? Date.now()) - run.startedAt,
  );
  const lastTool =
    [...run.timeline].reverse().find((e) => e.kind === "tool") ?? null;
  const subtitle =
    lastTool && lastTool.kind === "tool"
      ? `${lastTool.tEnd === undefined ? "▶" : "✓"} ${lastTool.name}`
      : run.status === "done" && run.finalMessage
        ? truncate(run.finalMessage, 60)
        : run.status === "error" && run.errorMessage
          ? truncate(run.errorMessage, 60)
          : truncate(run.task, 60);

  return (
    <button
      type="button"
      className="subagent-rail-row"
      onClick={onOpen}
      title={run.task}
    >
      <span
        className={`subagent-status-dot subagent-status-${run.status}`}
        aria-hidden="true"
      />
      <div className="subagent-rail-row-text">
        <div className="subagent-rail-row-name mono">subagent.{run.name}</div>
        <div className="subagent-rail-row-sub">{subtitle}</div>
      </div>
      <span className="subagent-rail-row-elapsed tabular-nums">{elapsed}</span>
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
