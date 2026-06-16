// REST routes for the Settings → Channels page.
//
// Ported from crates/harness-server/src/channels_routes.rs (the M1 CRUD
// subset). Endpoints:
//
// | Method | Path                       | Notes                                       |
// |--------|----------------------------|---------------------------------------------|
// | GET    | /v1/channels               | list user-configured instances              |
// | POST   | /v1/channels               | create (kind + display_name + config)       |
// | GET    | /v1/channels/kinds         | supported kinds + config schemas            |
// | GET    | /v1/channels/:id           | fetch one                                   |
// | PATCH  | /v1/channels/:id           | partial update (display_name/status/config) |
// | DELETE | /v1/channels/:id           | hard delete                                 |
// | POST   | /v1/channels/:id/test      | one-shot test send                          |
//
// Every store-backed endpoint returns 503 when no ChannelInstanceStore is
// wired (matches the convention used by the other optional facets).
//
// ---------------------------------------------------------------------------
// DEFERRED (per-kind adapters land in a later wave):
//
// The Rust route consults a `ChannelAdapterRegistry` (one ChannelAdapter per
// kind: wecom_webhook / feishu_bot / dingtalk_bot / wecom_app) for three
// things — config-schema listing, config validation, and the actual outbound
// `send`. That registry is NOT yet in the Node `AppState`, so:
//   - GET  /v1/channels/kinds  → returns `{ kinds: [] }` (no adapters to
//     describe yet). Real per-kind schemas arrive with the adapters.
//   - POST /v1/channels        → cannot validate `config` against a kind, so a
//     new row stays `"unconfigured"` (mirrors Rust's "invalid config stays
//     Unconfigured" branch); kind-existence is not enforced.
//   - PATCH /v1/channels/:id   → honours an *explicit* `status` transition and
//     replaces `config`, but the adapter-driven auto-promote/auto-demote on a
//     config edit is skipped (config validity is treated as "unknown → don't
//     demote", which is exactly Rust's unknown-kind fallback).
//   - POST /v1/channels/:id/test → 503 (no adapter to send through).
//
// Also deferred (separate later wave — signature verification + OAuth):
//   - POST /v1/channels/:id/callback        (inbound platform callbacks)
//   - .../:id/oauth/{start,callback}        (WeCom-app OAuth2 identity)
// Those routes are intentionally NOT registered here.
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorText, type JsonValue } from "@jarvis/core";
import {
  channelInstanceStatusFromWire,
  newChannelInstance,
  touchChannelInstance,
  type ChannelInstance,
  type ChannelInstanceStore,
} from "@jarvis/channel";
import type { AppState } from "./state.ts";

const DISPLAY_NAME_MAX = 64;

/** Return the instance store, or send a 503 and return undefined. */
function requireStore(
  state: AppState,
  reply: FastifyReply,
): ChannelInstanceStore | undefined {
  if (!state.channelInstances) {
    reply.code(503).send({ error: "channel-instance store not configured" });
    return undefined;
  }
  return state.channelInstances;
}

/**
 * Public projection of a row. Mirrors Rust's `instance_to_json` — the same
 * field set + the `status` string already lives in snake_case on the value
 * type, so we ship the row verbatim.
 */
function instanceToJson(inst: ChannelInstance): {
  id: string;
  kind: string;
  display_name: string;
  status: string;
  config: JsonValue;
  created_at: string;
  updated_at: string;
} {
  return {
    id: inst.id,
    kind: inst.kind,
    display_name: inst.display_name,
    status: inst.status,
    config: inst.config,
    created_at: inst.created_at,
    updated_at: inst.updated_at,
  };
}

export function registerChannelsRoutes(app: FastifyInstance, state: AppState): void {
  // --------------------------- list ------------------------------------
  app.get("/v1/channels", async (_req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    try {
      const rows = await store.list();
      return reply.send({ items: rows.map(instanceToJson) });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // --------------------------- kinds (DEFERRED: needs adapter registry) ----
  // Rust pulls each kind's `schema()` off the registry so the Settings form
  // stays in lockstep with what the backend can send. With no adapters wired
  // yet, the honest answer is an empty catalogue.
  app.get("/v1/channels/kinds", async (_req, reply) => {
    return reply.send({ kinds: [] });
  });

  // --------------------------- create ----------------------------------
  app.post("/v1/channels", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as {
      kind?: unknown;
      display_name?: unknown;
      config?: unknown;
    };
    if (typeof body.kind !== "string" || body.kind.length === 0) {
      return reply.code(400).send({ error: "kind must be a non-empty string" });
    }
    if (typeof body.display_name !== "string") {
      return reply.code(400).send({ error: "display_name must be non-empty" });
    }
    const displayName = body.display_name.trim();
    if (displayName.length === 0) {
      return reply.code(400).send({ error: "display_name must be non-empty" });
    }
    if (displayName.length > DISPLAY_NAME_MAX) {
      return reply.code(400).send({ error: "display_name must be ≤ 64 chars" });
    }
    const config: JsonValue =
      body.config === undefined ? {} : (body.config as JsonValue);
    // DEFERRED: without the adapter registry we can neither reject an unknown
    // kind nor validate the config, so the row stays `"unconfigured"` (the
    // Rust "invalid config stays Unconfigured" branch). Promotion to Enabled
    // arrives with the per-kind adapters.
    const inst = newChannelInstance(body.kind, displayName, config);
    try {
      await store.upsert(inst);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.code(201).send(instanceToJson(inst));
  });

  // --------------------------- get one ---------------------------------
  app.get("/v1/channels/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const inst = await store.get(id);
      if (!inst) return reply.code(404).send({ error: "channel instance not found" });
      return reply.send(instanceToJson(inst));
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // --------------------------- patch -----------------------------------
  app.patch("/v1/channels/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let inst: ChannelInstance | undefined;
    try {
      inst = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!inst) return reply.code(404).send({ error: "channel instance not found" });

    const body = (req.body ?? {}) as {
      display_name?: unknown;
      status?: unknown;
      config?: unknown;
    };

    if (body.display_name !== undefined) {
      if (typeof body.display_name !== "string") {
        return reply.code(400).send({ error: "display_name must be non-empty" });
      }
      const trimmed = body.display_name.trim();
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "display_name must be non-empty" });
      }
      if (trimmed.length > DISPLAY_NAME_MAX) {
        return reply.code(400).send({ error: "display_name must be ≤ 64 chars" });
      }
      inst.display_name = trimmed;
    }

    if (body.config !== undefined) {
      inst.config = body.config as JsonValue;
    }

    // DEFERRED: Rust re-validates the (possibly edited) config via the kind's
    // adapter to auto-promote Unconfigured→Enabled or auto-demote a broken
    // Enabled row. With no registry, config validity is "unknown" — which
    // Rust treats as valid for unknown kinds (don't demote). So we honour an
    // *explicit* `status` transition unconditionally and otherwise leave the
    // status untouched.
    if (body.status !== undefined) {
      if (typeof body.status !== "string") {
        return reply
          .code(400)
          .send({ error: "unknown status — expected enabled|disabled|unconfigured" });
      }
      const want = channelInstanceStatusFromWire(body.status);
      if (!want) {
        return reply.code(400).send({
          error: `unknown status '${body.status}' — expected enabled|disabled|unconfigured`,
        });
      }
      inst.status = want;
    }

    touchChannelInstance(inst);
    try {
      await store.upsert(inst);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    return reply.send(instanceToJson(inst));
  });

  // --------------------------- delete ----------------------------------
  app.delete("/v1/channels/:id", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    try {
      const deleted = await store.delete(id);
      return reply.code(deleted ? 200 : 404).send({ deleted });
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
  });

  // --------------------------- test send (DEFERRED: needs adapter) -----
  // Rust resolves `${env:…}` templates and dispatches through the kind's
  // adapter. No adapter registry is wired yet, so the only honest answer is
  // 503 (after the store guard + 404, to keep the failure ordering sane).
  app.post("/v1/channels/:id/test", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const id = (req.params as { id: string }).id;
    let inst: ChannelInstance | undefined;
    try {
      inst = await store.get(id);
    } catch (e) {
      return reply.code(500).send({ error: errorText(e) });
    }
    if (!inst) return reply.code(404).send({ error: "channel instance not found" });
    return reply
      .code(503)
      .send({ error: "channel adapters not configured — test send deferred to a later wave" });
  });
}
