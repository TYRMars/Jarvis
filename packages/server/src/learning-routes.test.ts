import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemorySkillUsageStore } from "@jarvis/learning";
import { registerLearningRoutes } from "./learning-routes.ts";
import type { AppState } from "./state.ts";

function noAgent(): never {
  throw new Error("agent not used in these route tests");
}

async function buildApp(withStore = true) {
  const state: AppState = { createAgent: noAgent };
  if (withStore) state.skillUsage = new MemorySkillUsageStore();
  const app = Fastify();
  registerLearningRoutes(app, state);
  await app.ready();
  return app;
}

test("POST skill-usage records an event and stamps id/created_at", async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning/skill-usage",
      payload: { skill_name: "deep-research", action: "used" },
    });
    assert.equal(res.statusCode, 201);
    const event = res.json().event;
    assert.equal(event.skill_name, "deep-research");
    assert.ok(typeof event.id === "string" && event.id.length > 0);
  } finally {
    await app.close();
  }
});

test("POST skill-usage with malformed body → 400, not 500 (issue #415)", async () => {
  const app = await buildApp();
  try {
    // Missing skill_name → previously `undefined.trim()` re-threw as a 500.
    const empty = await app.inject({ method: "POST", url: "/v1/learning/skill-usage", payload: {} });
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().error, /skill_name/);

    // Mistyped skill_name (number) → same TypeError path before the guard.
    const mistyped = await app.inject({
      method: "POST",
      url: "/v1/learning/skill-usage",
      payload: { skill_name: 5 },
    });
    assert.equal(mistyped.statusCode, 400);
    assert.match(mistyped.json().error, /skill_name/);
  } finally {
    await app.close();
  }
});

test("POST skill-usage 503s when no store is configured", async () => {
  const app = await buildApp(false);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning/skill-usage",
      payload: { skill_name: "x", action: "used" },
    });
    assert.equal(res.statusCode, 503);
  } finally {
    await app.close();
  }
});
