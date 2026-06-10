import { appStore } from "../store/appStore";
import type { ConversationRunStatus } from "../store/types";
import { apiUrl } from "./api";
import { isConversationSocketOpen } from "./conversationSockets";
import { handleFrameForConversation } from "./frames";

type ServerChatRunStatus =
  | "running"
  | "waiting_approval"
  | "waiting_hitl"
  | "completed"
  | "failed"
  | "cancelled";

interface ServerChatRun {
  conversation_id: string;
  status: ServerChatRunStatus;
  started_at: number;
  updated_at: number;
  latest_seq: number;
  current_tool?: string | null;
  last_error?: string | null;
}

interface ServerChatRunEvent {
  conversation_id: string;
  seq: number;
  timestamp: number;
  frame: any;
}

const lastSeqByConversation = new Map<string, number>();
const trackedConversationIds = new Set<string>();
let pollTimer: number | null = null;
let unsupported = false;

/// Drop the cached `seq` cursor for `conversationId`. Called from
/// the WS `resume_error: evicted` / `tail_replay_start` gap-detection
/// handlers when the client has fallen behind the server's ring
/// buffer and needs to refetch persisted history from scratch
/// rather than ask for `?after=<stale-seq>` (which would just
/// re-trigger the same eviction error).
export function invalidateConversationSeq(conversationId: string): void {
  lastSeqByConversation.delete(conversationId);
}

/// Snapshot of the highest `seq` the client has observed for
/// `conversationId`. Used by gap-detection in the lifecycle frame
/// handler to decide whether `tail_replay_start.first_seq` indicates
/// dropped events, and by `resumeConversation` to populate
/// `Resume.after_seq` so reconnects only replay missing events. `0`
/// when no events have been recorded yet — the "give me everything"
/// cursor.
export function clientLastSeq(conversationId: string): number {
  return lastSeqByConversation.get(conversationId) ?? 0;
}

/// Update the cursor when a wire frame carries a numeric `seq`
/// stamp. Called from `handleFrameForConversation` for every
/// observed frame so a later disconnect → reconnect can resume
/// from `clientLastSeq(id)` instead of re-replaying the whole ring.
/// Monotonic — never moves backwards. No-op on frames without a
/// numeric `seq` (lifecycle frames, transport-level signals like
/// `tail_replay_start`, etc.).
export function observeFrameSeq(conversationId: string, seq: unknown): void {
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) return;
  const prev = lastSeqByConversation.get(conversationId) ?? 0;
  if (seq > prev) lastSeqByConversation.set(conversationId, seq);
}

export async function refreshChatRuns(): Promise<void> {
  if (unsupported) return;
  try {
    const r = await fetch(apiUrl("/v1/chat/runs"));
    if (r.status === 404) {
      unsupported = true;
      stopChatRunPolling();
      return;
    }
    if (!r.ok) return;
    const rows = (await r.json()) as ServerChatRun[];
    const seen = new Set(rows.map((row) => row.conversation_id));
    for (const row of rows) {
      appStore.getState().setConversationRunStatus(
        row.conversation_id,
        toClientStatus(row.status),
        {
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          currentTool: row.current_tool ?? null,
          lastError: row.last_error ?? null,
        },
      );
      if (isActiveStatus(row.status) || trackedConversationIds.has(row.conversation_id)) {
        trackedConversationIds.add(row.conversation_id);
        if (isConversationSocketOpen(row.conversation_id)) {
          const prev = lastSeqByConversation.get(row.conversation_id) ?? 0;
          lastSeqByConversation.set(row.conversation_id, Math.max(prev, row.latest_seq));
        }
        await replayChatRunEvents(row.conversation_id);
      }
      if (!isActiveStatus(row.status)) {
        trackedConversationIds.delete(row.conversation_id);
      }
    }
    clearMissingLocalRuns(seen);
  } catch (e) {
    console.warn("chat run refresh failed", e);
  }
}

export function startChatRunPolling(): void {
  if (unsupported) return;
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    void refreshChatRuns();
  }, 1500);
}

function stopChatRunPolling(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

export async function interruptChatRun(conversationId: string): Promise<boolean> {
  try {
    const r = await fetch(
      apiUrl(`/v1/chat/runs/${encodeURIComponent(conversationId)}/interrupt`),
      { method: "POST" },
    );
    if (!r.ok) return false;
    await refreshChatRuns();
    return true;
  } catch (e) {
    console.warn("chat run interrupt failed", e);
    return false;
  }
}

function toClientStatus(status: ServerChatRunStatus): ConversationRunStatus {
  return status;
}

async function replayChatRunEvents(conversationId: string): Promise<void> {
  if (unsupported) return;
  if (isConversationSocketOpen(conversationId)) return;
  const after = lastSeqByConversation.get(conversationId) ?? 0;
  try {
    const r = await fetch(
      apiUrl(
        `/v1/chat/runs/${encodeURIComponent(conversationId)}/events?after=${after}`,
      ),
    );
    if (r.status === 404) {
      unsupported = true;
      stopChatRunPolling();
      return;
    }
    if (!r.ok) return;
    const events = (await r.json()) as ServerChatRunEvent[];
    for (const event of events) {
      if (event.seq <= (lastSeqByConversation.get(conversationId) ?? 0)) continue;
      handleFrameForConversation(conversationId, event.frame);
      lastSeqByConversation.set(conversationId, event.seq);
    }
  } catch (e) {
    console.warn("chat run event replay failed", e);
  }
}

function isActiveStatus(status: ServerChatRunStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_hitl";
}

function clearMissingLocalRuns(seen: Set<string>): void {
  const store = appStore.getState();
  for (const run of Object.values(store.conversationRuns)) {
    if (!isClientActiveStatus(run.status)) continue;
    if (seen.has(run.conversationId)) continue;
    if (isConversationSocketOpen(run.conversationId)) continue;
    store.setConversationRunStatus(run.conversationId, "failed", {
      currentTool: null,
      lastError: "run state unavailable on server",
    });
    trackedConversationIds.delete(run.conversationId);
    lastSeqByConversation.delete(run.conversationId);
  }
}

function isClientActiveStatus(status: ConversationRunStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_hitl";
}
