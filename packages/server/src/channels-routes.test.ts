import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryChannelInstanceStore } from "@jarvis/channel";
import { registerChannelsRoutes } from "./channels-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

function makeState(opts: { store?: boolean } = {}): AppState {
  return {
    createAgent: agentUnused,
    channelInstances:
      opts.store === false ? undefined : new MemoryChannelInstanceStore(),
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerChannelsRoutes(app, state);
  await app.ready();
  return app;
}

test("store-backed routes 503 when no ChannelInstanceStore is configured", async () => {
  const app = await buildApp(makeState({ store: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/channels" })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/channels",
        payload: { kind: "wecom_webhook", display_name: "alerts" },
      })
    ).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "GET", url: "/v1/channels/x" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/channels/x", payload: { display_name: "y" } }))
      .statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/channels/x" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/channels/x/test" })).statusCode, 503);
  await app.close();
});

test("GET /v1/channels/kinds returns an empty catalogue (adapters deferred), no store needed", async () => {
  const app = await buildApp(makeState({ store: false }));
  const res = await app.inject({ method: "GET", url: "/v1/channels/kinds" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { kinds: [] });
  await app.close();
});

test("POST creates an instance (defaults to unconfigured), GET + list reflect it", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({
    method: "POST",
    url: "/v1/channels",
    payload: { kind: "wecom_webhook", display_name: "  prod-alerts  ", config: { webhook_url: "https://x" } },
  });
  assert.equal(created.statusCode, 201);
  const inst = created.json();
  assert.equal(inst.kind, "wecom_webhook");
  assert.equal(inst.display_name, "prod-alerts"); // trimmed
  assert.equal(inst.status, "unconfigured"); // adapter validation deferred
  assert.deepEqual(inst.config, { webhook_url: "https://x" });
  assert.ok(typeof inst.id === "string" && inst.id.length > 0);
  assert.ok(typeof inst.created_at === "string");

  const one = await app.inject({ method: "GET", url: `/v1/channels/${inst.id}` });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().id, inst.id);

  const list = await app.inject({ method: "GET", url: "/v1/channels" });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, inst.id);
  await app.close();
});

test("POST without config defaults to an empty object", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({
    method: "POST",
    url: "/v1/channels",
    payload: { kind: "feishu_bot", display_name: "ci" },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().config, {});
  await app.close();
});

test("POST validation: missing kind, blank / over-cap display_name → 400", async () => {
  const app = await buildApp(makeState());
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/channels", payload: { display_name: "x" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/channels",
        payload: { kind: "wecom_webhook", display_name: "   " },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/channels",
        payload: { kind: "wecom_webhook", display_name: "n".repeat(65) },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

test("GET / PATCH / DELETE on a missing id → 404", async () => {
  const app = await buildApp(makeState());
  assert.equal((await app.inject({ method: "GET", url: "/v1/channels/nope" })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/channels/nope", payload: { display_name: "x" } }))
      .statusCode,
    404,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/channels/nope" })).statusCode, 404);
  await app.close();
});

test("PATCH updates display_name + config and an explicit status; bumps updated_at", async () => {
  const app = await buildApp(makeState());
  const inst = (
    await app.inject({
      method: "POST",
      url: "/v1/channels",
      payload: { kind: "wecom_webhook", display_name: "old" },
    })
  ).json();

  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/channels/${inst.id}`,
    payload: { display_name: "  new-name  ", status: "enabled", config: { webhook_url: "https://y" } },
  });
  assert.equal(patched.statusCode, 200);
  const p = patched.json();
  assert.equal(p.display_name, "new-name"); // trimmed
  assert.equal(p.status, "enabled"); // explicit transition honoured
  assert.deepEqual(p.config, { webhook_url: "https://y" });
  assert.ok(p.updated_at >= inst.updated_at);
  await app.close();
});

test("PATCH with an unknown status → 400; blank display_name → 400", async () => {
  const app = await buildApp(makeState());
  const inst = (
    await app.inject({
      method: "POST",
      url: "/v1/channels",
      payload: { kind: "wecom_webhook", display_name: "ok" },
    })
  ).json();

  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/v1/channels/${inst.id}`,
        payload: { status: "live" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/v1/channels/${inst.id}`,
        payload: { display_name: "   " },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

test("DELETE removes a row (200) then 404 on the second call", async () => {
  const app = await buildApp(makeState());
  const inst = (
    await app.inject({
      method: "POST",
      url: "/v1/channels",
      payload: { kind: "wecom_webhook", display_name: "ephemeral" },
    })
  ).json();

  const del = await app.inject({ method: "DELETE", url: `/v1/channels/${inst.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  const again = await app.inject({ method: "DELETE", url: `/v1/channels/${inst.id}` });
  assert.equal(again.statusCode, 404);
  assert.deepEqual(again.json(), { deleted: false });

  const list = await app.inject({ method: "GET", url: "/v1/channels" });
  assert.equal(list.json().items.length, 0);
  await app.close();
});

test("POST /v1/channels/:id/test → 503 even for an existing row (adapter send deferred), 404 for a missing row", async () => {
  const app = await buildApp(makeState());
  const inst = (
    await app.inject({
      method: "POST",
      url: "/v1/channels",
      payload: { kind: "wecom_webhook", display_name: "t" },
    })
  ).json();

  const test503 = await app.inject({ method: "POST", url: `/v1/channels/${inst.id}/test` });
  assert.equal(test503.statusCode, 503);

  const missing = await app.inject({ method: "POST", url: "/v1/channels/nope/test" });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
