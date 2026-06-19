import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPrefs, savePrefs } from "./prefs.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-desktop-prefs-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("round-trips the workspace", async () => {
  await withTempDir(async (dir) => {
    await savePrefs(dir, { workspace: "/tmp/work" });
    const loaded = await loadPrefs(dir);
    assert.equal(loaded.workspace, "/tmp/work");
  });
});

test("missing file returns defaults", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadPrefs(dir), {});
  });
});

test("invalid JSON returns defaults", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "prefs.json"), "{not json");
    assert.deepEqual(await loadPrefs(dir), {});
  });
});

test("non-string workspace is ignored", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "prefs.json"), JSON.stringify({ workspace: 42 }));
    assert.deepEqual(await loadPrefs(dir), {});
  });
});
