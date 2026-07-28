// Chat surfaces. Ported from harness-server/src/routes.rs (the chat subset):
//   POST /v1/chat/completions          — blocking → {message, iterations, history}
//   POST /v1/chat/completions/stream   — SSE, each data: is one AgentEvent
//   GET  /v1/chat/ws                   — multi-turn WS + per-socket ChannelApprover
//
// P2 ignores per-request `provider`/`model` routing (single configured
// provider); the fields are accepted for forward-compat.
//
// ## WS frames
//
// in:  user / reset / resume / new / approve / deny / hitl_response /
//      set_mode / accept_plan / refine_plan
// out: every `AgentEvent` verbatim, plus reset_ok / resumed / session /
//      cancelled / permission_mode / plan_proposed
//
// ## Permission modes
//
// When `state.permissionStore` is wired, each socket owns a
// {@link SocketModeHandle} seeded from the store's persisted `default_mode`
// and a {@link RuleApprover} that consults the rule table before falling
// through to this socket's `ChannelApprover`. That is what makes
// `JARVIS_PERMISSION_MODE` (and stored allow/deny rules) actually gate tool
// calls rather than merely appear in `/v1/server/info`.
//
// Plan Mode additionally installs a tool filter on the per-turn agent so only
// `read` tools reach the model — enforced at dispatch too, so a write tool
// named from history still can't run. `exit_plan` is terminal: the loop stops
// the turn and we surface the plan as `plan_proposed`, which the operator
// answers with `accept_plan` (choosing the post-mode) or `refine_plan`.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ChannelApprover,
  ChannelHuman,
  approveDecision,
  assistantText,
  denyDecision,
  errorText,
  isAgentMode,
  newConversation,
  toolCategory,
  userMessage,
  type AgentEvent,
  type ApprovalDecision,
  type Approver,
  type Conversation,
  type HitlResponse,
  type HitlStatus,
  type HumanLayer,
  type Message,
  type Tool,
} from "@jarvis/core";
import {
  RuleApprover,
  SocketModeHandle,
  type HitSource,
  type PermissionMode,
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
  // `set_mode` / `accept_plan` / `refine_plan`.
  mode?: unknown;
  post_mode?: unknown;
  feedback?: unknown;
}

// Statuses the operator can return for a HITL request (mirrors core HitlStatus).
const HITL_STATUSES = new Set(["approved", "denied", "submitted", "cancelled", "expired"]);

// Synthetic user turns that resume the loop after a `plan_proposed`. They read
// as instructions rather than as the operator's own words because that is what
// they are — the operator's actual input was the button they clicked.
const ACCEPT_PLAN_PROMPT =
  "The plan you proposed is approved. Carry it out now, following the plan you " +
  "just submitted. You are no longer in Plan Mode.";
const REFINE_PLAN_PREFIX =
  "The plan you proposed was not accepted. Revise it using the feedback below, " +
  "then submit the revised plan with `exit_plan` again.";

function handleWsConnection(socket: WsSocket, state: AppState): void {
  let conv: Conversation = newConversation();
  let persistedId: string | undefined;
  let turnRunning = false;
  // tool_call_id → the ChannelApprover responder awaiting a decision.
  const pending = new Map<string, (d: ApprovalDecision) => void>();
  // hitl request id → the ChannelHuman responder awaiting the operator's answer.
  const pendingHitl = new Map<string, (r: HitlResponse) => void>();
  // tool_call_id → where the RuleApprover's decision came from, so the
  // `approval_decision` event can carry `source` for the UI's provenance chip.
  // Core emits the event without it (it knows nothing about the rule engine),
  // so we enrich in-flight.
  const decisionSources = new Map<string, HitSource>();

  const send = (obj: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  /** Send a turn frame AND record it for reconnect replay, in one shape. */
  const emit = (runId: string | undefined, frame: unknown): void => {
    if (runId && state.chatRuns) state.chatRuns.event(runId, frame);
    send(frame);
  };

  // One approver for the socket's lifetime: each gated tool call registers
  // its responder under the tool_call_id; an approve/deny frame resolves it.
  const prompt: Approver = new ChannelApprover((p) => {
    pending.set(p.request.tool_call_id, p.respond);
  });

  // Per-socket mode + rule engine. Without a permission store the socket keeps
  // the historical behaviour: prompt for every gated tool, mode fixed at "ask".
  const permissionStore = state.permissionStore;
  const modeHandle = new SocketModeHandle("ask");
  const rules = permissionStore ? new RuleApprover(permissionStore, prompt, modeHandle) : undefined;
  const approver: Approver = rules
    ? {
        approve: async (request) => {
          const [decision, source] = await rules.approveWithSource(request);
          decisionSources.set(request.tool_call_id, source);
          return decision;
        },
      }
    : prompt;

  // Adopt the persisted default mode, then tell the client (the ModeBadge /
  // PlanModeBanner render from this frame).
  let modeExplicitlySet = false;
  const announceMode = (via?: "tool" | "user"): void => {
    const mode = modeHandle.get();
    send(via ? { type: "permission_mode", mode, via } : { type: "permission_mode", mode });
  };
  const setMode = (mode: PermissionMode, via: "tool" | "user"): void => {
    modeExplicitlySet = true;
    modeHandle.set(mode);
    announceMode(via);
  };
  if (permissionStore) {
    void permissionStore
      .snapshot()
      .then((table) => {
        // A `set_mode` that raced ahead of this read wins: the operator's
        // explicit choice must not be clobbered by the persisted default
        // arriving late.
        if (modeExplicitlySet) return;
        modeHandle.set(table.default_mode);
        announceMode();
      })
      .catch(() => announceMode());
  } else {
    announceMode();
  }

  // Plan Mode restricts the model to read-only tools. Re-read per iteration, so
  // a mid-session `set_mode` lands on the next turn without rebuilding state.
  const toolFilter = (tool: Tool): boolean =>
    modeHandle.get() !== "plan" || toolCategory(tool) === "read";

  // One HITL responder for the socket's lifetime: each `ask.*` request
  // registers its responder under the request id; a `hitl_response` frame
  // resolves it. Symmetric with the approver above.
  const human: HumanLayer = new ChannelHuman((p) => {
    pendingHitl.set(p.request.id, p.respond);
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
    const agent = state.createAgent(approver, human, toolFilter);
    let cancelled = false;
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

        // `mode_changed` is the model calling `enter_plan_mode`. Apply it to
        // this socket and re-publish under the name the web listens for; the
        // raw event is not forwarded (the client has no handler for it).
        if (ev.type === "mode_changed") {
          setMode(ev.mode, ev.via);
          continue;
        }

        // Everything else goes out — and into the reconnect replay buffer — in
        // the SAME shape, so a client that replays `/v1/chat/runs/:id/events`
        // sees exactly what a live client saw.
        if (ev.type === "approval_decision") {
          // Attach the rule-engine provenance core couldn't know about.
          const source = decisionSources.get(ev.id);
          decisionSources.delete(ev.id);
          emit(runId, source ? { ...ev, source } : ev);
        } else {
          emit(runId, ev);
        }

        // `exit_plan` is terminal, so this is the last tool of the turn: hand
        // the drafted plan to the operator for accept / refine.
        if (ev.type === "tool_end" && ev.name === "exit_plan") {
          emit(runId, { type: "plan_proposed", plan: ev.content });
        }

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
        // `interrupt()` already marked the run cancelled; tell the client.
        send({ type: "cancelled" });
      } else if (runId && state.chatRuns) {
        state.chatRuns.finish(runId, "completed");
      }
    } catch (e) {
      const message = errorText(e);
      send({ type: "error", message });
      if (runId && state.chatRuns) state.chatRuns.finish(runId, "failed", message);
    } finally {
      turnRunning = false;
      pending.clear();
      decisionSources.clear();
      // Drop any unanswered HITL responders. The web client cancels its stale
      // cards on turn end (`finalizePendingHitls`); an awaiting tool whose turn
      // was aborted lives only on the abandoned generator and is GC'd with it
      // (same contract as the approval map above).
      pendingHitl.clear();
    }
  };

  const guardIdle = (): boolean => {
    if (turnRunning) {
      send({ type: "error", message: "turn in progress" });
      return false;
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
        send({ type: "reset_ok" });
        return;
      }
      case "resume": {
        if (!guardIdle()) return;
        if (!state.store) {
          send({ type: "error", message: "no conversation store configured" });
          return;
        }
        if (typeof msg.id !== "string") {
          send({ type: "error", message: "`resume` frame requires id" });
          return;
        }
        const loaded = await state.store.load(msg.id);
        if (!loaded) {
          send({ type: "error", message: "conversation not found" });
          return;
        }
        conv = loaded;
        persistedId = msg.id;
        send({ type: "resumed", id: msg.id });
        return;
      }
      case "new": {
        if (!guardIdle()) return;
        const id = typeof msg.id === "string" && msg.id ? msg.id : randomUUID();
        conv = newConversation();
        persistedId = id;
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
      case "approve": {
        const respond = typeof msg.tool_call_id === "string" ? pending.get(msg.tool_call_id) : undefined;
        if (!respond) {
          send({ type: "error", message: "no pending approval" });
          return;
        }
        pending.delete(msg.tool_call_id as string);
        respond(approveDecision());
        return;
      }
      case "deny": {
        const respond = typeof msg.tool_call_id === "string" ? pending.get(msg.tool_call_id) : undefined;
        if (!respond) {
          send({ type: "error", message: "no pending approval" });
          return;
        }
        pending.delete(msg.tool_call_id as string);
        respond(denyDecision(typeof msg.reason === "string" ? msg.reason : undefined));
        return;
      }
      case "hitl_response": {
        // Flat frame from the web AskTextCard:
        // {type:"hitl_response", request_id, status, payload, reason}
        const requestId = typeof msg.request_id === "string" ? msg.request_id : undefined;
        const respond = requestId ? pendingHitl.get(requestId) : undefined;
        if (!respond) {
          send({ type: "error", message: "no pending hitl request" });
          return;
        }
        const status: HitlStatus =
          typeof msg.status === "string" && HITL_STATUSES.has(msg.status)
            ? (msg.status as HitlStatus)
            : "submitted";
        const response: HitlResponse = {
          request_id: requestId as string,
          status,
          payload: (msg.payload ?? null) as HitlResponse["payload"],
          reason: typeof msg.reason === "string" ? msg.reason : null,
        };
        pendingHitl.delete(requestId as string);
        respond(response);
        return;
      }
      case "set_mode": {
        // Per-socket and ephemeral: does NOT rewrite the persisted default
        // (that's `PUT /v1/permissions/mode`). Allowed mid-turn — the filter
        // and the approver both read the handle live — but the tool catalogue
        // only changes on the next request build.
        if (!isAgentMode(msg.mode)) {
          send({ type: "error", message: "`set_mode` frame requires a valid mode" });
          return;
        }
        setMode(msg.mode, "user");
        return;
      }
      case "accept_plan": {
        if (!guardIdle()) return;
        // The operator accepted the plan and picked the mode to carry it out
        // in. Switch first so the resumed turn is built with the new filter.
        const post: PermissionMode = isAgentMode(msg.post_mode) ? msg.post_mode : "ask";
        setMode(post, "user");
        conv.messages.push(userMessage(ACCEPT_PLAN_PROMPT));
        void runTurn();
        return;
      }
      case "refine_plan": {
        if (!guardIdle()) return;
        if (typeof msg.feedback !== "string" || msg.feedback.trim().length === 0) {
          send({ type: "error", message: "`refine_plan` frame requires non-empty feedback" });
          return;
        }
        // Stay in Plan Mode; the feedback comes back as a plain user turn.
        conv.messages.push(userMessage(`${REFINE_PLAN_PREFIX}\n\n${msg.feedback}`));
        void runTurn();
        return;
      }
      default:
        send({ type: "error", message: `unknown frame type: ${String(msg.type)}` });
    }
  };

  socket.on("message", (data) => {
    void onFrame(data.toString());
  });
}
