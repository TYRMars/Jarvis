// Workspace tasks rail. Mirrors what `<ToolBlock>` renders inline in
// the chat as a Claude-style sidebar list — newest first, capped at
// 12 entries by the store. Empty state is a small checkmark card.
//
// Two named exports because the count + list live in different parts
// of the rail markup (count in the section header, list in the body).

import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import type { TaskRailEntry } from "../../store/appStore";

export function TaskCountSpan() {
  const tasks = useAppStore((s) => s.tasks);
  return <span id="task-count">{String(tasks.length)}</span>;
}

export function TasksList() {
  const tasks = useAppStore((s) => s.tasks);
  return (
    <div id="task-list" className="task-list">
      {tasks.length === 0 ? (
        <div className="rail-empty">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>{t("tasksEmpty")}</span>
        </div>
      ) : (
        tasks.map((task) => <TaskCard key={task.id} task={task} />)
      )}
    </div>
  );
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
