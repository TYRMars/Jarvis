// End-to-end tests for the LSP client + manager against a real child process
// (the mock server in `mock-lsp-server.ts`), so framing, the initialize
// handshake, didOpen, push diagnostics, and the settle window are all exercised
// for real — only the *language server* is a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { LspManager } from "./manager.ts";
import { report, pretty } from "./diagnostic.ts";
import { DefaultLanguageRegistry, whichSync, type LanguageRegistry, type ServerSpec } from "./registry.ts";

const MOCK_SERVER = fileURLToPath(new URL("./mock-lsp-server.ts", import.meta.url));

/** Registry that routes a chosen extension to the mock server over `node`. */
function mockRegistry(ext: string, extraArgs: string[] = []): LanguageRegistry {
  return {
    resolve(absPath: string): ServerSpec | null {
      if (!absPath.endsWith(ext)) return null;
      return {
        serverKey: "mock",
        command: process.execPath,
        args: ["--experimental-strip-types", MOCK_SERVER, ...extraArgs],
        languageId: "plaintext",
      };
    },
  };
}

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-lsp-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("LspManager.report: surfaces an errors-only block from a push server", async () => {
  await withWorkspace(async (dir) => {
    const file = join(dir, "x.mock");
    await writeFile(file, "first line @@ERROR@@ boom\nsecond line");
    const manager = new LspManager({ root: dir, registry: mockRegistry(".mock"), timeoutMs: 4000, settleMs: 150 });
    try {
      const block = await manager.report([file]);
      assert.match(block, /^<diagnostics file="x\.mock">/);
      assert.match(block, /ERROR \[1:1\] mock error: boom/);
      assert.match(block, /<\/diagnostics>$/);
    } finally {
      await manager.dispose();
    }
  });
});

test("LspManager.report: a clean file yields an empty string", async () => {
  await withWorkspace(async (dir) => {
    const file = join(dir, "ok.mock");
    await writeFile(file, "no markers here\njust fine");
    const manager = new LspManager({ root: dir, registry: mockRegistry(".mock"), timeoutMs: 4000, settleMs: 150 });
    try {
      assert.equal(await manager.report([file]), "");
    } finally {
      await manager.dispose();
    }
  });
});

test("LspManager.report: reuses one server across multiple files", async () => {
  await withWorkspace(async (dir) => {
    const bad = join(dir, "a.mock");
    const good = join(dir, "b.mock");
    await writeFile(bad, "@@ERROR@@ first");
    await writeFile(good, "clean");
    const manager = new LspManager({ root: dir, registry: mockRegistry(".mock"), timeoutMs: 4000, settleMs: 150 });
    try {
      const block = await manager.report([bad, good]);
      assert.match(block, /a\.mock/);
      assert.match(block, /mock error: first/);
      assert.doesNotMatch(block, /b\.mock/); // clean file contributes nothing
    } finally {
      await manager.dispose();
    }
  });
});

test("LspManager.report: unsupported extension is a no-op", async () => {
  await withWorkspace(async (dir) => {
    const file = join(dir, "note.txt");
    await writeFile(file, "@@ERROR@@ ignored");
    const manager = new LspManager({ root: dir, registry: mockRegistry(".mock") });
    try {
      assert.equal(await manager.report([file]), "");
    } finally {
      await manager.dispose();
    }
  });
});

test("LspManager.report: a missing server binary degrades to empty (no throw)", async () => {
  await withWorkspace(async (dir) => {
    const file = join(dir, "x.mock");
    await writeFile(file, "@@ERROR@@ boom");
    const registry: LanguageRegistry = {
      resolve: () => ({ serverKey: "ghost", command: "definitely-not-a-real-lsp-binary", args: [], languageId: "x" }),
    };
    const manager = new LspManager({ root: dir, registry, timeoutMs: 1200, settleMs: 100 });
    try {
      assert.equal(await manager.report([file]), "");
    } finally {
      await manager.dispose();
    }
  });
});

test("LspManager.report: a never-ready server is evicted, then re-spawned (#285)", async () => {
  await withWorkspace(async (dir) => {
    const file = join(dir, "x.mock");
    await writeFile(file, "@@ERROR@@ boom");
    // The mock reads this file at startup: "hang" → never answers initialize.
    const modeFile = join(dir, "mode");
    await writeFile(modeFile, "hang");

    const manager = new LspManager({
      root: dir,
      registry: mockRegistry(".mock", [`--mode-file=${modeFile}`]),
      // Short init cap so the hung handshake fails fast; no backoff so the very
      // next report() is allowed to re-spawn.
      timeoutMs: 400,
      settleMs: 100,
      respawnBackoffMs: 0,
    });
    try {
      // First run: the server spawns but never initializes → degrades to "".
      assert.equal(await manager.report([file]), "", "never-ready server yields no diagnostics");

      // Flip the server healthy; the dead client must have been evicted so this
      // run re-spawns a fresh, working one and surfaces the diagnostic.
      await writeFile(modeFile, "ok");
      const block = await manager.report([file]);
      assert.match(block, /^<diagnostics file="x\.mock">/, `expected a re-spawned diagnosis, got: ${JSON.stringify(block)}`);
      assert.match(block, /mock error: boom/);
    } finally {
      await manager.dispose();
    }
  });
});

// --- pure formatter ---

test("report/pretty: errors only, 1-based line/col, capped", () => {
  assert.equal(report("f.ts", []), "");
  assert.equal(
    report("f.ts", [{ range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } }, severity: 2, message: "warn" }]),
    "",
    "warnings are dropped",
  );
  const block = report("f.ts", [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "boom" },
  ]);
  assert.equal(block, '<diagnostics file="f.ts">\nERROR [1:1] boom\n</diagnostics>');
  assert.equal(
    pretty({ range: { start: { line: 9, character: 4 }, end: { line: 9, character: 9 } }, severity: 1, message: "x" }),
    "ERROR [10:5] x",
  );
});

test("whichSync: probes the supplied search path (no process.env)", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(join(dir, "mybin"), "#!/bin/sh\n");
    // Bare name found via the search path; absent name / no-path → false.
    assert.equal(whichSync("mybin", { path: dir }), true);
    assert.equal(whichSync("ghost", { path: dir }), false);
    assert.equal(whichSync("mybin", {}), false, "no path → bare names unresolved");
    // A command with a separator is checked directly, ignoring the path.
    assert.equal(whichSync(join(dir, "mybin")), true);
    assert.equal(whichSync(join(dir, "ghost")), false);
  });
});

test("DefaultLanguageRegistry: unknown extension is null; known ext needs an installed server", () => {
  const reg = new DefaultLanguageRegistry({ path: "" });
  assert.equal(reg.resolve("/tmp/readme.unknownext"), null);
  // .ts is known, but with an empty search path no server resolves.
  assert.equal(reg.resolve("/tmp/x.ts"), null);
});
