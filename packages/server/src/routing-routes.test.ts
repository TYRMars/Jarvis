import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { RoutePolicyStore, parseModelTarget } from "./route-policy.ts";
import { registerRoutingRoutes } from "./routing-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

// ---------- route-policy unit ---------------------------------------------

test("parseModelTarget accepts provider/model, rejects malformed", () => {
  assert.deepEqual(parseModelTarget("openai/gpt-4o-mini"), { provider: "openai", model: "gpt-4o-mini" });
  assert.deepEqual(parseModelTarget("anthropic/claude-3-5-sonnet/extra"), {
    provider: "anthropic",
    model: "claude-3-5-sonnet/extra",
  });
  for (const bad of ["", "noslash", "/model", "provider/", "/"]) {
    assert.equal(parseModelTarget(bad), undefined, bad);
  }
});

test("store snapshot omits empty slots; summarizationModel reads the slot", () => {
  const s = new RoutePolicyStore();
  assert.deepEqual(s.snapshot(), {});
  s.setSlot("summarization", { provider: "openai", model: "gpt-4o-mini" });
  assert.deepEqual(s.snapshot(), { summarization: { provider: "openai", model: "gpt-4o-mini" } });
  assert.equal(s.summarizationModel(), "gpt-4o-mini");
  s.setSlot("summarization", undefined);
  assert.equal(s.summarizationModel(), undefined);
  assert.deepEqual(s.snapshot(), {});
});

// ---------- routes ---------------------------------------------------------

async function buildApp(state: AppState) {
  const app = Fastify();
  registerRoutingRoutes(app, state);
  await app.ready();
  return app;
}

test("routing routes 503 when no policy store", async () => {
  const app = await buildApp({ createAgent: agentUnused });
  assert.equal((await app.inject({ method: "GET", url: "/v1/routing" })).statusCode, 503);
  await app.close();
});

test("GET/PUT/PATCH/DELETE round-trip + validation", async () => {
  const store = new RoutePolicyStore();
  const app = await buildApp({ createAgent: agentUnused, routePolicy: store });

  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/routing" })).json(), {});

  // PUT whole policy
  const put = await app.inject({
    method: "PUT",
    url: "/v1/routing",
    payload: { coding: { provider: "anthropic", model: "claude" }, fallbacks: [{ provider: "openai", model: "gpt" }] },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), {
    coding: { provider: "anthropic", model: "claude" },
    fallbacks: [{ provider: "openai", model: "gpt" }],
  });

  // PUT malformed slot → 400
  assert.equal(
    (await app.inject({ method: "PUT", url: "/v1/routing", payload: { coding: { provider: "x" } } })).statusCode,
    400,
  );

  // PATCH set summarization (effective on the shared store)
  const patch = await app.inject({
    method: "PATCH",
    url: "/v1/routing/summarization",
    payload: { target: "openai/gpt-4o-mini" },
  });
  assert.equal(patch.statusCode, 200);
  assert.deepEqual((patch.json() as { summarization: unknown }).summarization, {
    provider: "openai",
    model: "gpt-4o-mini",
  });
  assert.equal(store.summarizationModel(), "gpt-4o-mini"); // shared store mutated

  // PATCH unknown slot / malformed target → 400
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/routing/bogus", payload: { target: "a/b" } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/routing/coding", payload: { target: "noslash" } })).statusCode,
    400,
  );

  // PATCH null clears; DELETE clears
  await app.inject({ method: "PATCH", url: "/v1/routing/summarization", payload: { target: null } });
  assert.equal(store.summarizationModel(), undefined);
  const del = await app.inject({ method: "DELETE", url: "/v1/routing/coding" });
  assert.equal(del.statusCode, 200);
  assert.equal((del.json() as { coding?: unknown }).coding, undefined);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/routing/bogus" })).statusCode, 400);
  await app.close();
});
