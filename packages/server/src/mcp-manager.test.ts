import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ToolRegistry, type Tool } from "@jarvis/core";
import type { McpClient, McpClientConfig } from "@jarvis/mcp";
import {
  McpManager,
  McpManagerError,
  wireToConfig,
  configToWire,
  type McpConnect,
} from "./mcp-manager.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** A fake connect that fabricates `<prefix>.<name>` tools, no child process. */
function fakeConnect(toolsByPrefix: Record<string, string[]> = {}): McpConnect {
  return async (cfg: McpClientConfig) => {
    const names = toolsByPrefix[cfg.prefix] ?? ["alpha", "beta"];
    const fake = {
      prefix: cfg.prefix,
      async collectRemoteTools(): Promise<Array<[string, Tool]>> {
        return names.map((n) => {
          const full = `${cfg.prefix}.${n}`;
          const tool: Tool = {
            name: full,
            description: "remote",
            parameters: { type: "object" },
            invoke: async () => "",
          };
          return [full, tool];
        });
      },
      async health(): Promise<number> {
        return names.length;
      },
      async shutdown(): Promise<void> {},
    };
    return fake as unknown as McpClient;
  };
}

const failConnect: McpConnect = async () => {
  throw new Error("boom");
};

function stdio(prefix: string): McpClientConfig {
  return { prefix, transport: { type: "stdio", command: "x", args: [] } };
}

// ---------- config conversion ---------------------------------------------

test("wire <-> config round-trips snake/camel field names", () => {
  const wire = {
    prefix: "p",
    transport: { type: "stdio" as const, command: "c", args: [] },
    allow_tools: ["a"],
    deny_tools: ["b"],
    enabled: true,
  };
  const cfg = wireToConfig(wire);
  assert.deepEqual(cfg.allowTools, ["a"]);
  assert.deepEqual(cfg.denyTools, ["b"]);
  assert.deepEqual(configToWire(cfg).allow_tools, ["a"]);
  assert.deepEqual(configToWire(cfg).deny_tools, ["b"]);
});

// ---------- manager unit ---------------------------------------------------

test("add connects, registers tools, lists running", async () => {
  const reg = new ToolRegistry();
  const m = new McpManager(reg, fakeConnect({ srv: ["read", "write"] }));
  const tools = await m.add(stdio("srv"));
  assert.deepEqual(tools, ["srv.read", "srv.write"]);
  assert.ok(reg.contains("srv.read") && reg.contains("srv.write"));
  const info = m.list();
  assert.equal(info.length, 1);
  assert.equal(info[0]!.status, "running");
  assert.deepEqual(info[0]!.tools, ["srv.read", "srv.write"]);
});

test("add rejects duplicate prefix (409) and tool-name collisions (409)", async () => {
  const reg = new ToolRegistry();
  const m = new McpManager(reg, fakeConnect());
  await m.add(stdio("dup"));
  await assert.rejects(m.add(stdio("dup")), (e) => e instanceof McpManagerError && e.status === 409);

  // Pre-existing tool collides with a server's namespaced name.
  reg.register({ name: "clash.alpha", description: "", parameters: {}, invoke: async () => "" });
  await assert.rejects(
    m.add(stdio("clash")),
    (e) => e instanceof McpManagerError && e.status === 409,
  );
  assert.equal(m.get("clash"), undefined); // slot not created on failure
});

test("enabled:false records a stopped slot without connecting", async () => {
  const reg = new ToolRegistry();
  const m = new McpManager(reg, failConnect); // would throw if it tried to connect
  const tools = await m.add({ ...stdio("off"), enabled: false });
  assert.deepEqual(tools, []);
  assert.equal(m.get("off")!.status, "stopped");
});

test("remove unregisters the server's tools; idempotent", async () => {
  const reg = new ToolRegistry();
  const m = new McpManager(reg, fakeConnect({ srv: ["x"] }));
  await m.add(stdio("srv"));
  assert.equal(reg.contains("srv.x"), true);
  assert.equal(await m.remove("srv"), true);
  assert.equal(reg.contains("srv.x"), false);
  assert.equal(m.get("srv"), undefined);
  assert.equal(await m.remove("srv"), false);
});

test("health returns tool count; replace validates; reload restores stopped on failure", async () => {
  const reg = new ToolRegistry();
  const m = new McpManager(reg, fakeConnect({ srv: ["a", "b", "c"] }));
  await m.add(stdio("srv"));
  assert.equal(await m.health("srv"), 3);

  // replace: prefix mismatch + unknown → 400.
  await assert.rejects(
    m.replace("srv", stdio("other")),
    (e) => e instanceof McpManagerError && e.status === 400,
  );
  await assert.rejects(
    m.replace("ghost", stdio("ghost")),
    (e) => e instanceof McpManagerError && e.status === 400,
  );
  // valid replace re-registers.
  await m.replace("srv", stdio("srv"));
  assert.equal(m.get("srv")!.status, "running");

  // reload where the connection now fails → slot preserved as Stopped + throws.
  let failNow = false;
  const flaky: McpConnect = async (cfg) => {
    if (failNow) throw new Error("boom");
    return fakeConnect()(cfg);
  };
  const m3 = new McpManager(new ToolRegistry(), flaky);
  await m3.add(stdio("srv")); // running
  failNow = true;
  await assert.rejects(m3.reload("srv"));
  assert.equal(m3.get("srv")!.status, "stopped");

  // replace where the connection now fails → slot preserved (last-known-good
  // config) as Stopped + throws, so the registration is not destroyed.
  let replaceFail = false;
  const flaky2: McpConnect = async (cfg) => {
    if (replaceFail) throw new Error("boom");
    return fakeConnect({ srv: ["a"] })(cfg);
  };
  const m4 = new McpManager(new ToolRegistry(), flaky2);
  await m4.add({ ...stdio("srv"), denyTools: ["old"] }); // running, last-known-good config
  replaceFail = true;
  await assert.rejects(m4.replace("srv", { ...stdio("srv"), denyTools: ["new"] }));
  const survived = m4.get("srv")!;
  assert.equal(survived.status, "stopped");
  assert.deepEqual(survived.config.deny_tools, ["old"]); // restored prior config
});

// ---------- routes ---------------------------------------------------------

async function buildApp(state: AppState) {
  const app = Fastify();
  registerMcpRoutes(app, state);
  await app.ready();
  return app;
}

test("mcp routes 503 when no manager", async () => {
  const app = await buildApp({ createAgent: agentUnused });
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/servers" })).statusCode, 503);
  await app.close();
});

test("full route round-trip: add → list → get → health → reload → delete", async () => {
  const reg = new ToolRegistry();
  const mgr = new McpManager(reg, fakeConnect({ gh: ["create_pr", "list_issues"] }));
  const app = await buildApp({ createAgent: agentUnused, mcpManager: mgr });

  const added = await app.inject({
    method: "POST",
    url: "/v1/mcp/servers",
    payload: { prefix: "gh", transport: { type: "stdio", command: "x" } },
  });
  assert.equal(added.statusCode, 201);
  assert.deepEqual(added.json(), { prefix: "gh", tools: ["gh.create_pr", "gh.list_issues"] });

  const list = (await app.inject({ method: "GET", url: "/v1/mcp/servers" })).json() as {
    servers: { prefix: string; status: string; config: { prefix: string } }[];
  };
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0]!.status, "running");
  assert.equal(list.servers[0]!.config.prefix, "gh"); // wire config present

  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/servers/gh" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/servers/nope" })).statusCode, 404);

  // duplicate add → 409
  const dup = await app.inject({
    method: "POST",
    url: "/v1/mcp/servers",
    payload: { prefix: "gh", transport: { type: "stdio", command: "x" } },
  });
  assert.equal(dup.statusCode, 409);

  const health = await app.inject({ method: "POST", url: "/v1/mcp/servers/gh/health" });
  assert.equal(health.statusCode, 200);
  const hb = health.json() as { ok: boolean; tools: number; latency_ms: number };
  assert.equal(hb.ok, true);
  assert.equal(hb.tools, 2);
  assert.ok(typeof hb.latency_ms === "number");

  const reload = await app.inject({ method: "POST", url: "/v1/mcp/servers/gh/reload" });
  assert.equal(reload.statusCode, 200);
  assert.deepEqual((reload.json() as { tools: string[] }).tools, ["gh.create_pr", "gh.list_issues"]);

  const del = await app.inject({ method: "DELETE", url: "/v1/mcp/servers/gh" });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true, prefix: "gh" });
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/mcp/servers/gh" })).statusCode, 404);
  assert.equal(reg.contains("gh.create_pr"), false);
  await app.close();
});

test("health on an unknown server reports ok:false with 200", async () => {
  const mgr = new McpManager(new ToolRegistry(), fakeConnect());
  const app = await buildApp({ createAgent: agentUnused, mcpManager: mgr });
  const r = await app.inject({ method: "POST", url: "/v1/mcp/servers/ghost/health" });
  assert.equal(r.statusCode, 200);
  assert.equal((r.json() as { ok: boolean }).ok, false);
  await app.close();
});
