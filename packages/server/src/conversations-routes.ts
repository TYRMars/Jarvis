// Persisted-conversation CRUD. Ported from harness-server/src/conversations.rs
// (the P2 subset). Every route 503s when no ConversationStore is configured,
// so callers can tell "no persistence" from "not found". Ids starting with
// `__` (internal summary cache) are filtered from list and refused by
// get/delete/post; create rejects them.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { assistantText, errorText, newConversation, systemMessage, userMessage, type Conversation, type Message } from "@jarvis/core";
import type { ConversationStore } from "@jarvis/store";
import { streamSse } from "./sse.ts";
import { isInternalId, type AppState } from "./state.ts";

const DEFAULT_LIMIT = 50;

/** Return the store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): ConversationStore | undefined {
  if (!state.store) {
    reply.code(503).send({ error: "conversation persistence not configured" });
    return undefined;
  }
  return state.store;
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, 500);
}

function finalMessage(conv: Conversation): Message {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m && m.role === "assistant") return m;
  }
  return assistantText("");
}

export function registerConversationsRoutes(app: FastifyInstance, state: AppState): void {
  // create
  app.post("/v1/conversations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { system?: string; id?: string };
    const id = typeof body.id === "string" && body.id ? body.id : randomUUID();
    if (isInternalId(id)) {
      return reply.code(400).send({ error: "ids starting with `__` are reserved for internal use" });
    }
    const conv = newConversation();
    if (typeof body.system === "string") conv.messages.push(systemMessage(body.system));
    try {
      await store.save(id, conv);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send({ id });
  });

  // list (internal ids filtered out)
  //
  // Contract: a BARE JSON array, newest-first — byte-aligned with the Rust
  // `harness-server` (`Json(out)` in conversations.rs) and what both clients
  // decode (web `setConvoRows(rows)`, iOS `[ConversationSummary]`). It must NOT
  // be wrapped in an `{ conversations: [...] }` envelope; the iOS contract smoke
  // test (apps/jarvis-ios/Tests) and conversations-routes.test.ts guard this.
  app.get("/v1/conversations", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const limit = clampLimit((req.query as { limit?: string }).limit);
    try {
      const rows = (await store.list(limit)).filter((r) => !isInternalId(r.id));
      return reply.send(rows);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // get one
  app.get("/v1/conversations/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const env = await store.loadEnvelope(id);
      if (!env) return reply.code(404).send({ error: "conversation not found" });
      const [conv, meta] = env;
      return reply.send({ id, messages: conv.messages, project_id: meta.project_id ?? null });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // delete one
  app.delete("/v1/conversations/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const deleted = await store.delete(id);
      return reply.code(deleted ? 200 : 404).send({ deleted });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // append a user message, run the agent, save → {id, message, iterations, history}
  app.post("/v1/conversations/:id/messages", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = req.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.code(400).send({ error: "missing `content`" });
    }
    let env: [Conversation, import("@jarvis/store").ConversationMetadata] | undefined;
    try {
      env = await store.loadEnvelope(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!env) return reply.code(404).send({ error: "conversation not found" });
    const [conv, meta] = env;
    conv.messages.push(userMessage(body.content));
    try {
      const outcome = await state.createAgent().run(conv);
      // Save failure is logged-and-tolerated in Rust; here we still return the reply.
      try {
        await store.saveEnvelope(id, conv, meta);
      } catch {
        /* tolerate save failure */
      }
      return reply.send({
        id,
        message: finalMessage(conv),
        iterations: outcome.iterations,
        history: conv.messages,
      });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // streaming variant — SSE, saves on the terminal `done`
  app.post("/v1/conversations/:id/messages/stream", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (isInternalId(id)) return reply.code(404).send({ error: "conversation not found" });
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = req.body as { content?: string } | undefined;
    if (!body || typeof body.content !== "string") {
      return reply.code(400).send({ error: "missing `content`" });
    }
    const env = await store.loadEnvelope(id);
    if (!env) return reply.code(404).send({ error: "conversation not found" });
    const [conv, meta] = env;
    conv.messages.push(userMessage(body.content));
    await streamSse(reply, state.createAgent().runStream(conv), async (ev) => {
      if (ev.type === "done") {
        try {
          await store.saveEnvelope(id, ev.conversation, meta);
        } catch {
          /* tolerate save failure */
        }
      }
    });
  });
}
