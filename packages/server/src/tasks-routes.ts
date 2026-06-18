// `GET /v1/tasks` — unified background-tasks panel feed.
//
// Ported from crates/harness-server/src/tasks_routes.rs. The UI's
// BackgroundTasksPanel wants one place to see *every* kind of long-running work
// the server is currently handling, normalised into a single `TaskEntry` shape
// sorted newest-first. Only entries with a still-active lifecycle status appear
// (running / pending / waiting_*); completed / failed / cancelled runs are
// surfaced through their dedicated detail endpoints. The panel is "what's in
// flight right now", not a history view.
//
// DEGRADED SOURCES (deferred): the Rust route ALSO aggregates from
//   - `state.chat_runs` (the in-process ChatRunRegistry — `chat_run` entries), and
//   - `state.mcp` (the MCP manager — `mcp_server` entries for stopped/unhealthy
//      servers).
// Neither subsystem exists on the Node AppState yet, so this port skips them and
// aggregates only the sources that ARE present (subagent runs, requirement runs,
// automations). When those subsystems land on AppState, add their collectors
// here (and re-enable the `chat_run` branch of `taskMatchesConversation`). With
// every source absent the result is an empty list (200, never 503).
import type { FastifyInstance } from "fastify";
import type { JsonValue } from "@jarvis/core";
import type { AppState } from "./state.ts";

/**
 * Source discriminator for a {@link TaskEntry}. The serde wire strings match
 * the Rust `TaskKind` (snake_case). `chat_run` / `mcp_server` are part of the
 * wire vocabulary but never produced here yet (deferred — see file header).
 */
export type TaskKind = "chat_run" | "subagent_run" | "requirement_run" | "mcp_server" | "automation_run";

/**
 * One normalised entry across kinds. `kind` is the source discriminator and
 * `id` is unique within that kind. `label` is the one-line UI string; `detail`
 * carries the raw record so a click-into-detail UI can pivot without a second
 * fetch.
 */
export interface TaskEntry {
  kind: TaskKind;
  id: string;
  label: string;
  status: string;
  /** Epoch milliseconds. */
  started_at: number;
  /** Epoch milliseconds. */
  updated_at: number;
  detail: JsonValue;
}

/** Response body for `GET /v1/tasks`. */
export interface TasksResponse {
  items: TaskEntry[];
  /**
   * Server clock at snapshot time (ms since epoch). Lets the UI render relative
   * "started 30s ago" without trusting the client wall clock.
   */
  generated_at: number;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Parse an RFC-3339 / ISO-8601 timestamp into ms since epoch. Returns
 * `undefined` on any parse failure so callers fall back cleanly. Used to
 * normalise persisted run-store timestamps onto the same axis as the in-memory
 * registries. Mirrors Rust's `parse_rfc3339_ms` (clamped to >= 0).
 */
function parseRfc3339Ms(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, ms);
}

/** Truncate a label tail to 48 chars (char count, not byte index), appending `…`. */
function truncateTail(text: string): string {
  const chars = [...text];
  if (chars.length > 48) {
    return `${chars.slice(0, 47).join("")}…`;
  }
  return text;
}

/**
 * Whether a `TaskEntry` is scoped to the requested conversation id. Mirrors
 * Rust's `task_matches_conversation`:
 *   - subagent / requirement runs check `detail.conversation_id` when present;
 *   - automation runs never match (not conversation-scoped);
 *   - `chat_run` would match by `id` — deferred (chat runs aren't aggregated
 *     here yet), and `mcp_server` never matches.
 */
function taskMatchesConversation(task: TaskEntry, conversationId: string): boolean {
  switch (task.kind) {
    case "chat_run":
      return task.id === conversationId;
    case "subagent_run":
    case "requirement_run": {
      const detail = task.detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return false;
      const conv = (detail as { conversation_id?: unknown }).conversation_id;
      return typeof conv === "string" && conv === conversationId;
    }
    case "mcp_server":
    case "automation_run":
      return false;
  }
}

/**
 * Build a snapshot of the current `TaskEntry` set from every source present on
 * AppState. Pulled out of the handler so a future WS push path can call it on a
 * timer / event without going through HTTP. Absent sources are skipped.
 */
export async function collectTasks(state: AppState): Promise<TaskEntry[]> {
  const items: TaskEntry[] = [];

  // chat_runs — DEFERRED: no ChatRunRegistry on AppState yet (see file header).

  // Subagent runs — optional store. The store returns every known run; we
  // surface only still-running rows.
  if (state.subagentRuns) {
    for (const r of await state.subagentRuns.list()) {
      if (r.status !== "running") continue;
      // Compose a concise label: "<name>: <task-head>" with the task truncated
      // so the panel row stays readable. Truncate by char count, not byte index
      // (a long CJK / emoji task must not break the slice).
      const taskShort = truncateTail(r.task ?? "");
      const label = taskShort === "" ? r.name : `${r.name}: ${taskShort}`;
      items.push({
        kind: "subagent_run",
        id: r.id,
        label,
        status: "running",
        started_at: r.started_at,
        updated_at: r.updated_at,
        detail: r as unknown as JsonValue,
      });
    }
  }

  // Requirement runs (auto-mode picks + manual start). Only still-in-flight
  // rows. `listAll` is bounded (the store caps at ~200) so a noisy history
  // doesn't bloat the panel.
  if (state.requirementRuns) {
    let rows;
    try {
      rows = await state.requirementRuns.listAll(200);
    } catch {
      rows = undefined;
    }
    if (rows) {
      for (const r of rows) {
        if (r.status !== "pending" && r.status !== "running") continue;
        const label = `Requirement ${r.requirement_id} · ${r.status}`;
        // `started_at` is an RFC-3339 string (persisted across processes); parse
        // to millis for the panel sort. Fall back to now() for rows predating
        // the timestamp convention.
        const startedMs = parseRfc3339Ms(r.started_at) ?? nowMs();
        const updatedMs = parseRfc3339Ms(r.finished_at) ?? startedMs;
        items.push({
          kind: "requirement_run",
          id: r.id,
          label,
          status: r.status,
          started_at: startedMs,
          updated_at: updatedMs,
          detail: r as unknown as JsonValue,
        });
      }
    }
  }

  // mcp_server — DEFERRED: no MCP manager on AppState yet (see file header).

  // Automations flagged `running`.
  if (state.automations) {
    let rows;
    try {
      rows = await state.automations.list();
    } catch {
      rows = undefined;
    }
    if (rows) {
      for (const task of rows) {
        if (task.last_run_status !== "running") continue;
        const startedMs = parseRfc3339Ms(task.last_run_at) ?? nowMs();
        const updatedMs = parseRfc3339Ms(task.updated_at) ?? startedMs;
        items.push({
          kind: "automation_run",
          id: task.id,
          label: `Automation · ${task.title}`,
          status: "running",
          started_at: startedMs,
          updated_at: updatedMs,
          detail: task as unknown as JsonValue,
        });
      }
    }
  }

  // Newest first across kinds so a fresh task lands at the top regardless of
  // where it came from.
  items.sort((a, b) => b.started_at - a.started_at);
  return items;
}

export function registerTasksRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/tasks", async (req, reply) => {
    let items = await collectTasks(state);
    const conversation = (req.query as { conversation?: string }).conversation;
    if (typeof conversation === "string" && conversation.length > 0) {
      items = items.filter((t) => taskMatchesConversation(t, conversation));
    }
    const body: TasksResponse = { items, generated_at: nowMs() };
    return reply.send(body);
  });
}
