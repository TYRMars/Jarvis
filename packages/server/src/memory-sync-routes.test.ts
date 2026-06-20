import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMemorySyncRoutes } from "./memory-sync-routes.ts";
import type { AppState } from "./state.ts";

test("memory sync + includes routes report 503 not-configured (graceful stub)", async () => {
  const app = Fastify();
  registerMemorySyncRoutes(app, { createAgent: () => { throw new Error("x"); } } as unknown as AppState);
  await app.ready();
  const calls: [string, string][] = [
    ["GET", "/v1/memory/sync_status"],
    ["POST", "/v1/memory/sync"],
    ["POST", "/v1/memory/sync_setup"],
    ["POST", "/v1/memory/sync_setup_icloud"],
    ["GET", "/v1/memory/includes"],
    ["POST", "/v1/memory/includes"],
    ["DELETE", "/v1/memory/includes"],
    ["POST", "/v1/memory/includes/refresh"],
  ];
  for (const [method, url] of calls) {
    const r = await app.inject({ method: method as "GET", url, payload: {} });
    assert.equal(r.statusCode, 503, `${method} ${url}`);
    assert.match((r.json() as { error: string }).error, /not configured/, url);
  }
  await app.close();
});
