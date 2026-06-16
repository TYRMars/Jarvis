import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import {
  Agent,
  LlmProviderBase,
  ToolRegistry,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
} from "@jarvis/core";
import { buildServer } from "./server.ts";
import { registerUiRoutes, pathLooksLikeAsset } from "./ui.ts";
import type { AppState } from "./state.ts";

const INDEX_HTML = "<!doctype html><html><head><title>Jarvis</title></head><body><div id=root></div></body></html>";
const APP_JS = "console.log('hello from app.js');\n";

/** Create a temp distDir with index.html + assets/app.js. Returns its path. */
async function makeDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-ui-"));
  await writeFile(join(dir, "index.html"), INDEX_HTML);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), APP_JS);
  return dir;
}

/** A do-nothing provider so AppState.createAgent is constructible. */
class NoopProvider extends LlmProviderBase {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve({
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
      response_id: null,
    });
  }
}

function noopState(distDir?: string): AppState {
  const provider = new NoopProvider();
  const tools = new ToolRegistry();
  return {
    webDistDir: distDir,
    createAgent: () => new Agent(provider, { ...defaultAgentConfig("test-model"), tools }),
  };
}

// ---------- pathLooksLikeAsset unit ----------

test("pathLooksLikeAsset partitions extension-less SPA routes from assets", () => {
  assert.equal(pathLooksLikeAsset("assets/app.js"), true);
  assert.equal(pathLooksLikeAsset("favicon.ico"), true);
  assert.equal(pathLooksLikeAsset("nope.js"), true);
  assert.equal(pathLooksLikeAsset("settings"), false);
  assert.equal(pathLooksLikeAsset("conversations/abc-123"), false);
  assert.equal(pathLooksLikeAsset(""), false);
  // A dot in an earlier segment but not the last one is still a route.
  assert.equal(pathLooksLikeAsset("v1.2/settings"), false);
});

// ---------- fresh Fastify + registerUiRoutes ----------

test("registerUiRoutes: serves index, SPA fallback, assets, and 404s", async () => {
  const dir = await makeDist();
  const app = Fastify({ logger: false });
  registerUiRoutes(app, { distDir: dir });
  await app.ready();
  try {
    // GET / → index.html
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.match(root.headers["content-type"] as string, /text\/html/);
    assert.equal(root.body, INDEX_HTML);

    // GET /settings (extension-less, unmatched) → SPA fallback → index.html
    const spa = await app.inject({ method: "GET", url: "/settings" });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.headers["content-type"] as string, /text\/html/);
    assert.equal(spa.body, INDEX_HTML);

    // nested extension-less route → SPA fallback
    const nested = await app.inject({ method: "GET", url: "/conversations/abc-123" });
    assert.equal(nested.statusCode, 200);
    assert.equal(nested.body, INDEX_HTML);

    // GET /assets/app.js → the asset itself
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, APP_JS);

    // GET /nope.js (missing, has extension) → 404, NOT index.html
    const missing = await app.inject({ method: "GET", url: "/nope.js" });
    assert.equal(missing.statusCode, 404);
    assert.notEqual(missing.body, INDEX_HTML);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- via buildServer (full route stack) ----------

test("buildServer with webDistDir: SPA fallback never shadows /v1 or /health", async () => {
  const dir = await makeDist();
  const app: FastifyInstance = await buildServer(noopState(dir));
  try {
    // GET / → index.html
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.equal(root.body, INDEX_HTML);

    // GET /settings → SPA fallback
    const spa = await app.inject({ method: "GET", url: "/settings" });
    assert.equal(spa.statusCode, 200);
    assert.equal(spa.body, INDEX_HTML);

    // GET /assets/app.js → asset
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.body, APP_JS);

    // GET /nope.js → 404 (extensioned + missing)
    const missingAsset = await app.inject({ method: "GET", url: "/nope.js" });
    assert.equal(missingAsset.statusCode, 404);

    // CRITICAL: GET /v1/unmatched → 404, NOT index.html. SDK clients must not
    // get `<!doctype html>` back to parse as JSON.
    const v1 = await app.inject({ method: "GET", url: "/v1/unmatched" });
    assert.equal(v1.statusCode, 404);
    assert.notEqual(v1.body, INDEX_HTML);
    assert.doesNotMatch((v1.headers["content-type"] as string) ?? "", /text\/html/);

    // GET /health → still works (real route, unaffected by the fallback).
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildServer without webDistDir: no UI, / 404s and /health still works", async () => {
  const app = await buildServer(noopState(undefined));
  try {
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 404);
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});
