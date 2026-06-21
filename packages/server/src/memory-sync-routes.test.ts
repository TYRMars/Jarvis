import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMemorySyncRoutes } from "./memory-sync-routes.ts";
import type { AppState, MemoryRuntime } from "./state.ts";

async function appWith(rt?: MemoryRuntime): Promise<FastifyInstance> {
  const app = Fastify();
  const state = (rt !== undefined ? { memoryRuntime: rt } : {}) as unknown as AppState;
  registerMemorySyncRoutes(app, state);
  await app.ready();
  return app;
}

test("all routes 503 'memory tools not enabled' when no memoryRuntime", async () => {
  const app = await appWith(undefined);
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
    // sync/sync_setup/icloud short-circuit on backend BEFORE the runtime check,
    // so with no runtime they 503 either way; the message differs but the code
    // is always 503.
    assert.equal(r.statusCode, 503, `${method} ${url}`);
  }
  await app.close();
});

test("none backend: sync_status envelope has no user_scope; sync 503s", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-msr-"));
  try {
    const app = await appWith({ workspaceRoot: ws, userRoot: ws, backend: "none" });

    const status = await app.inject({ method: "GET", url: "/v1/memory/sync_status" });
    assert.equal(status.statusCode, 200);
    const body = status.json() as Record<string, unknown>;
    assert.equal(body["backend"], "none");
    assert.equal(body["workspace_root"], ws);
    assert.equal(body["user_root"], ws);
    assert.equal(body["user_scope"], undefined, "none backend omits user_scope");

    const sync = await app.inject({ method: "POST", url: "/v1/memory/sync", payload: {} });
    assert.equal(sync.statusCode, 503);
    assert.equal((sync.json() as { backend: string }).backend, "none");

    // includes list is backend-agnostic and works (empty tree → empty list).
    const inc = await app.inject({ method: "GET", url: "/v1/memory/includes?scope=workspace" });
    assert.equal(inc.statusCode, 200);

    await app.close();
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("git backend: sync_status digs into user_scope; sync_setup validates body", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-msr-"));
  try {
    const app = await appWith({ workspaceRoot: ws, userRoot: ws, backend: "git" });

    const status = await app.inject({ method: "GET", url: "/v1/memory/sync_status" });
    assert.equal(status.statusCode, 200);
    const body = status.json() as { backend: string; user_scope?: { is_git_repo?: boolean } };
    assert.equal(body.backend, "git");
    assert.equal(body.user_scope?.is_git_repo, false, "user memory dir is not a repo yet");

    // sync_setup with the git backend but no remote_url → 400 (reached the body
    // check, not the backend 503).
    const setup = await app.inject({ method: "POST", url: "/v1/memory/sync_setup", payload: {} });
    assert.equal(setup.statusCode, 400);
    assert.match((setup.json() as { error: string }).error, /remote_url/);

    await app.close();
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test("icloud backend: git sync ops 503 with a backend-mismatch error", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-msr-"));
  try {
    const app = await appWith({ workspaceRoot: ws, userRoot: ws, backend: "icloud" });
    const sync = await app.inject({ method: "POST", url: "/v1/memory/sync", payload: {} });
    assert.equal(sync.statusCode, 503);
    assert.match((sync.json() as { error: string }).error, /git/);
    await app.close();
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
