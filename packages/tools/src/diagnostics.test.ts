// The post-write diagnostics hook: the `withDiagnostics` helper and its
// integration into fs.write / fs.edit / fs.patch. A real LSP server is not
// needed — a fake hook stands in for the `@jarvis/lsp` reporter.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { FsEditTool, FsWriteTool } from "./fs.ts";
import { FsPatchTool } from "./patch.ts";
import { withDiagnostics, type DiagnosticsHook } from "./diagnostics.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-diag-"));
}

// A hook that records the paths it was asked about and returns a canned block.
function recordingHook(block: string): { hook: DiagnosticsHook; seen: string[][] } {
  const seen: string[][] = [];
  const hook: DiagnosticsHook = (paths) => {
    seen.push(paths);
    return Promise.resolve(block);
  };
  return { hook, seen };
}

test("withDiagnostics: appends a non-empty block, passes through empty", async () => {
  const empty: DiagnosticsHook = () => Promise.resolve("");
  const filled: DiagnosticsHook = () => Promise.resolve("<diagnostics/>");
  assert.equal(await withDiagnostics("ok", undefined, ["/a"]), "ok");
  assert.equal(await withDiagnostics("ok", empty, ["/a"]), "ok");
  assert.equal(await withDiagnostics("ok", filled, ["/a"]), "ok\n<diagnostics/>");
  assert.equal(await withDiagnostics("ok", filled, []), "ok", "no paths → no call");
});

test("withDiagnostics: a throwing hook never breaks the result", async () => {
  const boom: DiagnosticsHook = () => Promise.reject(new Error("lsp down"));
  assert.equal(await withDiagnostics("wrote", boom, ["/a"]), "wrote");
});

test("fs.write: appends the diagnostics block for the written file", async () => {
  const dir = tmpdir();
  const { hook, seen } = recordingHook('<diagnostics file="x.ts">\nERROR [1:1] boom\n</diagnostics>');
  const write = new FsWriteTool({ root: dir, diagnostics: hook });
  const out = await write.invoke({ path: "x.ts", content: "const a: number = 'no';" });
  assert.match(out, /^wrote \d+ bytes to /);
  assert.match(out, /ERROR \[1:1\] boom/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.[0], path.join(dir, "x.ts"));
});

test("fs.edit: appends the diagnostics block for the edited file", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "y.ts"), "let v = 1;");
  const { hook } = recordingHook("<diagnostics/>");
  const edit = new FsEditTool({ root: dir, diagnostics: hook });
  const out = await edit.invoke({ path: "y.ts", old_string: "1", new_string: "2" });
  assert.match(out, /replaced 1 occurrence/);
  assert.match(out, /<diagnostics\/>$/);
});

test("fs.write: no hook → unchanged result (historical default)", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const out = await write.invoke({ path: "z.ts", content: "ok" });
  assert.match(out, /^wrote \d+ bytes to /);
  assert.doesNotMatch(out, /diagnostics/);
});

test("fs.patch: diagnoses created/modified files, not deletes", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "mod.ts"), "old\n");
  const { hook, seen } = recordingHook("<diagnostics/>");
  const patch = new FsPatchTool({ root: dir, diagnostics: hook });
  const diff = [
    "--- a/mod.ts",
    "+++ b/mod.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const out = await patch.invoke({ diff });
  assert.match(out, /M mod\.ts/);
  assert.match(out, /<diagnostics\/>$/);
  assert.deepEqual(seen, [[path.join(dir, "mod.ts")]]);
});
