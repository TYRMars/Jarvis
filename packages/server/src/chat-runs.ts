// In-process chat-run registry. Ported (the MVP subset) from
// harness-server/src/chat_runs.rs. Tracks, per persisted conversation, a run
// record (status / seq / current tool / last error) plus a capped ring buffer
// of the AgentEvents emitted during the turn. Powers three routes the web
// polls: GET /v1/chat/runs (turn-status badge), GET /v1/chat/runs/:id/events
// (reconnect replay), POST /v1/chat/runs/:id/interrupt (Stop button).
//
// MVP simplifications vs the Rust original (documented, not silent): no live
// broadcast channel (the client polls every ~1.5s instead of streaming), and
// no per-conversation byte budget / frame truncation — only a count cap. The
// interrupt is cooperative: it aborts the per-turn AbortController so the WS
// loop stops emitting immediately and marks the run cancelled, but it does not
// hard-cancel an in-flight LLM call (Node has no tokio::task::abort analogue;
// the underlying request finishes server-side and its result is discarded).

/** Lifecycle of a chat run. Wire strings match the web `ServerChatRunStatus`. */
export type ChatRunStatus =
  | "running"
  | "waiting_approval"
  | "waiting_hitl"
  | "completed"
  | "failed"
  | "cancelled";

/** Per-conversation run snapshot returned by `GET /v1/chat/runs`. */
export interface ChatRunRecord {
  conversation_id: string;
  status: ChatRunStatus;
  started_at: number;
  updated_at: number;
  latest_seq: number;
  current_tool?: string | null;
  last_error?: string | null;
}

/** One buffered event returned by `GET /v1/chat/runs/:id/events`. */
export interface ChatRunEventRecord {
  conversation_id: string;
  seq: number;
  timestamp: number;
  frame: unknown;
}

interface RunState {
  record: ChatRunRecord;
  events: ChatRunEventRecord[];
  abort: AbortController;
}

const MAX_EVENTS = 1000;
const MAX_RETAINED_TERMINAL = 256;
const TERMINAL_RETENTION_MS = 5 * 60_000;

export function chatRunStatusIsTerminal(s: ChatRunStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export class ChatRunRegistry {
  #runs = new Map<string, RunState>();

  /**
   * Begin (or restart) tracking a turn for `conversationId`. Returns the
   * AbortSignal the WS loop should race against so an interrupt stops emission.
   */
  start(conversationId: string): AbortSignal {
    const now = Date.now();
    const abort = new AbortController();
    this.#runs.set(conversationId, {
      record: {
        conversation_id: conversationId,
        status: "running",
        started_at: now,
        updated_at: now,
        latest_seq: 0,
        current_tool: null,
        last_error: null,
      },
      events: [],
      abort,
    });
    this.#evictTerminal();
    return abort.signal;
  }

  /** Buffer one AgentEvent + advance the run's status/seq/current-tool. */
  event(conversationId: string, frame: unknown): void {
    const st = this.#runs.get(conversationId);
    if (!st) return;
    const now = Date.now();
    const seq = st.record.latest_seq + 1;
    st.record.latest_seq = seq;
    st.record.updated_at = now;
    const type = (frame as { type?: string })?.type;
    if (type === "approval_request") {
      st.record.status = "waiting_approval";
      st.record.current_tool = null;
    } else if (type === "hitl_request") {
      // Native HITL pause (ask.text etc.): the turn is blocked on the operator,
      // not actively working. Mirror the approval_request → waiting_approval arm.
      st.record.status = "waiting_hitl";
      st.record.current_tool = null;
    } else if (type === "tool_start") {
      st.record.status = "running";
      st.record.current_tool = (frame as { name?: string }).name ?? null;
    } else if (type === "tool_end") {
      st.record.current_tool = null;
    } else if (type === "hitl_response") {
      // Operator answered → the turn resumes.
      if (st.record.status === "waiting_hitl") st.record.status = "running";
    } else if (type === "approval_decision") {
      if (st.record.status === "waiting_approval") st.record.status = "running";
    } else if (type === "delta") {
      // Streamed output means the turn resumed from whichever pause it was in.
      if (st.record.status === "waiting_approval" || st.record.status === "waiting_hitl") {
        st.record.status = "running";
      }
    }
    st.events.push({ conversation_id: conversationId, seq, timestamp: now, frame });
    if (st.events.length > MAX_EVENTS) st.events.shift();
  }

  /** Stamp a terminal (or interim) status. Terminal status is sticky. */
  finish(conversationId: string, status: ChatRunStatus, error?: string): void {
    const st = this.#runs.get(conversationId);
    if (!st) return;
    if (chatRunStatusIsTerminal(st.record.status)) return;
    st.record.status = status;
    st.record.updated_at = Date.now();
    st.record.current_tool = null;
    if (error !== undefined) st.record.last_error = error;
  }

  /**
   * Abort the conversation's in-flight turn (cooperative). Returns false when
   * there's no active run to interrupt. Mirrors `interrupt`.
   */
  interrupt(conversationId: string): boolean {
    const st = this.#runs.get(conversationId);
    if (!st || chatRunStatusIsTerminal(st.record.status)) return false;
    st.abort.abort();
    st.record.status = "cancelled";
    st.record.updated_at = Date.now();
    st.record.current_tool = null;
    return true;
  }

  /** All run records (newest-updated first); `activeOnly` drops terminal ones. */
  list(activeOnly: boolean): ChatRunRecord[] {
    const out = [...this.#runs.values()]
      .map((s) => s.record)
      .filter((r) => !activeOnly || !chatRunStatusIsTerminal(r.status));
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  }

  /** Buffered events for a conversation with `seq > after`. */
  events(conversationId: string, after: number): ChatRunEventRecord[] {
    const st = this.#runs.get(conversationId);
    if (!st) return [];
    return st.events.filter((e) => e.seq > after);
  }

  /** Evict terminal runs older than the retention window or beyond the cap. */
  #evictTerminal(): void {
    const now = Date.now();
    const terminal: Array<[string, RunState]> = [];
    for (const [id, st] of this.#runs) {
      if (!chatRunStatusIsTerminal(st.record.status)) continue;
      if (now - st.record.updated_at > TERMINAL_RETENTION_MS) {
        this.#runs.delete(id);
      } else {
        terminal.push([id, st]);
      }
    }
    if (terminal.length > MAX_RETAINED_TERMINAL) {
      terminal.sort((a, b) => a[1].record.updated_at - b[1].record.updated_at);
      for (const [id] of terminal.slice(0, terminal.length - MAX_RETAINED_TERMINAL)) {
        this.#runs.delete(id);
      }
    }
  }
}
