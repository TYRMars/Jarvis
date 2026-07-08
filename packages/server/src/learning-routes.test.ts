// Tests for the skill-usage learning routes' limit handling: a caller-supplied
// `limit` is clamped to [1, 500], `0`/omitted falls back to the 200-row
// default, and `/report` still folds every matching event (its store contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  MemorySkillUsageStore,
  viewedSkillUsageEvent,
  skillScopeUser,
  type SkillUsageEvent,
  type SkillUsageFilter,
  type SkillUsageRow,
} from "@jarvis/learning";
import { registerLearningRoutes } from "./learning-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** MemorySkillUsageStore that records the filter.limit each read receives. */
class SpyStore extends MemorySkillUsageStore {
  listLimits: (number | undefined)[] = [];
  reportLimits: (number | undefined)[] = [];
  async listEvents(filter: SkillUsageFilter): Promise<SkillUsageEvent[]> {
    this.listLimits.push(filter.limit);
    return super.listEvents(filter);
  }
  async report(filter: SkillUsageFilter): Promise<SkillUsageRow[]> {
    this.reportLimits.push(filter.limit);
    return super.report(filter);
  }
}

async function buildApp(store: SpyStore) {
  const state: AppState = { createAgent: agentUnused, skillUsage: store };
  const app = Fastify();
  registerLearningRoutes(app, state);
  await app.ready();
  return app;
}

test("GET /v1/learning/skill-usage clamps limit: huge → 500, 0 → default 200, omitted → 200", async () => {
  const store = new SpyStore();
  const app = await buildApp(store);

  await app.inject({ method: "GET", url: "/v1/learning/skill-usage?limit=100000000" });
  await app.inject({ method: "GET", url: "/v1/learning/skill-usage?limit=0" });
  await app.inject({ method: "GET", url: "/v1/learning/skill-usage" });
  assert.deepEqual(store.listLimits, [500, 200, 200]);
  await app.close();
});

test("GET /v1/learning/skill-usage/report applies the default cap when limit omitted", async () => {
  const store = new SpyStore();
  const app = await buildApp(store);

  await app.inject({ method: "GET", url: "/v1/learning/skill-usage/report" });
  await app.inject({ method: "GET", url: "/v1/learning/skill-usage/report?limit=100000000" });
  // omitted → default 200; supplied huge → clamped to 500.
  assert.deepEqual(store.reportLimits, [200, 500]);
  await app.close();
});

test("report still folds every matching event past the page cap", async () => {
  const store = new SpyStore();
  const app = await buildApp(store);
  for (let i = 0; i < 3; i++) {
    await store.recordEvent({
      ...viewedSkillUsageEvent("rust", "user", skillScopeUser()),
      action: "used",
    });
  }
  const res = await app.inject({ method: "GET", url: "/v1/learning/skill-usage/report?limit=1" });
  assert.equal(res.statusCode, 200);
  const rows = (res.json() as { rows: SkillUsageRow[] }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.use_count, 3);
  await app.close();
});
