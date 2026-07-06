import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

// Regression for #359: a fixed `<path>.tmp` name meant concurrent writers to
// the SAME target both truncated one temp file (interleaving bytes) and raced
// their renames — one throwing ENOENT, or persisting corrupt JSON. Unique
// per-write temp names make every write land as whole, valid content.
test("atomicWrite: concurrent writes to the same target never corrupt or ENOENT (#359)", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "row.json");
    const N = 64;
    const payloads = Array.from({ length: N }, (_, i) => JSON.stringify({ writer: i, blob: "x".repeat(500) }));

    // All writers fire at once. Before the fix this rejected (ENOENT on the
    // losing rename) and/or left interleaved bytes on disk.
    await Promise.all(payloads.map((p) => atomicWrite(target, p)));

    // The surviving file must be exactly one of the inputs — complete, parseable.
    const bytes = await readFile(target, "utf8");
    const parsed = JSON.parse(bytes) as { writer: number };
    assert.ok(payloads.includes(bytes), "persisted content must be one whole write, not a mix");
    assert.ok(parsed.writer >= 0 && parsed.writer < N);
  });
});

test("atomicWrite: leaves no stray temp files behind after success (#359)", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "row.json");
    await Promise.all(Array.from({ length: 16 }, (_, i) => atomicWrite(target, JSON.stringify({ i }))));
    const names = await readdir(dir);
    assert.deepEqual(
      names.filter((n) => n.endsWith(".tmp")),
      [],
      "no .tmp files should remain after successful writes",
    );
    // And the one surviving real file is still the target, and valid JSON.
    assert.deepEqual(names, ["row.json"]);
    JSON.parse(await readFile(target, "utf8"));
  });
});

test("atomicWrite: distinct targets are independent", async () => {
  await withTempDir(async (dir) => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => atomicWrite(path.join(dir, `r${i}.json`), JSON.stringify({ i }))),
    );
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, Array.from({ length: 8 }, (_, i) => `r${i}.json`).sort());
  });
});
