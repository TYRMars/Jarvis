// Background-tasks panel — a single "what's in flight right now"
// view that aggregates chat turns, subagent runs, and (over time)
// auto-mode picks / MCP / shell jobs into one list. Backed by the
// `GET /v1/tasks` aggregator; polled while open and immediately
// stopped when the panel closes so a quiet system doesn't pay for
// idle fetches.

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../../services/api";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

// Safety-net poll: the server pushes `tasks_snapshot` frames at
// every turn boundary (P7), so under normal use the panel gets
// real-time updates and the poll just covers "first open" and
// "WS hiccup" gaps. 15s is gentle on the backend while still
// catching missed pushes within a typical usage window.
const POLL_INTERVAL_MS = 15000;

type TaskKind = "chat_run" | "subagent_run" | "requirement_run" | "mcp_server";

interface TaskEntry {
  kind: TaskKind;
  id: string;
  label: string;
  status: string;
  started_at: number;
  updated_at: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail: any;
}

interface TasksResponse {
  items: TaskEntry[];
  generated_at: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function BackgroundTasksPanel({ open, onClose }: Props) {
  // Pushed snapshot from the WS `tasks_snapshot` frame; preferred
  // over the panel's own poll when present so the panel reflects
  // server state in near-real-time.
  const pushed = useAppStore((s) => s.backgroundTasksSnapshot);
  const [polled, setPolled] = useState<TaskEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);
  const tasks: TaskEntry[] =
    (pushed as TaskEntry[] | null) ?? polled ?? [];

  useEffect(() => {
    if (!open) {
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    let cancelled = false;
    async function fetchOnce() {
      try {
        setLoading(true);
        const r = await fetch(apiUrl("/v1/tasks"));
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as TasksResponse;
        if (!cancelled) {
          setPolled(body.items);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchOnce();
    timerRef.current = window.setInterval(() => {
      void fetchOnce();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="bg-tasks-panel" role="dialog" aria-label={t("sideBarBackgroundTasks")}>
      <header className="bg-tasks-header">
        <h2>{t("sideBarBackgroundTasks")}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sideBarClose")}
          className="bg-tasks-close"
        >
          ×
        </button>
      </header>
      <div className="bg-tasks-body">
        {error && (
          <div className="bg-tasks-error" role="alert">
            {t("sideBarTasksLoadFailed", error)}
          </div>
        )}
        {!error && tasks.length === 0 && !loading && (
          <div className="bg-tasks-empty">{t("sideBarTasksEmpty")}</div>
        )}
        {tasks.length > 0 && (
          <ul className="bg-tasks-list">
            {tasks.map((task) => (
              <li
                key={`${task.kind}-${task.id}`}
                className="bg-tasks-row"
                data-kind={task.kind}
                data-status={task.status}
              >
                <span className="bg-tasks-kind">{kindLabel(task.kind)}</span>
                <span className="bg-tasks-label">{task.label}</span>
                <span className="bg-tasks-status">{task.status}</span>
                <span className="bg-tasks-age">{relativeAge(task.started_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function kindLabel(k: TaskKind): string {
  switch (k) {
    case "chat_run":
      return t("sideBarTaskKindChat");
    case "subagent_run":
      return t("sideBarTaskKindSubagent");
    case "requirement_run":
      return t("sideBarTaskKindRequirement");
    case "mcp_server":
      return t("sideBarTaskKindMcp");
    default:
      return k;
  }
}

function relativeAge(startedAt: number): string {
  const dt = Math.max(0, Date.now() - startedAt);
  if (dt < 1000) return t("sideBarTaskAgeJustNow");
  const sec = Math.floor(dt / 1000);
  if (sec < 60) return t("sideBarTaskAgeSeconds", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sideBarTaskAgeMinutes", min);
  const hr = Math.floor(min / 60);
  return t("sideBarTaskAgeHours", hr);
}
