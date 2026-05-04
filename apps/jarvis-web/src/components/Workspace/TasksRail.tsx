// Workspace tasks rail. Two activity sources live in one panel:
//
//   1. **SubAgent runs** (top) — every `subagent.<name>` dispatch in
//      the current conversation, ordered newest-first, rendered as
//      live rows that pop the full collapsible card on click. Same
//      reducer the inline chat-stream cards use, so both surfaces
//      stay in sync.
//   2. **Tool runs** (bottom) — Claude-style task cards for each
//      built-in tool call (`shell.exec`, `fs.read`, `code.grep`, …).
//      Capped at 12 entries by the store; newest first.
//
// The user's framing ("子智能体应该在任务中") is the literal split:
// subagents and tool calls are both "tasks the agent ran"; surfacing
// them under the same panel header avoids hunting across two
// near-identical lists.

import { useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import type { TaskRailEntry } from "../../store/appStore";
import { SubAgentCard } from "../SubAgent/SubAgentCard";
import { fmtElapsed, type SubAgentRun } from "../SubAgent/types";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function TaskCountSpan() {
  const tasks = useAppStore((s) => s.tasks);
  const subRuns = useAppStore((s) => s.subAgentRuns);
  const total = tasks.length + Object.keys(subRuns).length;
  return <span id="task-count">{String(total)}</span>;
}

export function TasksList() {
  const tasks = useAppStore((s) => s.tasks);
  const subRuns = useAppStore((s) => s.subAgentRuns);

  const subList = useMemo<SubAgentRun[]>(
    () =>
      Object.values(subRuns).sort((a, b) => {
        // Running first; within each group, newest startedAt first.
        const aActive = a.status === "running" ? 0 : 1;
        const bActive = b.status === "running" ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return b.startedAt - a.startedAt;
      }),
    [subRuns],
  );

  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);
  const openSubagent = openSubagentId
    ? subList.find((r) => r.id === openSubagentId) ?? null
    : null;

  const empty = subList.length === 0 && tasks.length === 0;

  return (
    <div id="task-list" className="task-list">
      {empty ? (
        <div className="rail-empty">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>{t("tasksEmpty")}</span>
        </div>
      ) : (
        <>
          {subList.length > 0 && (
            <section className="task-list-section">
              <div className="task-list-section-label">
                {tx("tasksSubagentSection", "SubAgents")}
              </div>
              <ul className="task-list-subagents">
                {subList.map((r) => (
                  <li key={r.id}>
                    <SubAgentTaskRow
                      run={r}
                      onOpen={() => setOpenSubagentId(r.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tasks.length > 0 && (
            <section className="task-list-section">
              {subList.length > 0 && (
                <div className="task-list-section-label">
                  {tx("tasksToolsSection", "Tool runs")}
                </div>
              )}
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </section>
          )}
        </>
      )}

      {openSubagent && (
        <div
          className="subagent-rail-popover"
          role="dialog"
          aria-label={tx("subagentRailDetail", "SubAgent detail")}
        >
          <button
            type="button"
            className="subagent-rail-popover-close"
            onClick={() => setOpenSubagentId(null)}
            aria-label={tx("subagentRailClose", "Close")}
          >
            ×
          </button>
          <SubAgentCard run={openSubagent} expanded onToggle={() => undefined} />
        </div>
      )}
    </div>
  );
}

/// One subagent row in the tasks list. Visual style mirrors
/// `<TaskCard>` so the two activity sources read as one continuous
/// list rather than competing widgets. Click pops the full
/// collapsible card in a popover overlay.
function SubAgentTaskRow({
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
  const subtitleText =
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
      className={`task-card subagent-task-card status-${run.status}`}
      onClick={onOpen}
      title={run.task}
    >
      <span
        className={`subagent-status-dot subagent-status-${run.status}`}
        aria-hidden="true"
      />
      <div className="task-card-body">
        <div className="task-card-title mono">subagent.{run.name}</div>
        <div className="task-card-meta">
          <span>{statusLabel(run.status)}</span>
          <span>{subtitleText}</span>
        </div>
      </div>
      <span className="task-kind tabular-nums">{elapsed}</span>
    </button>
  );
}

function statusLabel(status: SubAgentRun["status"]): string {
  switch (status) {
    case "running":
      return tx("subagentStatusRunning", "Running");
    case "done":
      return tx("subagentStatusDone", "Done");
    case "error":
      return tx("subagentStatusError", "Failed");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function TaskCard({ task }: { task: TaskRailEntry }) {
  const status = task.status || "ok";
  const detail = taskDetail(task.args);
  return (
    <div className={`task-card ${status}`}>
      <span className="task-status-dot">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {status === "running" && <path d="M12 6v6l4 2" />}
          {(status === "error" || status === "denied") && <path d="M18 6 6 18" />}
          {status !== "running" && status !== "error" && status !== "denied" && (
            <path d="m7 12 3 3 7-7" />
          )}
          {status === "running" && <circle cx="12" cy="12" r="9" />}
        </svg>
      </span>
      <div className="task-card-body">
        <div className="task-card-title">{taskTitle(task.name, task.args)}</div>
        <div className="task-card-meta">
          <span>{taskStatusText(status)}</span>
          {detail && <span>{detail}</span>}
        </div>
      </div>
      <span className="task-kind">{toolKind(task.name)}</span>
    </div>
  );
}

function taskStatusText(status: string): string {
  if (status === "running") return t("taskRunning");
  if (status === "error" || status === "denied") return t("taskFailed");
  return t("taskCompleted");
}

function toolKind(name: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("exec")) return t("taskKindBash");
  if (lower.includes("agent")) return t("taskKindAgent");
  return t("taskKindTool");
}

function taskTitle(name: string, args: any): string {
  const lower = (name || "").toLowerCase();
  const cmd = args && (args.cmd || args.command);
  if ((lower.includes("shell") || lower.includes("bash")) && cmd) {
    return String(cmd).split(/\s+/).slice(0, 5).join(" ");
  }
  if (lower.includes("fs.") && args?.path) return `${name} ${args.path}`;
  if (lower.includes("http") && args?.url) return `${name} ${args.url}`;
  return name || t("taskKindTool");
}

function taskDetail(args: any): string {
  if (!args || typeof args !== "object") return "";
  return args.path || args.url || args.cwd || args.description || "";
}
