import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { SkillCatalog, type SkillEntry, type SkillSource } from "@jarvis/skill";
import { MemorySkillLifecycleStore, MemorySkillUsageStore } from "@jarvis/learning";
import { registerSkillRoutes } from "./skill-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** A catalog entry with a minimal manifest. */
function entry(name: string, source: SkillSource): SkillEntry {
  return {
    manifest: {
      name,
      description: "d",
      allowed_tools: [],
      activation: "both",
      keywords: [],
      paths: [],
    },
    body: `body for ${name}`,
    path: `/tmp/skills/${name}/SKILL.md`,
    source,
  };
}

function catalogWith(...entries: SkillEntry[]): SkillCatalog {
  const cat = SkillCatalog.empty();
  for (const e of entries) cat.insert(e);
  return cat;
}

/**
 * AppState with the skill catalogue + lifecycle + usage stores wired (or
 * selectively absent). Defaults: a catalogue holding `rust-debugger`
 * (workspace) and `doc` (bundled), an empty lifecycle store, and a usage store.
 */
function makeState(
  opts: {
    catalog?: SkillCatalog | false;
    lifecycle?: boolean;
    usage?: boolean;
  } = {},
): AppState {
  const state: AppState = { createAgent: agentUnused };
  if (opts.catalog !== false) {
    state.skillCatalog =
      opts.catalog ?? catalogWith(entry("rust-debugger", "workspace"), entry("doc", "bundled"));
  }
  if (opts.lifecycle !== false) state.skillLifecycle = new MemorySkillLifecycleStore();
  if (opts.usage !== false) state.skillUsage = new MemorySkillUsageStore();
  return state;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerSkillRoutes(app, state);
  await app.ready();
  return app;
}

test("GET /v1/skills lists every loaded skill in name order, without body", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/skills" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { skills: Array<Record<string, unknown>> };
  assert.deepEqual(
    body.skills.map((s) => s.name),
    ["doc", "rust-debugger"],
  );
  // summary carries source + path but never the markdown body
  const doc = body.skills[0];
  assert.equal(doc?.source, "bundled");
  assert.equal(doc?.path, "/tmp/skills/doc/SKILL.md");
  assert.ok(!("body" in (doc ?? {})));
  await app.close();
});

test("GET /v1/skills/:name returns manifest + body and records a viewed event", async () => {
  const state = makeState();
  const app = await buildApp(state);
  const res = await app.inject({ method: "GET", url: "/v1/skills/rust-debugger" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.name, "rust-debugger");
  assert.equal(body.source, "workspace");
  assert.equal(body.body, "body for rust-debugger");

  // fire-and-forget viewed event landed in the usage store
  const events = await state.skillUsage!.listEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0]?.skill_name, "rust-debugger");
  assert.equal(events[0]?.action, "viewed");
  assert.equal(events[0]?.source, "workspace");
  assert.deepEqual(events[0]?.scope, { kind: "user" });
  await app.close();
});

test("GET /v1/skills/:name 404s for an unknown skill", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/skills/ghost" });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { name: string }).name, "ghost");
  await app.close();
});

test("POST /v1/skills/reload reports the count without re-scanning", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "POST", url: "/v1/skills/reload" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { count: 2, reloaded: false });
  await app.close();
});

test("lifecycle seeds Active, then archive (with absorbed_into), then restore", async () => {
  const app = await buildApp(makeState());

  // GET seeds an Active row from the catalogue entry.
  const seeded = await app.inject({ method: "GET", url: "/v1/skills/rust-debugger/lifecycle" });
  assert.equal(seeded.statusCode, 200);
  let lc = (seeded.json() as { lifecycle: Record<string, unknown> }).lifecycle;
  assert.equal(lc.state, "active");
  assert.equal(lc.source, "workspace");
  // workspace → inferred `user` creator
  assert.equal(lc.created_by, "user");

  // Archive with absorbed_into.
  const archived = await app.inject({
    method: "POST",
    url: "/v1/skills/rust-debugger/archive",
    payload: { absorbed_into: "debugging-umbrella" },
  });
  assert.equal(archived.statusCode, 200);
  lc = (archived.json() as { lifecycle: Record<string, unknown> }).lifecycle;
  assert.equal(lc.state, "archived");
  assert.equal(lc.absorbed_into, "debugging-umbrella");
  assert.equal(typeof lc.archived_at, "string");

  // Restore clears archived_at + absorbed_into.
  const restored = await app.inject({ method: "POST", url: "/v1/skills/rust-debugger/restore" });
  assert.equal(restored.statusCode, 200);
  lc = (restored.json() as { lifecycle: Record<string, unknown> }).lifecycle;
  assert.equal(lc.state, "active");
  assert.ok(!("archived_at" in lc));
  assert.ok(!("absorbed_into" in lc));
  await app.close();
});

test("bundled catalogue source infers a bundled creator", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/skills/doc/lifecycle" });
  assert.equal(res.statusCode, 200);
  const lc = (res.json() as { lifecycle: Record<string, unknown> }).lifecycle;
  assert.equal(lc.created_by, "bundled");
  await app.close();
});

test("archive without absorbed_into is a plain prune (no umbrella recorded)", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "POST", url: "/v1/skills/rust-debugger/archive" });
  assert.equal(res.statusCode, 200);
  const lc = (res.json() as { lifecycle: Record<string, unknown> }).lifecycle;
  assert.equal(lc.state, "archived");
  assert.ok(!("absorbed_into" in lc));
  await app.close();
});

test("lifecycle 404s for a skill absent from the catalogue", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({ method: "GET", url: "/v1/skills/ghost/lifecycle" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("catalogue endpoints 503 when no catalogue is configured", async () => {
  const app = await buildApp(makeState({ catalog: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/skills" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/skills/x" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/skills/reload" })).statusCode, 503);
  // lifecycle store present but catalogue absent → seeding still needs the
  // catalogue, so a never-seen skill 503s on the catalogue guard.
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/skills/x/lifecycle" })).statusCode,
    503,
  );
  await app.close();
});

test("lifecycle endpoints 503 when no lifecycle store is configured", async () => {
  const app = await buildApp(makeState({ lifecycle: false }));
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/skills/rust-debugger/lifecycle" })).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/skills/rust-debugger/archive" })).statusCode,
    503,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/skills/rust-debugger/restore" })).statusCode,
    503,
  );
  await app.close();
});

test("GET /v1/skills/:name works without a usage store (no viewed event)", async () => {
  const app = await buildApp(makeState({ usage: false }));
  const res = await app.inject({ method: "GET", url: "/v1/skills/doc" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { body: string }).body, "body for doc");
  await app.close();
});
