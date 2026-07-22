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
import { realpathSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  ChannelApprover,
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
  type Message,
} from "@jarvis/core";
import { todoEventWorkspace, type TodoEvent } from "@jarvis/todo";
import type { RequirementEvent } from "@jarvis/project";
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

/**
 * Stable key for a workspace path (resolve symlinks + normalise). Mirrors
 * `todos-routes.ts::canonicalizeWorkspace` so the socket's pinned-root filter
 * compares against the same canonical form the stores persist.
 */
function canonicalizeWorkspace(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Wire the store-side fanout to a WebSocket. The `@jarvis/todo` and
 * `@jarvis/project` stores are `EventSource`s: every successful mutation
 * (from a `todo.*` / `requirement.*` tool call OR a REST request) fans out a
 * `TodoEvent` / `RequirementEvent` to their subscribers. Without this bridge
 * the fanout has zero subscribers, so the SPA's `todo_upserted` /
 * `todo_deleted` / `requirement_upserted` / `requirement_deleted` frame
 * handlers never fire and open boards silently go stale (#507).
 *
 * TODO events are filtered to the socket's pinned workspace (when the server
 * has one) — mirroring the Rust WS handler's `todoEventWorkspace()` filter —
 * so a mutation in one workspace never leaks into another's rail. Requirement
 * events are project-scoped (the SPA reconciles by `project_id`), so they are
 * forwarded unfiltered.
 *
 * Returns an unsubscribe that detaches every listener; the caller invokes it
 * on socket close so a closed socket leaves no dangling listener behind.
 */
function bridgeDomainEvents(state: AppState, send: (obj: unknown) => void): () => void {
  const unsubscribes: Array<() => void> = [];

  if (state.todos) {
    const pinnedRoot = state.workspaceRoot ? canonicalizeWorkspace(state.workspaceRoot) : undefined;
    unsubscribes.push(
      state.todos.subscribe((ev: TodoEvent) => {
        if (pinnedRoot !== undefined && todoEventWorkspace(ev) !== pinnedRoot) return;
        if (ev.type === "upserted") {
          const { type: _type, ...todo } = ev;
          send({ type: "todo_upserted", todo });
        } else {
          send({ type: "todo_deleted", id: ev.id, workspace: ev.workspace });
        }
      }),
    );
  }

  if (state.requirements) {
    unsubscribes.push(
      state.requirements.subscribe((ev: RequirementEvent) => {
        if (ev.type === "upserted") {
          const { type: _type, ...requirement } = ev;
          send({ type: "requirement_upserted", requirement });
        } else {
          send({ type: "requirement_deleted", id: ev.id, project_id: ev.project_id });
        }
      }),
    );
  }

  return () => {
    for (const unsub of unsubscribes) unsub();
    unsubscribes.length = 0;
  };
}

interface WsFrame {
  type?: string;
  content?: unknown;
  id?: unknown;
  tool_call_id?: unknown;
  reason?: unknown;
}

function handleWsConnection(socket: WsSocket, state: AppState): void {
  let conv: Conversation = newConversation();
  let persistedId: string | undefined;
  let turnRunning = false;
  // tool_call_id → the ChannelApprover responder awaiting a decision.
  const pending = new Map<string, (d: ApprovalDecision) => void>();

  const send = (obj: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
  };

  // Subscribe this socket to the store-side fanout so REST/tool mutations to
  // the TODO board and Requirement kanban reach the SPA as live frames (#507).
  const unbridge = bridgeDomainEvents(state, send);
  socket.on("close", () => unbridge());

  // One approver for the socket's lifetime: each gated tool call registers
  // its responder under the tool_call_id; an approve/deny frame resolves it.
  const approver: Approver = new ChannelApprover((p) => {
    pending.set(p.request.tool_call_id, p.respond);
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
    const agent = state.createAgent(approver);
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
        if (runId && state.chatRuns) state.chatRuns.event(runId, ev);
        send(ev);
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
      default:
        send({ type: "error", message: `unknown frame type: ${String(msg.type)}` });
    }
  };

  socket.on("message", (data) => {
    void onFrame(data.toString());
  });
}
