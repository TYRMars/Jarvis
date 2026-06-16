import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectChecksTool } from "./checks.ts";

interface Suggestion {
  manifest: string;
  kind: string;
  command: string;
  why: string;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-checks-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function run(dir: string): Promise<Suggestion[]> {
  const tool = new ProjectChecksTool({ root: dir });
  const out = JSON.parse(await tool.invoke({})) as { suggestions: Suggestion[] };
  return out.suggestions;
}

test("rust workspace emits cargo suggestions", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "Cargo.toml"), "[workspace]\n");
    const suggestions = await run(dir);
    const cmds = suggestions.map((s) => s.command);
    assert.ok(cmds.some((c) => c.startsWith("cargo check")));
    assert.ok(cmds.some((c) => c.includes("clippy")));
    assert.ok(cmds.some((c) => c.startsWith("cargo test")));
  });
});

test("empty workspace returns empty list", async () => {
  await withTempDir(async (dir) => {
    const suggestions = await run(dir);
    assert.equal(suggestions.length, 0);
  });
});

test("polyglot repo emits per-ecosystem suggestions", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "Cargo.toml"), "[workspace]\n");
    await writeFile(path.join(dir, "package.json"), "{}\n");
    const suggestions = await run(dir);
    const manifests = suggestions.map((s) => s.manifest);
    assert.ok(manifests.includes("Cargo.toml"));
    assert.ok(manifests.includes("package.json"));
  });
});

test("each suggestion carries manifest / kind / command / why", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "go.mod"), "module x\n");
    const suggestions = await run(dir);
    assert.ok(suggestions.length > 0);
    for (const s of suggestions) {
      assert.equal(typeof s.manifest, "string");
      assert.equal(typeof s.kind, "string");
      assert.equal(typeof s.command, "string");
      assert.equal(typeof s.why, "string");
    }
    // go.mod yields exactly test / lint / build.
    assert.deepEqual(
      suggestions.map((s) => s.kind),
      ["test", "lint", "build"],
    );
  });
});

test("pyproject yields python test + lint only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "pyproject.toml"), "[project]\n");
    const suggestions = await run(dir);
    assert.deepEqual(
      suggestions.map((s) => s.command),
      ["pytest", "ruff check ."],
    );
  });
});
