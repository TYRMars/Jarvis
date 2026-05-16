// Background-tasks panel — a single "what's in flight right now"
// view that aggregates chat turns, subagent runs, and (over time)
// auto-mode picks / MCP / shell jobs into one list. Backed by the
// `GET /v1/tasks` aggregator; polled while open and immediately
// stopped when the panel closes so a quiet system doesn't pay for
// idle fetches.

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../../services/api";
import { useAppStore } from "../../store/appStore";

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
    <div className="bg-tasks-panel" role="dialog" aria-label="Background tasks">
      <header className="bg-tasks-header">
        <h2>Background tasks</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="bg-tasks-close"
        >
          ×
        </button>
      </header>
      <div className="bg-tasks-body">
        {error && (
          <div className="bg-tasks-error" role="alert">
            Failed to load: {error}
          </div>
        )}
        {!error && tasks.length === 0 && !loading && (
          <div className="bg-tasks-empty">No active work right now.</div>
        )}
        {tasks.length > 0 && (
          <ul className="bg-tasks-list">
            {tasks.map((t) => (
              <li
                key={`${t.kind}-${t.id}`}
                className="bg-tasks-row"
                data-kind={t.kind}
                data-status={t.status}
              >
                <span className="bg-tasks-kind">{kindLabel(t.kind)}</span>
                <span className="bg-tasks-label">{t.label}</span>
                <span className="bg-tasks-status">{t.status}</span>
                <span className="bg-tasks-age">{relativeAge(t.started_at)}</span>
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
      return "Chat";
    case "subagent_run":
      return "SubAgent";
    case "requirement_run":
      return "Requirement";
    case "mcp_server":
      return "MCP";
    default:
      return k;
  }
}

function relativeAge(startedAt: number): string {
  const dt = Math.max(0, Date.now() - startedAt);
  if (dt < 1000) return "just now";
  const sec = Math.floor(dt / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}
