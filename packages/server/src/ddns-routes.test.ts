import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { DdnsRuntime } from "@jarvis/ddns";
import { registerDdnsRoutes } from "./ddns-routes.ts";
import type { AppState } from "./state.ts";

async function buildApp(state: Partial<AppState>) {
  const app = Fastify({ logger: false });
  registerDdnsRoutes(app, state as AppState);
  await app.ready();
  return app;
}

test("DDNS routes 503 when runtime is absent", async () => {
  const app = await buildApp({ serverInfo: { listen_addr: "0.0.0.0:7001" } });
  for (const url of ["/v1/ddns/status", "/v1/ddns/config"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503);
  }
  const put = await app.inject({ method: "PUT", url: "/v1/ddns/config", payload: {} });
  assert.equal(put.statusCode, 503);
  await app.close();
});

test("/v1/remote/info answers even without DDNS, reports requires_auth + port", async () => {
  const app = await buildApp({
    serverInfo: { listen_addr: "0.0.0.0:7042", version: "0.2.0" },
    deviceName: "test-box",
    accessToken: "secret",
  });
  const res = await app.inject({ method: "GET", url: "/v1/remote/info" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.device_name, "test-box");
  assert.equal(body.port, 7042);
  assert.equal(body.requires_auth, true);
  assert.ok(Array.isArray(body.lan_addrs));
  await app.close();
});

test("PUT /v1/ddns/config persists + scrubs, status reflects update", async () => {
  // duckdns "OK" stub so the update cycle succeeds without real network.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => "OK" }) as Response) as typeof fetch;
  try {
    const rt = await DdnsRuntime.create({
      deps: { getPublicIp: async () => "198.51.100.9", probeReachable: async () => true, now: () => "2026-06-22T12:00:00Z" },
    });
    const app = await buildApp({ ddnsRuntime: rt, serverInfo: { listen_addr: "0.0.0.0:7001" } });

    // PUT config (with a secret token).
    const put = await app.inject({
      method: "PUT",
      url: "/v1/ddns/config",
      payload: {
        provider: "duckdns",
        hostname: "myhome.duckdns.org",
        port: 7001,
        credentials: { token: "supersecret" },
      },
    });
    assert.equal(put.statusCode, 200);
    const view = put.json();
    assert.deepEqual(view.credential_keys, ["token"]);
    assert.equal(JSON.stringify(view).includes("supersecret"), false);

    // GET config is scrubbed too.
    const got = await app.inject({ method: "GET", url: "/v1/ddns/config" });
    assert.equal(JSON.stringify(got.json()).includes("supersecret"), false);

    // Force an update; status reflects the successful cycle.
    const upd = await app.inject({ method: "POST", url: "/v1/ddns/update" });
    assert.equal(upd.statusCode, 200);
    const status = upd.json();
    assert.equal(status.public_ip, "198.51.100.9");
    assert.equal(status.last_result.ok, true);

    await app.close();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("POST /v1/ddns/update 400s when configured-but-not (no config)", async () => {
  const rt = await DdnsRuntime.create({});
  const app = await buildApp({ ddnsRuntime: rt, serverInfo: { listen_addr: "0.0.0.0:7001" } });
  const res = await app.inject({ method: "POST", url: "/v1/ddns/update" });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("/v1/remote/pairing returns token + links to loopback, 403 to remote", async () => {
  const app = await buildApp({
    serverInfo: { listen_addr: "0.0.0.0:7001" },
    deviceName: "home-mac",
    accessToken: "secret123",
  });
  // Loopback (inject default 127.0.0.1) → 200 with token + jarvis:// links.
  const ok = await app.inject({ method: "GET", url: "/v1/remote/pairing" });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.token, "secret123");
  assert.equal(body.device_name, "home-mac");
  assert.ok(Array.isArray(body.pairing_links));
  if (body.pairing_links.length > 0) {
    assert.match(body.pairing_links[0].link, /^jarvis:\/\/pair\?/);
    assert.match(body.pairing_links[0].link, /token=secret123/);
  }
  // Remote (non-loopback) → 403, never leaks the token.
  const remote = await app.inject({ method: "GET", url: "/v1/remote/pairing", remoteAddress: "203.0.113.9" });
  assert.equal(remote.statusCode, 403);
  assert.equal(JSON.stringify(remote.json()).includes("secret123"), false);
  await app.close();
});
