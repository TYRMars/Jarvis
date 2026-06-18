import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerProviderAdminRoutes, ProvisionError } from "./provider-admin-routes.ts";
import type {
  ProviderAdmin,
  ProviderDef,
  ProviderSnapshot,
} from "./provider-admin-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/**
 * Tiny in-memory ProviderAdmin for the route tests. Keyed by name, tracks a
 * default, mirrors the Rust impl's status semantics (already-exists → conflict,
 * missing → not-found). `keyed` records whether an api_key was on the last
 * write so a snapshot can report `has_api_key`.
 */
class MemoryProviderAdmin implements ProviderAdmin {
  private rows = new Map<string, ProviderDef>();
  private hasKey = new Map<string, boolean>();
  private defaultName: string;
  constructor(defaultName = "openai") {
    this.defaultName = defaultName;
  }
  private toSnapshot(name: string): ProviderSnapshot {
    const def = this.rows.get(name);
    if (!def) throw ProvisionError.notFound(name);
    const models = def.models && def.models.length > 0 ? def.models : [def.default_model];
    const snap: ProviderSnapshot = {
      name,
      kind: def.kind,
      has_api_key: this.hasKey.get(name) === true,
      default_model: def.default_model,
      models: models.includes(def.default_model) ? models : [def.default_model, ...models],
      is_default: name === this.defaultName,
    };
    if (def.base_url !== undefined) snap.base_url = def.base_url;
    return snap;
  }
  async provision(def: ProviderDef, allowOverwrite: boolean): Promise<ProviderSnapshot> {
    if (def.name.trim() === "") throw ProvisionError.invalid("`name` must not be blank");
    if (def.kind.trim() === "") throw ProvisionError.invalid("`kind` must not be blank");
    if (this.rows.has(def.name) && !allowOverwrite) throw ProvisionError.alreadyExists(def.name);
    if (!this.rows.has(def.name) && allowOverwrite) throw ProvisionError.notFound(def.name);
    this.rows.set(def.name, def);
    if (def.api_key !== undefined) this.hasKey.set(def.name, def.api_key.trim() !== "");
    else if (!this.hasKey.has(def.name)) this.hasKey.set(def.name, false);
    return this.toSnapshot(def.name);
  }
  async unprovision(name: string, purgeSecret: boolean): Promise<boolean> {
    const existed = this.rows.delete(name);
    if (existed && purgeSecret) this.hasKey.delete(name);
    return existed;
  }
  async setDefault(name: string): Promise<void> {
    if (!this.rows.has(name)) throw ProvisionError.notFound(name);
    this.defaultName = name;
  }
  async snapshot(name: string): Promise<ProviderSnapshot> {
    return this.toSnapshot(name);
  }
}

interface StateOpts {
  admin?: ProviderAdmin | false;
  onChanged?: () => void;
}

function makeState(opts: StateOpts = {}): AppState {
  const base: AppState = { createAgent: agentUnused };
  const widened = base as AppState & {
    providerAdmin?: ProviderAdmin;
    providersChanged?: () => void;
  };
  if (opts.admin !== false) widened.providerAdmin = opts.admin ?? new MemoryProviderAdmin();
  if (opts.onChanged) widened.providersChanged = opts.onChanged;
  return base;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerProviderAdminRoutes(app, state);
  await app.ready();
  return app;
}

test("all routes 503 when no ProviderAdmin is wired", async () => {
  const app = await buildApp(makeState({ admin: false }));
  for (const [method, url] of [
    ["POST", "/v1/providers"],
    ["GET", "/v1/providers/openai"],
    ["PATCH", "/v1/providers/openai"],
    ["DELETE", "/v1/providers/openai"],
    ["PUT", "/v1/providers/default"],
  ] as const) {
    const res = await app.inject({ method, url, payload: { name: "openai" } });
    assert.equal(res.statusCode, 503, `${method} ${url}`);
    assert.match(res.json().error, /provider admin not configured/);
  }
  await app.close();
});

test("POST creates a provider → 201 with snapshot, no key echoed", async () => {
  let changed = 0;
  const app = await buildApp(makeState({ onChanged: () => (changed += 1) }));
  const res = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: {
      name: "kimi",
      kind: "kimi",
      api_key: "secret-123",
      default_model: "kimi-k2-thinking",
      base_url: "https://api.moonshot.cn/v1",
    } satisfies ProviderDef,
  });
  assert.equal(res.statusCode, 201);
  const snap = res.json().provider;
  assert.equal(snap.name, "kimi");
  assert.equal(snap.kind, "kimi");
  assert.equal(snap.has_api_key, true);
  assert.equal(snap.default_model, "kimi-k2-thinking");
  assert.equal(snap.base_url, "https://api.moonshot.cn/v1");
  assert.ok(!("api_key" in snap), "snapshot must never echo the api_key");
  assert.equal(changed, 1, "providersChanged fires once on create");
  await app.close();
});

test("POST a duplicate name → 409 Conflict, no change fired", async () => {
  let changed = 0;
  const app = await buildApp(makeState({ onChanged: () => (changed += 1) }));
  const def: ProviderDef = { name: "openai", kind: "openai", default_model: "gpt-4o-mini" };
  await app.inject({ method: "POST", url: "/v1/providers", payload: def });
  const dup = await app.inject({ method: "POST", url: "/v1/providers", payload: def });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /already exists/);
  assert.equal(changed, 1, "only the first create fires the hook");
  await app.close();
});

test("POST validation: blank kind → 400", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "x", kind: "  ", default_model: "m" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invalid provider config/);
  await app.close();
});

test("GET returns the snapshot; 404 for a missing provider", async () => {
  const app = await buildApp(makeState());
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "openai", kind: "openai", default_model: "gpt-4o-mini" },
  });
  const ok = await app.inject({ method: "GET", url: "/v1/providers/openai" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().provider.name, "openai");

  const missing = await app.inject({ method: "GET", url: "/v1/providers/nope" });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /not found/);
  await app.close();
});

test("PATCH replaces config (name from path); blank/matching body name is fine", async () => {
  let changed = 0;
  const app = await buildApp(makeState({ onChanged: () => (changed += 1) }));
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "openai", kind: "openai", default_model: "gpt-4o-mini" },
  });
  // Body omits name (path is authoritative).
  const patched = await app.inject({
    method: "PATCH",
    url: "/v1/providers/openai",
    payload: { kind: "openai", default_model: "gpt-4o", api_key: "k" },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().provider.default_model, "gpt-4o");
  assert.equal(patched.json().provider.has_api_key, true);
  assert.equal(changed, 2, "create + patch each fire the hook");
  await app.close();
});

test("PATCH refuses an in-body rename → 400", async () => {
  const app = await buildApp(makeState());
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "openai", kind: "openai", default_model: "gpt-4o-mini" },
  });
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/providers/openai",
    payload: { name: "renamed", kind: "openai", default_model: "gpt-4o-mini" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /cannot rename/);
  await app.close();
});

test("PATCH on a missing provider → 404", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "PATCH",
    url: "/v1/providers/ghost",
    payload: { kind: "openai", default_model: "m" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("DELETE removes a provider; idempotent {deleted:false} when absent", async () => {
  let changed = 0;
  const app = await buildApp(makeState({ onChanged: () => (changed += 1) }));
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "kimi", kind: "kimi", default_model: "kimi-k2-thinking" },
  });
  const del = await app.inject({ method: "DELETE", url: "/v1/providers/kimi" });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  const again = await app.inject({ method: "DELETE", url: "/v1/providers/kimi" });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { deleted: false });
  // create + first delete fire; the no-op second delete does not.
  assert.equal(changed, 2);
  await app.close();
});

test("DELETE honours ?purge_secret=false (opt-out)", async () => {
  const app = await buildApp(makeState());
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "kimi", kind: "kimi", default_model: "kimi-k2-thinking" },
  });
  const del = await app.inject({
    method: "DELETE",
    url: "/v1/providers/kimi?purge_secret=false",
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted, true);
  await app.close();
});

test("PUT /default sets the default; blank name → 400; missing → 404", async () => {
  let changed = 0;
  const app = await buildApp(makeState({ onChanged: () => (changed += 1) }));
  await app.inject({
    method: "POST",
    url: "/v1/providers",
    payload: { name: "anthropic", kind: "anthropic", default_model: "claude-3-5-sonnet-latest" },
  });

  const blank = await app.inject({ method: "PUT", url: "/v1/providers/default", payload: { name: "  " } });
  assert.equal(blank.statusCode, 400);
  assert.match(blank.json().error, /must not be blank/);

  const missing = await app.inject({ method: "PUT", url: "/v1/providers/default", payload: { name: "ghost" } });
  assert.equal(missing.statusCode, 404);

  const ok = await app.inject({ method: "PUT", url: "/v1/providers/default", payload: { name: "anthropic" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { default: "anthropic" });
  // create + the one successful set-default fire; the 400/404 attempts do not.
  assert.equal(changed, 2);
  await app.close();
});
