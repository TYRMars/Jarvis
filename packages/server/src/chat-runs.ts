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

/** A gated tool call awaiting an operator decision, adoptable across sockets. */
export interface PendingApprovalEntry {
  tool_call_id: string;
  name: string;
  arguments: unknown;
  respond: (decision: unknown) => void;
}

/** An `ask.*` HITL request awaiting an operator answer, adoptable across sockets. */
export interface PendingHitlEntry {
  request: { id: string } & Record<string, unknown>;
  respond: (response: unknown) => void;
}

interface RunState {
  record: ChatRunRecord;
  events: ChatRunEventRecord[];
  abort: AbortController;
  /** tool_call_id → adoptable approval responder (survives the origin socket). */
  approvals: Map<string, PendingApprovalEntry>;
  /** hitl request id → adoptable responder (survives the origin socket). */
  hitls: Map<string, PendingHitlEntry>;
}

const MAX_EVENTS = 1000;
const MAX_RETAINED_TERMINAL = 256;
const TERMINAL_RETENTION_MS = 5 * 60_000;

export function chatRunStatusIsTerminal(s: ChatRunStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export class ChatRunRegistry {
  #runs = new Map<string, RunState>();
  /** conversation id → live-event listeners (one per socket viewing it).
   * Keyed independently of run records so a socket can subscribe to an idle
   * conversation and receive events from turns started later (or elsewhere). */
  #listeners = new Map<string, Set<(ev: ChatRunEventRecord) => void>>();

  /**
   * Subscribe to the conversation's live event feed. Every buffered event is
   * also fanned out to subscribers, so a socket that resumed mid-run keeps
   * receiving the turn started by another (possibly dead) socket. Returns the
   * unsubscribe function.
   */
  subscribe(conversationId: string, listener: (ev: ChatRunEventRecord) => void): () => void {
    let set = this.#listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.#listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      const s = this.#listeners.get(conversationId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.#listeners.delete(conversationId);
    };
  }

  /**
   * Begin (or restart) tracking a turn for `conversationId`. Returns the
   * AbortSignal the WS loop should race against so an interrupt stops emission.
   */
  start(conversationId: string): AbortSignal {
    const now = Date.now();
    const abort = new AbortController();
    // seq is monotonic per CONVERSATION, not per turn: a reconnecting client
    // resumes with its `after_seq` high-water mark, and a turn that started
    // while it was away must not reuse already-consumed numbers (the replay
    // gap check depends on it). The event buffer itself is still per-turn, so
    // a cross-turn cursor surfaces as a first_seq gap → client full-reloads.
    const prevSeq = this.#runs.get(conversationId)?.record.latest_seq ?? 0;
    this.#runs.set(conversationId, {
      record: {
        conversation_id: conversationId,
        status: "running",
        started_at: now,
        updated_at: now,
        latest_seq: prevSeq,
        current_tool: null,
        last_error: null,
      },
      events: [],
      abort,
      approvals: new Map(),
      hitls: new Map(),
    });
    this.#evictTerminal();
    return abort.signal;
  }

  /**
   * Buffer one AgentEvent + advance the run's status/seq/current-tool, fan the
   * stamped record out to live subscribers, and return the assigned seq (so
   * the WS can stamp the same number onto the frame it sends). Undefined when
   * the conversation isn't tracked.
   */
  event(conversationId: string, frame: unknown): number | undefined {
    const st = this.#runs.get(conversationId);
    if (!st) return undefined;
    const now = Date.now();
    const seq = st.record.latest_seq + 1;
    st.record.latest_seq = seq;
    st.record.updated_at = now;
    const type = (frame as { type?: string })?.type;
    if (type === "approval_request") {
      st.record.status = "waiting_approval";
      st.record.current_tool = null;
    } else if (type === "hitl_request") {
      st.record.status = "waiting_hitl";
    } else if (type === "tool_start") {
      st.record.status = "running";
      st.record.current_tool = (frame as { name?: string }).name ?? null;
    } else if (type === "tool_end") {
      st.record.current_tool = null;
    } else if (type === "approval_decision" || type === "hitl_response" || type === "delta") {
      if (st.record.status === "waiting_approval" || st.record.status === "waiting_hitl") {
        st.record.status = "running";
      }
    }
    const record: ChatRunEventRecord = { conversation_id: conversationId, seq, timestamp: now, frame };
    st.events.push(record);
    if (st.events.length > MAX_EVENTS) st.events.shift();
    const listeners = this.#listeners.get(conversationId);
    if (listeners) for (const l of listeners) l(record);
    return seq;
  }

  // ---- adoptable pending approvals / HITL requests -------------------------
  //
  // The per-socket responder maps can't survive a dropped connection, so gated
  // tool calls and ask.* requests on TRACKED conversations register here too.
  // A socket that resumes the conversation re-prompts from these entries
  // (`approval_pending` / re-sent `hitl_request`) and resolves them by id.

  registerApproval(conversationId: string, entry: PendingApprovalEntry): void {
    this.#runs.get(conversationId)?.approvals.set(entry.tool_call_id, entry);
  }

  /** Resolve (and drop) a pending approval; false when unknown. */
  resolveApproval(conversationId: string, toolCallId: string, decision: unknown): boolean {
    const st = this.#runs.get(conversationId);
    const entry = st?.approvals.get(toolCallId);
    if (!st || !entry) return false;
    st.approvals.delete(toolCallId);
    entry.respond(decision);
    return true;
  }

  pendingApprovals(conversationId: string): PendingApprovalEntry[] {
    return [...(this.#runs.get(conversationId)?.approvals.values() ?? [])];
  }

  registerHitl(conversationId: string, entry: PendingHitlEntry): void {
    this.#runs.get(conversationId)?.hitls.set(entry.request.id, entry);
  }

  /** Resolve (and drop) a pending HITL request; false when unknown. */
  resolveHitl(conversationId: string, requestId: string, response: unknown): boolean {
    const st = this.#runs.get(conversationId);
    const entry = st?.hitls.get(requestId);
    if (!st || !entry) return false;
    st.hitls.delete(requestId);
    entry.respond(response);
    return true;
  }

  pendingHitls(conversationId: string): PendingHitlEntry[] {
    return [...(this.#runs.get(conversationId)?.hitls.values() ?? [])];
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
    if (chatRunStatusIsTerminal(status)) {
      // Unanswered responders live on the finished turn's abandoned generator.
      st.approvals.clear();
      st.hitls.clear();
    }
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
    st.approvals.clear();
    st.hitls.clear();
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
