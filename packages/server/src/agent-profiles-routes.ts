// REST routes for named AgentProfiles. Ported from
// crates/harness-server/src/agent_profiles_routes.rs.
//
// Process-wide CRUD; every handler 503s when `state.agentProfiles` is unset —
// the same "not configured" convention as conversations / requirements / todos
// (mirrors the Rust `require_store` → 503 path). Endpoints:
//
//   - GET    /v1/agent-profiles       — list, sorted by name asc.
//   - POST   /v1/agent-profiles       — create (body: {name, provider, model, ...}) → 201.
//   - GET    /v1/agent-profiles/:id   — fetch one (404 when absent).
//   - PATCH  /v1/agent-profiles/:id   — partial update (any subset of editable fields).
//   - DELETE /v1/agent-profiles/:id   — remove (idempotent: 200 deleted / 404 absent).
//
// Wire-form parity with the Rust handler: the optional fields (`avatar`,
// `system_prompt`, `default_workspace`) are stored as ABSENT (not `null` / not
// `""`) when blank. On create we trim each and, when the trimmed value is empty,
// leave the key off entirely (`newProfile` already omits them). On PATCH a
// present field whose trimmed value is empty CLEARS the key (deletes it); a
// present non-empty value sets the trimmed string; an absent field is left
// as-is. `allowed_tools` defaults to `[]` on create and is replaced wholesale
// when present on PATCH. Every mutation runs through `touchProfile` parity:
// create stamps via `newProfile`, PATCH calls `touchProfile` before the upsert.
//
// NOTE: the Rust handler broadcasts AgentProfileEvents for the WS bridge to
// forward as `agent_profile_upserted` / `agent_profile_deleted`. That fanout is
// owned by the store itself (`MemoryAgentProfileStore` / `JsonFileAgentProfileStore`
// emit on upsert/delete), so no extra wiring is needed here; the WS bridge that
// subscribes lives outside this route module.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText } from "@jarvis/core";
import {
  newProfile,
  touchProfile,
  type AgentProfile,
  type AgentProfileStore,
} from "@jarvis/agent-profile";
import type { AppState } from "./state.ts";

// ---------- request bodies --------------------------------------------------

interface CreateBody {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  avatar?: unknown;
  system_prompt?: unknown;
  default_workspace?: unknown;
  allowed_tools?: unknown;
}

interface UpdateBody {
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  avatar?: unknown;
  system_prompt?: unknown;
  default_workspace?: unknown;
  allowed_tools?: unknown;
}

// ---------- store guard -----------------------------------------------------

/** Return the agent-profile store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): AgentProfileStore | undefined {
  if (!state.agentProfiles) {
    reply.code(503).send({ error: "agent profile store not configured" });
    return undefined;
  }
  return state.agentProfiles;
}

// ---------- helpers ---------------------------------------------------------

/** Trim `value` when it's a string; non-strings collapse to "". */
function trimStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A list of strings, or undefined when `value` isn't a string array. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === "string")) return undefined;
  return value as string[];
}

/** The 404 body the Rust handler emits for a missing id. */
function notFound(reply: FastifyReply, id: string): FastifyReply {
  return reply.code(404).send({ error: `agent profile \`${id}\` not found` });
}

// ---------- routes ----------------------------------------------------------

export function registerAgentProfilesRoutes(app: FastifyInstance, state: AppState): void {
  // GET /v1/agent-profiles — list (store sorts by name asc, soft-caps at 200).
  app.get("/v1/agent-profiles", async (_req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const items = await store.list();
      return reply.send({ items });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // POST /v1/agent-profiles — create.
  app.post("/v1/agent-profiles", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as CreateBody;

    const name = trimStr(body.name);
    if (name.length === 0) {
      return reply.code(400).send({ error: "`name` must not be blank" });
    }
    const provider = trimStr(body.provider);
    if (provider.length === 0) {
      return reply.code(400).send({ error: "`provider` must not be blank" });
    }
    const model = trimStr(body.model);
    if (model.length === 0) {
      return reply.code(400).send({ error: "`model` must not be blank" });
    }

    const p = newProfile(name, provider, model);
    // Optional fields: set the trimmed value only when non-empty; otherwise
    // leave the key ABSENT (newProfile already omits them) — wire-form parity
    // with the Rust `.map(trim).filter(!empty)`.
    const avatar = trimStr(body.avatar);
    if (avatar.length > 0) p.avatar = avatar;
    const systemPrompt = trimStr(body.system_prompt);
    if (systemPrompt.length > 0) p.system_prompt = systemPrompt;
    const defaultWorkspace = trimStr(body.default_workspace);
    if (defaultWorkspace.length > 0) p.default_workspace = defaultWorkspace;
    // `allowed_tools` defaults to [] (mirrors Rust `unwrap_or_default`).
    p.allowed_tools = asStringArray(body.allowed_tools) ?? [];

    try {
      await store.upsert(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(p);
  });

  // GET /v1/agent-profiles/:id — fetch one.
  app.get("/v1/agent-profiles/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const p = await store.get(id);
      if (!p) return notFound(reply, id);
      return reply.send(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // PATCH /v1/agent-profiles/:id — partial update.
  app.patch("/v1/agent-profiles/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;

    let p: AgentProfile | undefined;
    try {
      p = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!p) return notFound(reply, id);

    const body = (req.body ?? {}) as UpdateBody;

    // Required-on-set fields: a present value must be non-blank after trim.
    if (body.name !== undefined) {
      const trimmed = trimStr(body.name);
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "`name` must not be blank" });
      }
      p.name = trimmed;
    }
    if (body.provider !== undefined) {
      const trimmed = trimStr(body.provider);
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "`provider` must not be blank" });
      }
      p.provider = trimmed;
    }
    if (body.model !== undefined) {
      const trimmed = trimStr(body.model);
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "`model` must not be blank" });
      }
      p.model = trimmed;
    }
    // Clearable optionals: present-and-empty CLEARS (deletes the key), present-
    // and-non-empty sets the trimmed value, absent leaves as-is.
    if (body.avatar !== undefined) {
      const trimmed = trimStr(body.avatar);
      if (trimmed.length === 0) delete p.avatar;
      else p.avatar = trimmed;
    }
    if (body.system_prompt !== undefined) {
      const trimmed = trimStr(body.system_prompt);
      if (trimmed.length === 0) delete p.system_prompt;
      else p.system_prompt = trimmed;
    }
    if (body.default_workspace !== undefined) {
      const trimmed = trimStr(body.default_workspace);
      if (trimmed.length === 0) delete p.default_workspace;
      else p.default_workspace = trimmed;
    }
    if (body.allowed_tools !== undefined) {
      const tools = asStringArray(body.allowed_tools);
      if (tools !== undefined) p.allowed_tools = tools;
    }
    touchProfile(p);

    try {
      await store.upsert(p);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(p);
  });

  // DELETE /v1/agent-profiles/:id — idempotent remove.
  app.delete("/v1/agent-profiles/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      if (deleted) return reply.send({ deleted: true });
      return reply.code(404).send({ deleted: false, error: `agent profile \`${id}\` not found` });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });
}
