// REST client for the SubAgent runs registry
// (`GET /v1/subagents/runs`, `GET /v1/subagents/runs/:id`,
// `POST /v1/subagents/runs/:id/cancel`).
//
// The runs are populated by the server as it relays
// `AgentEvent::SubAgentEvent` frames; this module wraps the read /
// cancel endpoints. Returns 503 from the server when the binary
// didn't wire a registry — the caller surfaces that as "feature
// not configured".

import { apiUrl } from "./api";

export type SubAgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SubAgentRun {
  id: string;
  name: string;
  task?: string;
  model?: string;
  conversation_id?: string;
  status: SubAgentRunStatus;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  tool_call_count: number;
  error?: string;
  final_message?: string;
}

export interface SubAgentEventRecord {
  timestamp: number;
  frame: unknown;
}

export interface SubAgentRunDetail {
  run: SubAgentRun;
  events: SubAgentEventRecord[];
}

/// `GET /v1/subagents/runs`. Returns an empty array when the
/// registry exists but no runs have been recorded yet. Throws on
/// 503 (registry not configured) or 404 (older server build without
/// the route) so callers can render a "feature off" hint.
export async function fetchSubAgentRuns(): Promise<SubAgentRun[]> {
  const res = await fetch(apiUrl("/v1/subagents/runs"));
  if (res.status === 404 || res.status === 503) {
    throw new Error("subagent runs registry not configured");
  }
  if (!res.ok) {
    throw new Error(`GET /v1/subagents/runs failed: ${res.status}`);
  }
  const j = (await res.json()) as { items: SubAgentRun[] };
  return j.items;
}

export async function fetchSubAgentRun(id: string): Promise<SubAgentRunDetail | null> {
  const res = await fetch(apiUrl(`/v1/subagents/runs/${encodeURIComponent(id)}`));
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /v1/subagents/runs/${id} failed: ${res.status}`);
  }
  return res.json();
}

/// Cooperative cancel. Returns `true` when the run existed and was
/// running; `false` for "no such run" / "already terminal".
export async function cancelSubAgentRun(id: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/v1/subagents/runs/${encodeURIComponent(id)}/cancel`), {
    method: "POST",
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`POST /v1/subagents/runs/${id}/cancel failed: ${res.status}`);
  }
  const j = (await res.json()) as { cancelled: boolean };
  return j.cancelled;
}
