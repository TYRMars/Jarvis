import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicWrite } from "./json-file.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-atomic-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Regression for #502: a fixed `<path>.tmp` made concurrent writers of one
// target share a staging file, so the loser's rename hit ENOENT and its write
// was silently dropped. A unique tmp per write makes last-write-wins hold.
test("atomicWrite: concurrent writes to one path never ENOENT and one wins", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "c1.json");
    const contents = Array.from({ length: 12 }, (_, i) => `writer-${i}-`.repeat(3000));

    // All writers race the same target. Pre-fix this rejected with ENOENT
    // from rename for every writer but the winner.
    await Promise.all(contents.map((c) => atomicWrite(target, c)));

    const final = await readFile(target, "utf8");
    assert.ok(contents.includes(final), "final content must be one full writer's payload (no torn write)");

    // No staging litter left behind — only the target remains.
    const names = await readdir(dir);
    assert.deepEqual(names, ["c1.json"]);
  });
});

test("atomicWrite: writes the exact contents for a single writer", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "solo.json");
    await atomicWrite(target, "hello");
    assert.equal(await readFile(target, "utf8"), "hello");
    assert.deepEqual(await readdir(dir), ["solo.json"]);
  });
});
