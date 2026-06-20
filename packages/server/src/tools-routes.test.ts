import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ToolRegistry, type Tool, type ToolCategory } from "@jarvis/core";
import { registerToolsRoutes } from "./tools-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

function fakeTool(
  name: string,
  category: ToolCategory,
  opts: { requiresApproval?: boolean } = {},
): Tool {
  return {
    name,
    description: `desc ${name}`,
    parameters: { type: "object" },
    invoke: async () => "",
    category,
    requiresApproval: opts.requiresApproval ?? false,
  };
}

/** A registry spanning a few packs/risks/sources, incl. a subagent wrapper. */
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fakeTool("fs.read", "read"));
  reg.register(fakeTool("fs.write", "write", { requiresApproval: true }));
  reg.register(fakeTool("shell.exec", "exec", { requiresApproval: true }));
  reg.register(fakeTool("http.fetch", "network"));
  reg.register(fakeTool("subagent.review", "write", { requiresApproval: true }));
  return reg;
}

function makeState(reg?: ToolRegistry): AppState {
  return { createAgent: agentUnused, ...(reg ? { tools: reg } : {}) };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerToolsRoutes(app, state);
  await app.ready();
  return app;
}

test("503 when no tool registry is configured", async () => {
  const app = await buildApp(makeState());
  assert.equal((await app.inject({ method: "GET", url: "/v1/tools" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/tools/fs.read", payload: { enabled: false } }))
      .statusCode,
    503,
  );
  await app.close();
});

test("GET /v1/tools returns the full catalog, sorted, classified", async () => {
  const app = await buildApp(makeState(makeRegistry()));
  const res = await app.inject({ method: "GET", url: "/v1/tools" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total: number; tools: Record<string, unknown>[] };
  assert.equal(body.total, 5);
  // Sorted by name.
  assert.deepEqual(
    body.tools.map((t) => t.name),
    ["fs.read", "fs.write", "http.fetch", "shell.exec", "subagent.review"],
  );
  const byName = (n: string) => body.tools.find((t) => t.name === n)!;
  // Classification + default omission.
  assert.equal(byName("fs.read").risk, "read-only");
  assert.equal(byName("fs.read").pack, "file-read");
  assert.equal(byName("fs.read").enabled, true);
  assert.equal("source" in byName("fs.read"), false); // builtin omitted
  assert.equal(byName("fs.write").risk, "workspace-write");
  assert.equal(byName("shell.exec").risk, "shell");
  assert.equal(byName("http.fetch").risk, "network");
  // subagent.* gets source reclassified + sub-agent pack + external-side-effect.
  assert.deepEqual(byName("subagent.review").source, { kind: "subagent", subagent: "review" });
  assert.equal(byName("subagent.review").pack, "sub-agent");
  assert.equal(byName("subagent.review").risk, "external-side-effect");
  await app.close();
});

test("GET /v1/tools honours source/pack/risk facet filters", async () => {
  const app = await buildApp(makeState(makeRegistry()));
  const sub = (await app.inject({ method: "GET", url: "/v1/tools?source=subagent" })).json() as {
    total: number;
    tools: { name: string }[];
  };
  assert.deepEqual(sub.tools.map((t) => t.name), ["subagent.review"]);
  const fileRead = (await app.inject({ method: "GET", url: "/v1/tools?pack=file-read" })).json() as {
    tools: { name: string }[];
  };
  assert.deepEqual(fileRead.tools.map((t) => t.name), ["fs.read"]);
  const network = (await app.inject({ method: "GET", url: "/v1/tools?risk=network" })).json() as {
    tools: { name: string }[];
  };
  assert.deepEqual(network.tools.map((t) => t.name), ["http.fetch"]);
  await app.close();
});

test("PATCH mutes/unmutes end-to-end and the registry reflects it", async () => {
  const reg = makeRegistry();
  const app = await buildApp(makeState(reg));

  // Mute.
  const muted = await app.inject({
    method: "PATCH",
    url: "/v1/tools/shell.exec",
    payload: { enabled: false },
  });
  assert.equal(muted.statusCode, 200);
  assert.deepEqual(muted.json(), { name: "shell.exec", enabled: false, muted_count: 1 });
  // The shared registry hides it from the LLM-visible set, keeps it in the catalog.
  assert.equal(reg.names().includes("shell.exec"), false);
  assert.equal(reg.resolve("shell.exec"), undefined);
  const cat = (await app.inject({ method: "GET", url: "/v1/tools" })).json() as {
    total: number;
    tools: { name: string; enabled: boolean }[];
  };
  assert.equal(cat.total, 5); // still listed
  assert.equal(cat.tools.find((t) => t.name === "shell.exec")!.enabled, false);

  // Unmute.
  const unmuted = await app.inject({
    method: "PATCH",
    url: "/v1/tools/shell.exec",
    payload: { enabled: true },
  });
  assert.deepEqual(unmuted.json(), { name: "shell.exec", enabled: true, muted_count: 0 });
  assert.equal(reg.resolve("shell.exec")?.name, "shell.exec");
  await app.close();
});

test("PATCH 404 for an unknown tool, 400 for a non-boolean enabled", async () => {
  const app = await buildApp(makeState(makeRegistry()));
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/tools/nope.gone", payload: { enabled: false } }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/tools/fs.read", payload: { enabled: "yes" } }))
      .statusCode,
    400,
  );
  await app.close();
});
