import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LogBuffer } from "./logs.ts";
import { pickPort } from "./net.ts";
import { loadPrefs, savePrefs } from "./prefs.ts";
import { ServerManager } from "./server-manager.ts";

// Integration smoke test for P7.6's load-bearing claim: the Electron main embeds
// @jarvis/server IN-PROCESS (no spawned `jarvis` binary) and actually serves over
// the loopback. This is the headless stand-in for launching the GUI — it exercises
// the full build chain loadConfig → buildProvider → openStores → buildAppState →
// serve(), plus the live-probe status() and clean shutdown.
//
// A dummy OPENAI_API_KEY lets buildProvider construct the provider offline (the
// key is only validated on a real LLM call, which this test never makes). webDist
// is "" so the server skips the SPA static routes (no dist dir required).

test("embeds @jarvis/server in-process and serves over loopback", async () => {
  const prefsDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-prefs-"));
  const dbDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-db-"));
  const manager = new ServerManager({
    logs: new LogBuffer(),
    prefsDir,
    webDist: "",
    env: {
      OPENAI_API_KEY: "test-dummy-key",
      JARVIS_PROVIDER: "openai",
      JARVIS_DB_URL: `json://${dbDir}`,
    },
  });

  try {
    await manager.init();
    // forceEmbedded so the test never reuses a real server a dev may have on :7001.
    await manager.ensureServer({ forceEmbedded: true });

    const status = await manager.status();
    assert.equal(status.server_kind, "embedded", status.last_error ?? "expected embedded");
    assert.equal(status.server_running, true);
    assert.match(status.api_origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    // The embedded server actually answers over its loopback origin.
    const health = await fetch(`${status.api_origin}/health`);
    assert.equal(health.status, 200);

    // Persistence is wired (json store) → conversations list responds 200.
    const convs = await fetch(`${status.api_origin}/v1/conversations`);
    assert.equal(convs.status, 200);

    // After stop(), the live probe in status() reports it down.
    await manager.stop();
    const stopped = await manager.status();
    assert.equal(stopped.server_running, false);
    assert.equal(stopped.server_kind, "stopped");
  } finally {
    await manager.stop();
    await rm(prefsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("LAN exposure binds beyond loopback, injects a persisted token, and reverts", async () => {
  const prefsDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-prefs-"));
  const dbDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-db-"));
  // Pin the "stable" LAN port to a known-free ephemeral one so the test never
  // collides with a real server on :7001.
  const lanPort = await pickPort();
  await savePrefs(prefsDir, { lanPort });
  const manager = new ServerManager({
    logs: new LogBuffer(),
    prefsDir,
    webDist: "",
    env: {
      OPENAI_API_KEY: "test-dummy-key",
      JARVIS_PROVIDER: "openai",
      JARVIS_DB_URL: `json://${dbDir}`,
    },
  });

  try {
    await manager.init();
    const exposed = await manager.setLanExposure(true);
    assert.equal(exposed.lan_exposure, true);
    assert.equal(exposed.server_kind, "embedded", exposed.last_error ?? "expected embedded");
    // The window keeps talking loopback even though the bind is 0.0.0.0.
    assert.match(exposed.api_origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(exposed.api_origin.endsWith(`:${lanPort}`), `expected stable port ${lanPort}`);

    // The auth gate is live: /v1/remote/info reports requires_auth over loopback.
    const info = (await (await fetch(`${exposed.api_origin}/v1/remote/info`)).json()) as {
      requires_auth: boolean;
    };
    assert.equal(info.requires_auth, true);

    // The generated token is persisted for stable pairing across restarts.
    const prefs = await loadPrefs(prefsDir);
    assert.ok(prefs.accessToken && prefs.accessToken.length > 0, "expected a persisted token");

    const reverted = await manager.setLanExposure(false);
    assert.equal(reverted.lan_exposure, false);
    assert.equal(reverted.server_running, true);
    const openInfo = (await (await fetch(`${reverted.api_origin}/v1/remote/info`)).json()) as {
      requires_auth: boolean;
    };
    assert.equal(openInfo.requires_auth, false);
  } finally {
    await manager.stop();
    await rm(prefsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("startup failure (missing credential) is captured, not thrown", async () => {
  const prefsDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-prefs-"));
  const dbDir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-db-"));
  const manager = new ServerManager({
    logs: new LogBuffer(),
    prefsDir,
    webDist: "",
    // No OPENAI_API_KEY → buildProvider throws; the manager must degrade, not crash.
    env: { JARVIS_PROVIDER: "openai", JARVIS_DB_URL: `json://${dbDir}` },
  });

  try {
    await manager.init();
    await manager.ensureServer({ forceEmbedded: true });
    const status = await manager.status();
    assert.equal(status.server_running, false);
    assert.equal(status.server_kind, "stopped");
    assert.ok(status.last_error && status.last_error.length > 0, "expected a recorded last_error");
  } finally {
    await manager.stop();
    await rm(prefsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});
