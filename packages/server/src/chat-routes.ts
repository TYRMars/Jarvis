// Chat surfaces. Ported from harness-server/src/routes.rs (the chat subset):
//   POST /v1/chat/completions          — blocking → {message, iterations, history}
//   POST /v1/chat/completions/stream   — SSE, each data: is one AgentEvent
//   GET  /v1/chat/ws                   — multi-turn WS + per-socket ChannelApprover
//
// P2 ignores per-request `provider`/`model` routing (single configured
// provider); the fields are accepted for forward-compat. The WS frame
// protocol is the documented baseline: user / reset / resume / new /
// approve / deny (the Rust handler has since grown many more frames).
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ChannelApprover,
  ChannelHuman,
  approveDecision,
  assistantText,
  denyDecision,
  errorText,
  newConversation,
  userMessage,
  type AgentEvent,
  type ApprovalDecision,
  type Approver,
  type Conversation,
  type HitlResponse,
  type HitlStatus,
  type HumanLayer,
  type Message,
} from "@jarvis/core";
import type { Tool } from "@jarvis/core";
import { toolCategory } from "@jarvis/core";
import {
  MemoryPermissionStore,
  RuleApprover,
  parsePermissionMode,
  type ModeHandle,
  type PermissionMode,
  type PermissionStore,
} from "./permissions-routes.ts";
import { streamSse } from "./sse.ts";
import type { AppState } from "./state.ts";

interface ChatCompletionsBody {
  model?: string;
  provider?: string;
  messages?: Message[];
}

/** Last assistant message in the conversation, or an empty one. */
function finalMessage(conv: Conversation): Message {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m && m.role === "assistant") return m;
  }
  return assistantText("");
}

export function registerChatRoutes(app: FastifyInstance, state: AppState): void {
  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as ChatCompletionsBody | undefined;
    if (!body || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: "missing `messages`" });
    }
    const conv: Conversation = { messages: [...body.messages] };
    try {
      const outcome = await state.createAgent().run(conv);
      return reply.send({ message: finalMessage(conv), iterations: outcome.iterations, history: conv.messages });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  app.post("/v1/chat/completions/stream", async (req, reply) => {
    const body = req.body as ChatCompletionsBody | undefined;
    if (!body || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: "missing `messages`" });
    }
    const conv: Conversation = { messages: [...body.messages] };
    await streamSse(reply, state.createAgent().runStream(conv));
  });

  app.get("/v1/chat/ws", { websocket: true }, (socket) => {
    handleWsConnection(socket as unknown as WsSocket, state);
  });

  // ---- chat-run registry (turn-status badge / reconnect replay / Stop) ----

  // Bare array of run records (the web decodes `as ServerChatRun[]`). `?active`
  // drops terminal runs.
  app.get("/v1/chat/runs", async (req, reply) => {
    if (!state.chatRuns) return reply.code(503).send({ error: "chat run registry not configured" });
    const active = (req.query as { active?: string }).active === "true";
    return reply.send(state.chatRuns.list(active));
  });

  // Buffered events with seq > ?after (bare array). Empty when untracked.
  app.get("/v1/chat/runs/:conversation_id/events", async (req, reply) => {
    if (!state.chatRuns) return reply.code(503).send({ error: "chat run registry not configured" });
    const id = (req.params as { conversation_id: string }).conversation_id;
    const afterRaw = (req.query as { after?: string }).after;
    const after = afterRaw !== undefined ? Number.parseInt(afterRaw, 10) : 0;
    return reply.send(state.chatRuns.events(id, Number.isFinite(after) ? after : 0));
  });

  // Cooperatively interrupt the conversation's in-flight turn. 404 when none.
  app.post("/v1/chat/runs/:conversation_id/interrupt", async (req, reply) => {
    if (!state.chatRuns) return reply.code(503).send({ error: "chat run registry not configured" });
    const id = (req.params as { conversation_id: string }).conversation_id;
    if (!state.chatRuns.interrupt(id)) {
      return reply.code(404).send({ error: "no active run for conversation" });
    }
    return reply.send({ ok: true });
  });
}

// ---------- WebSocket ----------

/** The subset of the `ws` WebSocket the handler uses (avoids a direct dep). */
interface WsSocket {
  send(data: string): void;
  on(event: string, listener: (data: { toString(): string }) => void): void;
  readyState: number;
  readonly OPEN: number;
}

interface WsFrame {
  type?: string;
  content?: unknown;
  id?: unknown;
  tool_call_id?: unknown;
  reason?: unknown;
  // `hitl_response` (flat, as the web AskTextCard sends it).
  request_id?: unknown;
  status?: unknown;
  payload?: unknown;
  // `start_turn` (the iOS "prepare persisted conversation + first turn" frame).
  mode?: unknown;
  // `resume` replay cursor (the client's seq high-water mark).
  after_seq?: unknown;
  // `configure` (per-socket sticky model override).
  model?: unknown;
  provider?: unknown;
  // Plan Mode: `accept_plan` / `refine_plan`.
  post_mode?: unknown;
  feedback?: unknown;
}

// Statuses the operator can return for a HITL request (mirrors core HitlStatus).
const HITL_STATUSES = new Set(["approved", "denied", "submitted", "cancelled", "expired"]);

/**
 * Rule table used when the deployment wired no PermissionStore. Empty, so
 * `evaluateTable` always falls through to the mode default — i.e. the modes
 * work on their own and only persisted *rules* need a real store.
 */
const EMPTY_PERMISSION_STORE: PermissionStore = new MemoryPermissionStore();

/**
 * Plan Mode's structural tool gate: only read-category tools reach the model.
 * `exit_plan` declares itself `read` precisely so it survives this filter and
 * gives the agent a way out of the mode.
 */
function planModeToolFilter(tool: Tool): boolean {
  return toolCategory(tool) === "read";
}

/** The synthetic user turn that carries an accepted plan into execution. */
function acceptedPlanMessage(plan: string): string {
  return plan.trim().length > 0
    ? `I approved your plan. Execute it now, step by step:\n\n${plan}`
    : "I approved your plan. Execute it now, step by step.";
}

function handleWsConnection(socket: WsSocket, state: AppState): void {
  let conv: Conversation = newConversation();
  let persistedId: string | undefined;
  let turnRunning = false;
  // Per-socket sticky model override (the `configure` frame). Applied to every
  // subsequent turn on this socket; same provider, different model id.
  let modelOverride: string | undefined;
  // Per-socket permission mode (the `set_mode` / `accept_plan` frames). Drives
  // the RuleApprover's fall-through decision live, and Plan Mode's tool filter
  // at the start of each turn. Seeded below from the store's persisted
  // `default_mode` (user > project > the env-seeded session default).
  let mode: PermissionMode = state.defaultPermissionMode ?? "ask";
  const modeHandle: ModeHandle = { get: () => mode };
  // The most recent plan the agent proposed via `exit_plan`, so `accept_plan`
  // can hand it back to the model as the execution brief.
  let proposedPlan = "";
  // Live-event subscription for the attached persisted conversation, so a
  // socket that resumed mid-run receives events from a turn another (possibly
  // dead) socket started. Undefined when unattached/untracked.
  let unsubscribe: (() => void) | undefined;
  // tool_call_id → the ChannelApprover responder awaiting a decision
  // (UNTRACKED conversations only — tracked ones register in the registry so
  // any socket on the conversation can answer after a reconnect).
  const pending = new Map<string, (d: ApprovalDecision) => void>();
  // hitl request id → the ChannelHuman responder (untracked conversations).
  const pendingHitl = new Map<string, (r: HitlResponse) => void>();

  const send = (obj: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  /** Whether the persisted conversation's turn is tracked by the registry. */
  const tracked = (): boolean => persistedId !== undefined && state.chatRuns !== undefined;

  /** (Re)subscribe this socket to the persisted conversation's live feed. */
  const attach = (id: string): void => {
    unsubscribe?.();
    unsubscribe = state.chatRuns?.subscribe(id, (rec) => {
      send({ ...(rec.frame as Record<string, unknown>), seq: rec.seq });
    });
  };

  const detach = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  // One approver for the socket's lifetime: each gated tool call registers its
  // responder under the tool_call_id; an approve/deny frame resolves it. On
  // tracked conversations the responder goes into the shared registry so it
  // survives this socket (a resumed socket re-prompts + answers it).
  const prompting: Approver = new ChannelApprover((p) => {
    if (tracked()) {
      state.chatRuns?.registerApproval(persistedId as string, {
        tool_call_id: p.request.tool_call_id,
        name: p.request.tool_name,
        arguments: p.request.arguments,
        respond: p.respond as (decision: unknown) => void,
      });
    } else {
      pending.set(p.request.tool_call_id, p.respond);
    }
  });

  // The mode + rule engine sits IN FRONT of the prompting approver: deny/allow
  // rules and the mode default resolve without a round-trip, and only an "ask"
  // outcome reaches the socket. With no store wired the table is empty, so this
  // is exactly the historical prompt-every-time behaviour under mode "ask".
  const approver: Approver = new RuleApprover(
    state.permissionStore ?? EMPTY_PERMISSION_STORE,
    prompting,
    modeHandle,
  );

  // One HITL responder for the socket's lifetime: each `ask.*` request
  // registers its responder under the request id; a `hitl_response` frame
  // resolves it. Symmetric with the approver above.
  const human: HumanLayer = new ChannelHuman((p) => {
    if (tracked()) {
      state.chatRuns?.registerHitl(persistedId as string, {
        request: p.request as unknown as { id: string } & Record<string, unknown>,
        respond: p.respond as (response: unknown) => void,
      });
    } else {
      pendingHitl.set(p.request.id, p.respond);
    }
  });

  const runTurn = async (): Promise<void> => {
    turnRunning = true;
    // Only persisted conversations are tracked (the routes key by id). `start`
    // returns the AbortSignal the loop races against so an interrupt request
    // (from the REST route, on another connection) stops emission promptly.
    const runId = persistedId;
    const signal = runId && state.chatRuns ? state.chatRuns.start(runId) : undefined;
    // Built ONCE so we don't leak an abort listener per event.
    const abortP: Promise<"aborted"> | undefined = signal
      ? new Promise<"aborted">((resolve) => {
          if (signal.aborted) resolve("aborted");
          else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        })
      : undefined;
    // Plan Mode's filter is captured per turn: a mid-turn `set_mode` changes
    // approvals live (the RuleApprover reads modeHandle) but can't re-shape a
    // catalogue the model has already been given.
    const agentOpts: { model?: string; toolFilter?: (tool: Tool) => boolean } = {};
    if (modelOverride !== undefined) agentOpts.model = modelOverride;
    if (mode === "plan") agentOpts.toolFilter = planModeToolFilter;
    const agent = state.createAgent(approver, human, agentOpts);
    let cancelled = false;
    // Tracked runs deliver events via the registry fan-out (this socket is a
    // subscriber like any other, and every frame carries its seq stamp);
    // untracked ones send directly, as before.
    const emit = (ev: unknown): void => {
      if (runId && state.chatRuns) state.chatRuns.event(runId, ev);
      else send(ev);
    };
    try {
      const it = (agent.runStream(conv) as AsyncIterable<AgentEvent>)[Symbol.asyncIterator]();
      for (;;) {
        const raced = abortP ? await Promise.race([it.next(), abortP]) : await it.next();
        if (raced === "aborted") {
          cancelled = true;
          break;
        }
        if (raced.done) break;
        const ev = raced.value;
        // Remember the plan so `accept_plan` can brief the execution turn.
        if (ev.type === "plan_proposed") proposedPlan = ev.plan;
        emit(ev);
        if (ev.type === "done") {
          conv = ev.conversation;
          if (persistedId && state.store) {
            try {
              await state.store.save(persistedId, ev.conversation);
            } catch (e) {
              send({ type: "error", message: `save failed: ${errorText(e)}` });
            }
          }
        }
      }
      if (cancelled) {
        // `interrupt()` already marked the run cancelled. `interrupted` is the
        // documented mobile frame; `cancelled` is kept for the web's handler.
        emit({ type: "interrupted" });
        send({ type: "cancelled" });
      } else if (runId && state.chatRuns) {
        state.chatRuns.finish(runId, "completed");
      }
    } catch (e) {
      const message = errorText(e);
      emit({ type: "error", message });
      if (runId && state.chatRuns) state.chatRuns.finish(runId, "failed", message);
    } finally {
      turnRunning = false;
      pending.clear();
      // Drop any unanswered HITL responders. The web client cancels its stale
      // cards on turn end (`finalizePendingHitls`); an awaiting tool whose turn
      // was aborted lives only on the abandoned generator and is GC'd with it
      // (same contract as the approval map above).
      pendingHitl.clear();
    }
  };

  const guardIdle = (): boolean => {
    // Local turn, or a live tracked turn started by another socket on the
    // same conversation — either way a second concurrent turn would race the
    // conversation state.
    const remoteLive =
      persistedId !== undefined &&
      state.chatRuns !== undefined &&
      state.chatRuns
        .list(true)
        .some((r) => r.conversation_id === persistedId);
    if (turnRunning || remoteLive) {
      send({ type: "error", message: "turn in progress" });
      return false;
    }
    return true;
  };

  /** Non-terminal run for the given conversation (a turn is live somewhere). */
  const liveRun = (id: string): boolean =>
    state.chatRuns !== undefined && state.chatRuns.list(true).some((r) => r.conversation_id === id);

  /** Shared `resume` behaviour: load + attach + `resumed` + optional replay. */
  const doResume = async (id: string, afterSeq: number | undefined): Promise<boolean> => {
    if (!state.store) {
      send({ type: "error", message: "no conversation store configured" });
      return false;
    }
    const loaded = await state.store.load(id);
    if (!loaded) {
      send({ type: "error", message: "conversation not found" });
      return false;
    }
    conv = loaded;
    persistedId = id;
    attach(id);
    const live = liveRun(id);
    send({ type: "resumed", id, message_count: conv.messages.length, live });
    if (afterSeq !== undefined && state.chatRuns) {
      // Replay the events the client missed while disconnected. A registry
      // with no memory of the conversation can't prove continuity — signal
      // `evicted` so the client falls back to a full REST reload.
      const hasRecord = state.chatRuns.list(false).some((r) => r.conversation_id === id);
      if (!hasRecord && afterSeq > 0) {
        send({ type: "resume_error", reason: "evicted" });
      } else {
        const events = state.chatRuns.events(id, afterSeq);
        send({ type: "tail_replay_start", first_seq: events[0]?.seq ?? null });
        for (const rec of events) {
          send({ ...(rec.frame as Record<string, unknown>), seq: rec.seq });
        }
        send({ type: "tail_replay_done" });
      }
    }
    if (live && state.chatRuns) {
      // Re-prompt anything still blocking the live turn: the responders are in
      // the shared registry, so THIS socket can now answer them.
      for (const a of state.chatRuns.pendingApprovals(id)) {
        send({ type: "approval_pending", id: a.tool_call_id, name: a.name, arguments: a.arguments });
      }
      for (const h of state.chatRuns.pendingHitls(id)) {
        send({ type: "hitl_request", request: h.request });
      }
    }
    return true;
  };

  const onFrame = async (raw: string): Promise<void> => {
    let msg: WsFrame;
    try {
      msg = JSON.parse(raw) as WsFrame;
    } catch {
      send({ type: "error", message: "invalid json frame" });
      return;
    }
    switch (msg.type) {
      case "user": {
        if (!guardIdle()) return;
        if (typeof msg.content !== "string") {
          send({ type: "error", message: "`user` frame requires string content" });
          return;
        }
        conv.messages.push(userMessage(msg.content));
        void runTurn();
        return;
      }
      case "reset": {
        if (!guardIdle()) return;
        conv = newConversation();
        persistedId = undefined;
        detach();
        send({ type: "reset_ok" });
        return;
      }
      case "resume": {
        // Reconnect is the point of `resume`, so the idle guard only rejects a
        // turn running on THIS socket — a live remote turn is exactly the case
        // replay + pending re-prompts exist for.
        if (turnRunning) {
          send({ type: "error", message: "turn in progress" });
          return;
        }
        if (typeof msg.id !== "string") {
          send({ type: "error", message: "`resume` frame requires id" });
          return;
        }
        const afterSeq =
          typeof msg.after_seq === "number" && Number.isFinite(msg.after_seq)
            ? Math.max(0, Math.floor(msg.after_seq))
            : undefined;
        await doResume(msg.id, afterSeq);
        return;
      }
      case "start_turn": {
        // Atomic "prepare persisted conversation + run first user turn" (the
        // iOS entry point). mode "new" mints/saves the conversation and echoes
        // `started {id}`; mode "resume" behaves like `resume` then appends.
        if (!guardIdle()) return;
        const mode = typeof msg.mode === "string" ? msg.mode : "new";
        const content = typeof msg.content === "string" ? msg.content : "";
        if (mode === "new") {
          const id = typeof msg.id === "string" && msg.id ? msg.id : randomUUID();
          conv = newConversation();
          persistedId = id;
          attach(id);
          if (state.store) {
            try {
              await state.store.save(id, conv);
            } catch (e) {
              send({ type: "error", message: `save failed: ${errorText(e)}` });
            }
          }
          send({ type: "started", id });
        } else if (mode === "resume") {
          if (typeof msg.id !== "string") {
            send({ type: "error", message: "`start_turn` resume requires id" });
            return;
          }
          const afterSeq =
            typeof msg.after_seq === "number" && Number.isFinite(msg.after_seq)
              ? Math.max(0, Math.floor(msg.after_seq))
              : undefined;
          if (!(await doResume(msg.id, afterSeq))) return;
        } else {
          send({ type: "error", message: `unknown start_turn mode: ${mode}` });
          return;
        }
        if (content.length > 0) {
          conv.messages.push(userMessage(content));
          void runTurn();
        }
        return;
      }
      case "interrupt": {
        // Cooperative stop for the conversation's live turn — works even when
        // the turn was started by another (dead) socket, via the registry.
        if (persistedId !== undefined && state.chatRuns?.interrupt(persistedId)) return;
        if (turnRunning) {
          send({ type: "error", message: "turn is not interruptible (untracked conversation)" });
          return;
        }
        send({ type: "error", message: "no turn in progress" });
        return;
      }
      case "set_mode": {
        const next = typeof msg.mode === "string" ? parsePermissionMode(msg.mode) : undefined;
        if (!next) {
          send({ type: "error", message: "mode must be one of ask|accept-edits|plan|auto|bypass" });
          return;
        }
        mode = next;
        send({ type: "permission_mode", mode, via: "user" });
        return;
      }
      case "accept_plan": {
        if (!guardIdle()) return;
        // post_mode is where the session lands for execution. Defaulting to
        // `ask` keeps the safe posture when a client omits it; staying in
        // `plan` would filter away the very tools the plan needs.
        const parsed = typeof msg.post_mode === "string" ? parsePermissionMode(msg.post_mode) : undefined;
        const next: PermissionMode = parsed === undefined || parsed === "plan" ? "ask" : parsed;
        mode = next;
        // Operator-initiated (they picked post_mode when accepting), so the
        // clients keep it silent — same as an explicit `set_mode`.
        send({ type: "permission_mode", mode, via: "user" });
        const plan = proposedPlan;
        proposedPlan = "";
        conv.messages.push(userMessage(acceptedPlanMessage(plan)));
        void runTurn();
        return;
      }
      case "refine_plan": {
        if (!guardIdle()) return;
        const feedback = typeof msg.feedback === "string" ? msg.feedback.trim() : "";
        if (feedback.length === 0) {
          send({ type: "error", message: "`refine_plan` frame requires feedback" });
          return;
        }
        // Stays in Plan Mode: the model revises and calls `exit_plan` again.
        proposedPlan = "";
        conv.messages.push(userMessage(`Revise the plan: ${feedback}`));
        void runTurn();
        return;
      }
      case "configure": {
        // Per-socket sticky model. Provider switching needs a second provider
        // runtime — reject anything but the active provider for now.
        if (turnRunning) {
          send({ type: "error", message: "cannot configure mid-turn" });
          return;
        }
        const activeProvider = state.providerCatalog?.default;
        if (typeof msg.provider === "string" && msg.provider.length > 0) {
          if (activeProvider !== undefined && msg.provider !== activeProvider) {
            send({
              type: "error",
              message: `provider switching not supported (active: ${activeProvider})`,
            });
            return;
          }
        }
        if (typeof msg.model === "string") {
          modelOverride = msg.model.length > 0 ? msg.model : undefined;
        }
        send({
          type: "configured",
          provider: activeProvider ?? null,
          model: modelOverride ?? null,
        });
        return;
      }
      case "new": {
        if (!guardIdle()) return;
        const id = typeof msg.id === "string" && msg.id ? msg.id : randomUUID();
        conv = newConversation();
        persistedId = id;
        attach(id);
        if (state.store) {
          try {
            await state.store.save(id, conv);
          } catch (e) {
            send({ type: "error", message: `save failed: ${errorText(e)}` });
          }
        }
        send({ type: "session", id });
        return;
      }
      case "approve":
      case "deny": {
        const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined;
        const decision =
          msg.type === "approve"
            ? approveDecision()
            : denyDecision(typeof msg.reason === "string" ? msg.reason : undefined);
        // Socket-local responder (untracked turns) first, then the shared
        // registry (tracked turns — answerable from any socket on the
        // conversation, including one that resumed after a reconnect).
        const local = toolCallId ? pending.get(toolCallId) : undefined;
        if (local && toolCallId) {
          pending.delete(toolCallId);
          local(decision);
          return;
        }
        if (
          toolCallId &&
          persistedId !== undefined &&
          state.chatRuns?.resolveApproval(persistedId, toolCallId, decision)
        ) {
          return;
        }
        send({ type: "error", message: "no pending approval" });
        return;
      }
      case "hitl_response": {
        // Flat frame from the web AskTextCard:
        // {type:"hitl_response", request_id, status, payload, reason}
        const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
        if (!requestId) {
          send({ type: "error", message: "no pending hitl request" });
          return;
        }
        const status: HitlStatus =
          typeof msg.status === "string" && HITL_STATUSES.has(msg.status)
            ? (msg.status as HitlStatus)
            : "submitted";
        const response: HitlResponse = {
          request_id: requestId,
          status,
          payload: (msg.payload ?? null) as HitlResponse["payload"],
          reason: typeof msg.reason === "string" ? msg.reason : null,
        };
        const local = pendingHitl.get(requestId);
        if (local) {
          pendingHitl.delete(requestId);
          local(response);
          return;
        }
        if (persistedId !== undefined && state.chatRuns?.resolveHitl(persistedId, requestId, response)) {
          return;
        }
        send({ type: "error", message: "no pending hitl request" });
        return;
      }
      default:
        send({ type: "error", message: `unknown frame type: ${String(msg.type)}` });
    }
  };

  // Resolve + announce the starting mode so the client's badge is right before
  // the first turn (the client has no other way to learn it). The STORE is
  // authoritative: a `default_mode` pinned in the user or project file must
  // govern, otherwise persisting one would change nothing. `JARVIS_PERMISSION_MODE`
  // reaches this through the store, as the session-scope seed.
  void (async () => {
    if (state.permissionStore) {
      try {
        mode = (await state.permissionStore.snapshot()).default_mode;
      } catch {
        /* keep the env default when the table can't be read */
      }
    }
    // No `via`: this is the starting state, not a change. Both clients treat
    // a `via`-carrying frame as an out-of-band switch worth surfacing (the web
    // pops a toast, iOS appends a transcript line) — `via: "tool"` is reserved
    // for a future agent-initiated `enter_plan_mode`.
    send({ type: "permission_mode", mode });
  })();

  socket.on("message", (data) => {
    void onFrame(data.toString());
  });
  socket.on("close", () => {
    detach();
  });
}
