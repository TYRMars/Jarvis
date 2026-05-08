// WorkOverview rail listing recent + active SubAgent runs.
//
// Polls `/v1/subagents/runs` every 5s. The poll is fine for v1 —
// sub-agent runs are minute-scale, not millisecond-scale, and the
// 5s interval keeps the API surface simple (no WS subscription
// needed). A future iteration can subscribe to the WS frame
// `subagent_run_*` if/when the server emits run-lifecycle events
// out of band.
//
// Cards show: subagent name + model, task, elapsed, tool call
// count, status dot, cancel button when running. Click a card to
// view its detail (stub for now; the detail drawer is a follow-up).

import { useEffect, useState } from "react";
import {
  cancelSubAgentRun,
  fetchSubAgentRuns,
  type SubAgentRun,
  type SubAgentRunStatus,
} from "../../../services/subagentRuns";

const POLL_MS = 5000;

function statusColor(s: SubAgentRunStatus): string {
  switch (s) {
    case "running":
      return "var(--color-warning, #f59e0b)";
    case "completed":
      return "var(--color-success, #10b981)";
    case "failed":
      return "var(--color-error, #ef4444)";
    case "cancelled":
      return "var(--color-muted, #6b7280)";
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  return `${min.toFixed(1)}m`;
}

export function SubAgentRunsRail() {
  const [runs, setRuns] = useState<SubAgentRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancel = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function tick() {
      try {
        const items = await fetchSubAgentRuns();
        if (!cancel) {
          setRuns(items);
          setError(null);
          setUnavailable(false);
        }
      } catch (e) {
        if (cancel) return;
        const msg = String(e);
        if (msg.includes("not configured")) {
          setUnavailable(true);
        } else {
          setError(msg);
        }
      }
    }
    void tick();
    timer = setInterval(tick, POLL_MS);
    return () => {
      cancel = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  async function onCancel(id: string) {
    try {
      await cancelSubAgentRun(id);
      // Optimistic refresh — the next poll will reflect the
      // server's authoritative view, but flipping the local
      // status immediately keeps the UI from showing a stale
      // "running" until the next tick.
      setRuns((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status: "cancelled" } : r)),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  if (unavailable) {
    // Don't render an empty rail when the feature is off — the
    // card slot would just be visual noise.
    return null;
  }

  return (
    <section
      className="subagent-runs-rail"
      aria-label="Parallel SubAgent runs"
    >
      <header className="subagent-runs-rail-head">
        <h3>Parallel runs</h3>
        <p className="muted small">
          Active and recent SubAgent invocations. Polls every 5 seconds.
        </p>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {runs.length === 0 ? (
        <div className="muted small">No SubAgent runs recorded yet.</div>
      ) : (
        <ol className="subagent-runs-rail-list">
          {runs.map((r) => {
            const elapsed = formatElapsed(r.duration_ms || 0);
            return (
              <li
                key={r.id}
                className="subagent-runs-rail-card"
                data-status={r.status}
                data-testid={`subagent-run-${r.id}`}
              >
                <div className="subagent-runs-rail-card-head">
                  <span
                    className="subagent-runs-rail-status-dot"
                    style={{ background: statusColor(r.status) }}
                    aria-label={r.status}
                    title={r.status}
                  />
                  <strong>{r.name}</strong>
                  {r.model && <span className="muted small"> · {r.model}</span>}
                </div>
                {r.task && (
                  <div
                    className="subagent-runs-rail-task"
                    title={r.task}
                  >
                    {r.task.length > 80
                      ? `${r.task.slice(0, 77)}…`
                      : r.task}
                  </div>
                )}
                <div className="subagent-runs-rail-meta">
                  <span className="muted small">
                    {r.tool_call_count} tool calls · {elapsed}
                  </span>
                  {r.status === "running" && (
                    <button
                      type="button"
                      className="subagent-runs-rail-cancel"
                      onClick={() => void onCancel(r.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {r.status === "failed" && r.error && (
                  <div className="subagent-runs-rail-error muted small">
                    {r.error.slice(0, 120)}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
