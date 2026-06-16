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

  // One approver for the socket's lifetime: each gated tool call registers
  // its responder under the tool_call_id; an approve/deny frame resolves it.
  const approver: Approver = new ChannelApprover((p) => {
    pending.set(p.request.tool_call_id, p.respond);
  });

  const runTurn = async (): Promise<void> => {
    turnRunning = true;
    const agent = state.createAgent(approver);
    try {
      for await (const ev of agent.runStream(conv) as AsyncIterable<AgentEvent>) {
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
    } catch (e) {
      send({ type: "error", message: errorText(e) });
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
