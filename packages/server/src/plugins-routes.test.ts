// Tests for the plugin manager + market route module. Ported from the
// `#[cfg(test)]` blocks in crates/harness-server/src/plugin_routes.rs and
// market_routes.rs, plus the 503 / 404 / validation cases the Rust suite
// leaves to the framework.
//
// Each test builds its own `Fastify()` + `registerPluginsRoutes(app, state)`
// and drives the handlers with `app.inject`. The PluginManager is the real
// @jarvis/plugin manager pointed at a tmp dir with a fake MCP manager (the
// same seam its own unit tests use), so install / list / uninstall exercise
// real on-disk behaviour.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { SkillCatalog } from "@jarvis/skill";
import { PluginManager, type McpManagerLike } from "@jarvis/plugin";
import { registerPluginsRoutes } from "./plugins-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

// The MCP config shape, derived structurally from the seam so the test needs
// no direct @jarvis/mcp dependency (it isn't a direct dep of @jarvis/server).
type McpConfig = Parameters<McpManagerLike["add"]>[0];

/** A fake MCP manager: an in-memory prefix→config map matching the seam. */
class FakeMcp implements McpManagerLike {
  readonly slots = new Map<string, McpConfig>();
  add(config: McpConfig): Promise<string[]> {
    this.slots.set(config.prefix, config);
    return Promise.resolve([`${config.prefix}.tool`]);
  }
  remove(prefix: string): Promise<boolean> {
    return Promise.resolve(this.slots.delete(prefix));
  }
  get(prefix: string): Promise<unknown | undefined> {
    return Promise.resolve(this.slots.get(prefix));
  }
}

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "jarvis-plugins-routes-"));
}

/** Write a self-contained plugin tree with one skill at `<dir>`. */
async function writeDemoPlugin(dir: string, name = "demo"): Promise<void> {
  await mkdir(path.join(dir, "skills", "hello"), { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      description: `${name} plugin.`,
      skills: ["skills/hello"],
    }),
  );
  await writeFile(
    path.join(dir, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Says hi.\n---\nBody.",
  );
}

/** AppState with a real PluginManager (or no manager, to exercise 503). */
async function makeState(
  opts: { manager?: PluginManager | false } = {},
): Promise<AppState> {
  const state: AppState = { createAgent: agentUnused };
  if (opts.manager !== false) {
    if (opts.manager) {
      state.plugins = opts.manager;
    } else {
      const root = await makeTmp();
      state.plugins = await PluginManager.open(
        path.join(root, "plugins"),
        SkillCatalog.empty(),
        new FakeMcp(),
      );
    }
  }
  return state;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerPluginsRoutes(app, state);
  await app.ready();
  return app;
}

// ---------- /v1/plugins ----------

test("GET /v1/plugins lists installed plugins (empty initially)", async () => {
  const app = await buildApp(await makeState());
  const res = await app.inject({ method: "GET", url: "/v1/plugins" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { plugins: [] });
  await app.close();
});

test("install → list → get → uninstall round-trip", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));
  const pluginSrc = path.join(staging, "src");
  await writeDemoPlugin(pluginSrc);

  const root = path.join(staging, "plugins");
  const mgr = await PluginManager.open(root, SkillCatalog.empty(), new FakeMcp());
  const app = await buildApp(await makeState({ manager: mgr }));

  // install
  const installed = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path", value: pluginSrc },
  });
  assert.equal(installed.statusCode, 201);
  const report = installed.json() as {
    plugin: { name: string };
    added_skills: string[];
  };
  assert.equal(report.plugin.name, "demo");
  assert.deepEqual(report.added_skills, ["hello"]);

  // list now shows it
  const listed = await app.inject({ method: "GET", url: "/v1/plugins" });
  assert.equal(listed.statusCode, 200);
  const plugins = (listed.json() as { plugins: Array<{ name: string }> }).plugins;
  assert.deepEqual(
    plugins.map((p) => p.name),
    ["demo"],
  );

  // get one
  const one = await app.inject({ method: "GET", url: "/v1/plugins/demo" });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as { name: string }).name, "demo");

  // uninstall
  const removed = await app.inject({ method: "DELETE", url: "/v1/plugins/demo" });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { deleted: true, name: "demo" });

  // gone from list
  const after = await app.inject({ method: "GET", url: "/v1/plugins" });
  assert.deepEqual((after.json() as { plugins: unknown[] }).plugins, []);
  await app.close();
});

test("duplicate install → 409 conflict", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));
  const pluginSrc = path.join(staging, "src");
  await writeDemoPlugin(pluginSrc);
  const mgr = await PluginManager.open(
    path.join(staging, "plugins"),
    SkillCatalog.empty(),
    new FakeMcp(),
  );
  const app = await buildApp(await makeState({ manager: mgr }));

  const first = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path", value: pluginSrc },
  });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path", value: pluginSrc },
  });
  assert.equal(second.statusCode, 409);
  assert.match((second.json() as { error: string }).error, /already installed/);
  await app.close();
});

test("install from a path with no plugin.json → 500 (io)", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));
  const empty = path.join(staging, "empty");
  await mkdir(empty, { recursive: true });
  const app = await buildApp(await makeState());

  const res = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path", value: empty },
  });
  // No manifest on disk → PluginManagerError.io → 500.
  assert.equal(res.statusCode, 500);
  assert.ok(typeof (res.json() as { error: string }).error === "string");
  await app.close();
});

test("install with a bad body → 400 validation", async () => {
  const app = await buildApp(await makeState());

  const noSource = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { value: "/x" },
  });
  assert.equal(noSource.statusCode, 400);

  const wrongSource = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "git", value: "/x" },
  });
  assert.equal(wrongSource.statusCode, 400);

  const noValue = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path" },
  });
  assert.equal(noValue.statusCode, 400);
});

test("GET /v1/plugins/:name unknown → 404", async () => {
  const app = await buildApp(await makeState());
  const res = await app.inject({ method: "GET", url: "/v1/plugins/nope" });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: "no such plugin", name: "nope" });
  await app.close();
});

test("DELETE /v1/plugins/:name unknown → 404 (not_installed)", async () => {
  const app = await buildApp(await makeState());
  const res = await app.inject({ method: "DELETE", url: "/v1/plugins/nope" });
  assert.equal(res.statusCode, 404);
  assert.match((res.json() as { error: string }).error, /not installed/);
  await app.close();
});

// ---------- 503 when no manager ----------

test("plugin routes 503 when no manager configured", async () => {
  const app = await buildApp(await makeState({ manager: false }));
  for (const [method, url] of [
    ["GET", "/v1/plugins"],
    ["GET", "/v1/plugins/x"],
    ["DELETE", "/v1/plugins/x"],
  ] as const) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 503, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: "plugin manager not configured" });
  }
  const install = await app.inject({
    method: "POST",
    url: "/v1/plugins/install",
    payload: { source: "path", value: "/x" },
  });
  assert.equal(install.statusCode, 503);
  await app.close();
});

// ---------- marketplace stub ----------

test("GET /v1/plugins/marketplace lists the built-in entries (no manager needed)", async () => {
  // Pure data — works even with no manager (matches Rust's stateless handler).
  const app = await buildApp(await makeState({ manager: false }));
  const res = await app.inject({ method: "GET", url: "/v1/plugins/marketplace" });
  assert.equal(res.statusCode, 200);
  const plugins = (res.json() as { plugins: Array<Record<string, unknown>> }).plugins;
  const names = plugins.map((p) => p.name);
  assert.ok(names.includes("code-review-pack"), `names=${JSON.stringify(names)}`);
  assert.ok(names.includes("gitnexus"), `names=${JSON.stringify(names)}`);
  // Each entry must carry the fields `jarvis plugin install` depends on.
  for (const p of plugins) {
    assert.equal(p.source, "path");
    assert.equal(typeof p.value, "string");
  }
  const gitnexus = plugins.find((p) => p.name === "gitnexus");
  assert.equal(gitnexus?.value, "examples/plugins/gitnexus");
  await app.close();
});

// ---------- market proxies (deferred) ----------

test("GET /v1/market/mcp returns an empty deferred catalogue", async () => {
  const app = await buildApp(await makeState({ manager: false }));
  const res = await app.inject({ method: "GET", url: "/v1/market/mcp" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { servers: unknown[]; note: string };
  assert.deepEqual(body.servers, []);
  assert.equal(typeof body.note, "string");
  await app.close();
});

test("GET /v1/market/skills returns an empty deferred catalogue", async () => {
  const app = await buildApp(await makeState({ manager: false }));
  const res = await app.inject({ method: "GET", url: "/v1/market/skills?q=foo&limit=5" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { skills: unknown[]; note: string };
  assert.deepEqual(body.skills, []);
  assert.equal(typeof body.note, "string");
  await app.close();
});

test("POST /v1/market/skills/install is deferred → 503", async () => {
  const app = await buildApp(await makeState({ manager: false }));
  const res = await app.inject({
    method: "POST",
    url: "/v1/market/skills/install",
    payload: { source: "owner/repo", skillId: "thing" },
  });
  assert.equal(res.statusCode, 503);
  assert.ok(typeof (res.json() as { error: string }).error === "string");
  await app.close();
});
