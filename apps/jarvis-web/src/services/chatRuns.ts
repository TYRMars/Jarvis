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
        await replayChatRunEvents(row.conversation_id);
      }
      if (!isActiveStatus(row.status)) {
        trackedConversationIds.delete(row.conversation_id);
      }
    }
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
