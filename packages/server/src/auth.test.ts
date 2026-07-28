import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAuthHook } from "./auth.ts";
import type { AppState } from "./state.ts";

async function buildApp(accessToken?: string) {
  const app = Fastify({ logger: false });
  registerAuthHook(app, { accessToken } as AppState);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/ping", async () => ({ pong: true }));
  await app.ready();
  return app;
}

const REMOTE = "203.0.113.50"; // a non-loopback (TEST-NET-3) address

test("no token configured → /v1 open from any address", async () => {
  const app = await buildApp(undefined);
  const res = await app.inject({ method: "GET", url: "/v1/ping", remoteAddress: REMOTE });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("token set → loopback bypasses auth", async () => {
  const app = await buildApp("secret");
  // inject defaults remoteAddress to 127.0.0.1 (loopback).
  const res = await app.inject({ method: "GET", url: "/v1/ping" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("token set → remote without token is 401", async () => {
  const app = await buildApp("secret");
  const res = await app.inject({ method: "GET", url: "/v1/ping", remoteAddress: REMOTE });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("token set → remote with wrong bearer is 401", async () => {
  const app = await buildApp("secret");
  const res = await app.inject({
    method: "GET",
    url: "/v1/ping",
    remoteAddress: REMOTE,
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("token set → remote with correct bearer is 200", async () => {
  const app = await buildApp("secret");
  const res = await app.inject({
    method: "GET",
    url: "/v1/ping",
    remoteAddress: REMOTE,
    headers: { authorization: "Bearer secret" },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("token set → remote with ?token= query is 200 (WS fallback)", async () => {
  const app = await buildApp("secret");
  const res = await app.inject({ method: "GET", url: "/v1/ping?token=secret", remoteAddress: REMOTE });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("token set → /health stays open from remote (no token)", async () => {
  const app = await buildApp("secret");
  const res = await app.inject({ method: "GET", url: "/health", remoteAddress: REMOTE });
  assert.equal(res.statusCode, 200);
  await app.close();
});
