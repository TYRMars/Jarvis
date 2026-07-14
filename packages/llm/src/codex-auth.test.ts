import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { CodexAuth } from "./codex-auth.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-auth-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeAuthJson(dir: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, "auth.json"), contents, "utf8");
}

// ---------- loadFromCodexHome ----------

test("loadFromCodexHome: pulls tokens from auth.json", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(
      dir,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { id_token: "header.payload.sig", access_token: "at-1", refresh_token: "rt-1", account_id: "acct-1" },
        last_refresh: "2026-04-01T12:00:00Z",
      }),
    );
    const auth = await CodexAuth.loadFromCodexHome(dir);
    assert.equal(auth.accessToken, "at-1");
    assert.equal(auth.refreshToken, "rt-1");
    assert.equal(auth.accountId, "acct-1");
    assert.equal(auth.canRefresh(), true);
  });
});

test("loadFromCodexHome: rejects a missing tokens block", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ auth_mode: "chatgpt" }));
    await assert.rejects(() => CodexAuth.loadFromCodexHome(dir), /tokens/);
  });
});

test("loadFromCodexHome: rejects a missing access_token", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ tokens: { id_token: "x", refresh_token: "rt" } }));
    await assert.rejects(() => CodexAuth.loadFromCodexHome(dir), /access_token/);
  });
});

test("loadFromCodexHome: rejects a missing file", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => CodexAuth.loadFromCodexHome(dir), /auth\.json/);
  });
});

test("loadFromFile: account_id / refresh_token optional → null", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "auth.json");
    await writeFile(file, JSON.stringify({ tokens: { access_token: "at" } }), "utf8");
    const auth = await CodexAuth.loadFromFile(file);
    assert.equal(auth.accessToken, "at");
    assert.equal(auth.refreshToken, null);
    assert.equal(auth.accountId, null);
    assert.equal(auth.canRefresh(), false);
  });
});

// ---------- fromStatic ----------

test("fromStatic: no refresh capability; refresh throws clearly", async () => {
  const auth = CodexAuth.fromStatic({ accessToken: "static-token", accountId: "acct" });
  assert.equal(auth.accessToken, "static-token");
  assert.equal(auth.refreshToken, null);
  assert.equal(auth.accountId, "acct");
  assert.equal(auth.canRefresh(), false);
  await assert.rejects(() => auth.refresh(), /static-token mode cannot refresh/);
});

// ---------- refresh ----------

test("refresh: posts grant_type=refresh_token + client_id; updates token in memory and on disk", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(
      dir,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-keep-me",
        tokens: { id_token: "x", access_token: "old-at", refresh_token: "rt-1", account_id: "acct" },
      }),
    );

    let capturedUrl = "";
    let capturedBody = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "rt-2" }), { status: 200 });
    };

    const auth = await CodexAuth.loadFromCodexHome(dir, { refreshUrl: "https://stub.test/oauth/token", fetchImpl });
    await auth.refresh();

    assert.equal(capturedUrl, "https://stub.test/oauth/token");
    const form = new URLSearchParams(capturedBody);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "rt-1");
    assert.equal(form.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");

    assert.equal(auth.accessToken, "new-at");
    assert.equal(auth.refreshToken, "rt-2");

    // On-disk: token rotated, unrelated fields preserved.
    const after = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8")) as {
      auth_mode: string;
      OPENAI_API_KEY: string;
      tokens: { access_token: string; refresh_token: string; account_id: string };
    };
    assert.equal(after.auth_mode, "chatgpt");
    assert.equal(after.OPENAI_API_KEY, "sk-keep-me");
    assert.equal(after.tokens.access_token, "new-at");
    assert.equal(after.tokens.refresh_token, "rt-2");
    assert.equal(after.tokens.account_id, "acct");
  });
});

test("refresh: keeps existing refresh_token when the response omits a new one", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ tokens: { access_token: "old", refresh_token: "rt-1" } }));
    const auth = await CodexAuth.loadFromCodexHome(dir, {
      refreshUrl: "https://stub.test/oauth/token",
      fetchImpl: async () => new Response(JSON.stringify({ access_token: "new" }), { status: 200 }),
    });
    await auth.refresh();
    assert.equal(auth.accessToken, "new");
    assert.equal(auth.refreshToken, "rt-1");
  });
});

test("refresh: non-2xx surfaces status + body", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ tokens: { access_token: "old", refresh_token: "rt-1" } }));
    const auth = await CodexAuth.loadFromCodexHome(dir, {
      refreshUrl: "https://stub.test/oauth/token",
      fetchImpl: async () => new Response("bad token", { status: 400 }),
    });
    await assert.rejects(() => auth.refresh(), /refresh failed: status 400: bad token/);
  });
});

test("refresh: concurrent calls coalesce into a single network round-trip", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ tokens: { access_token: "old", refresh_token: "rt-1" } }));

    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      // Hold the first (winning) request open so a second refresh() overlaps it.
      await gate;
      return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "rt-2" }), { status: 200 });
    };

    const auth = await CodexAuth.loadFromCodexHome(dir, { refreshUrl: "https://stub.test/oauth/token", fetchImpl });

    const first = auth.refresh();
    const second = auth.refresh();
    // Both started while the first fetch is still pending; only one POSTs.
    release();
    await Promise.all([first, second]);

    assert.equal(calls, 1, "only the winning refresh should POST the (rotating) refresh_token");
    assert.equal(auth.accessToken, "new-at");
    assert.equal(auth.refreshToken, "rt-2");
  });
});

test("refresh: a fresh call after one settles POSTs again", async () => {
  await withTempDir(async (dir) => {
    await writeAuthJson(dir, JSON.stringify({ tokens: { access_token: "old", refresh_token: "rt-1" } }));
    let calls = 0;
    const auth = await CodexAuth.loadFromCodexHome(dir, {
      refreshUrl: "https://stub.test/oauth/token",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: `at-${calls}` }), { status: 200 });
      },
    });
    await auth.refresh();
    await auth.refresh();
    assert.equal(calls, 2, "sequential refreshes are independent — coalescing only spans in-flight overlap");
  });
});

// ---------- writeBack ----------

test("writeBack: preserves unrelated fields and creates the tokens block when absent", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "auth.json");
    await writeFile(file, JSON.stringify({ keep: "me" }), "utf8");
    const auth = CodexAuth.fromStatic({ accessToken: "x" });
    auth.accessToken = "written";
    await auth.writeBack(file);
    const after = JSON.parse(await readFile(file, "utf8")) as { keep: string; tokens: { access_token: string } };
    assert.equal(after.keep, "me");
    assert.equal(after.tokens.access_token, "written");
  });
});
