// Model route-policy CRUD. Ported from harness-server routes.rs
// (get/put_route_policy, patch/delete_route_policy_slot). Drives the web
// Settings·RoutingSection. 503 when no RoutePolicyStore is configured.
//
//   GET    /v1/routing          — whole policy snapshot
//   PUT    /v1/routing          — replace the whole policy
//   PATCH  /v1/routing/:slot    — set one slot ({ target: "provider/model" })
//   DELETE /v1/routing/:slot    — clear one slot
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ROUTE_SLOTS,
  isRouteSlot,
  parseModelTarget,
  type ModelTarget,
  type RoutePolicy,
  RoutePolicyStore,
} from "./route-policy.ts";
import type { AppState } from "./state.ts";

function requireStore(state: AppState, reply: FastifyReply): RoutePolicyStore | undefined {
  if (!state.routePolicy) {
    reply.code(503).send({ error: "route policy not configured" });
    return undefined;
  }
  return state.routePolicy;
}

function asTarget(v: unknown): ModelTarget | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== "string" || typeof o.model !== "string") return undefined;
  if (o.provider === "" || o.model === "") return undefined;
  return { provider: o.provider, model: o.model };
}

function validatePolicy(raw: unknown): RoutePolicy | { error: string } {
  if (raw === null || typeof raw !== "object") return { error: "body must be a route-policy object" };
  const b = raw as Record<string, unknown>;
  const out: RoutePolicy = {};
  for (const slot of ROUTE_SLOTS) {
    const v = b[slot];
    if (v === undefined || v === null) continue;
    const t = asTarget(v);
    if (!t) return { error: `slot '${slot}' must be { provider, model }` };
    out[slot] = t;
  }
  if (b.fallbacks !== undefined && b.fallbacks !== null) {
    if (!Array.isArray(b.fallbacks)) return { error: "fallbacks must be an array" };
    const fb: ModelTarget[] = [];
    for (const item of b.fallbacks) {
      const t = asTarget(item);
      if (!t) return { error: "each fallback must be { provider, model }" };
      fb.push(t);
    }
    out.fallbacks = fb;
  }
  return out;
}

export function registerRoutingRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/routing", async (_req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    return reply.send(store.snapshot());
  });

  app.put("/v1/routing", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const parsed = validatePolicy(req.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    store.replace(parsed);
    return reply.send(store.snapshot());
  });

  app.patch("/v1/routing/:slot", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const slot = (req.params as { slot: string }).slot;
    if (!isRouteSlot(slot)) return reply.code(400).send({ error: `unknown slot '${slot}'` });
    const body = (req.body ?? {}) as { target?: unknown };
    if (body.target === null || body.target === undefined) {
      store.setSlot(slot, undefined);
      return reply.send(store.snapshot());
    }
    if (typeof body.target !== "string") {
      return reply.code(400).send({ error: "target must be a 'provider/model' string or null" });
    }
    const target = parseModelTarget(body.target);
    if (!target) return reply.code(400).send({ error: `malformed target '${body.target}'` });
    store.setSlot(slot, target);
    return reply.send(store.snapshot());
  });

  app.delete("/v1/routing/:slot", async (req, reply) => {
    const store = requireStore(state, reply);
    if (!store) return reply;
    const slot = (req.params as { slot: string }).slot;
    if (!isRouteSlot(slot)) return reply.code(400).send({ error: `unknown slot '${slot}'` });
    store.setSlot(slot, undefined);
    return reply.send(store.snapshot());
  });
}
