import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveUnder, SandboxError } from "./sandbox.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sandbox-"));
}

test("rejects parent dir", () => {
  const root = path.join(os.tmpdir(), "doesnt-matter");
  assert.throws(() => resolveUnder(root, "../etc/passwd"), SandboxError);
  assert.throws(() => resolveUnder(root, "a/../../b"), SandboxError);
});

test("rejects absolute", () => {
  const root = path.join(os.tmpdir(), "doesnt-matter");
  assert.throws(() => resolveUnder(root, "/etc/passwd"), SandboxError);
});

test("accepts nested relative", () => {
  const root = path.join(os.tmpdir(), "root");
  const p = resolveUnder(root, "a/b.txt");
  assert.equal(p, path.join(root, "a", "b.txt"));
});

test("accepts real nested path under existing root", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "file.txt"), "hi");
  const resolved = resolveUnder(dir, "sub/file.txt");
  assert.equal(resolved, path.join(dir, "sub", "file.txt"));
});

test("rejects symlink inside root pointing outside", () => {
  // A symlink that lives inside the sandbox root but targets a directory
  // outside it must not be followed.
  const root = tmpdir();
  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  fs.symlinkSync(outside, path.join(root, "link"));

  assert.throws(() => resolveUnder(root, "link/secret.txt"), SandboxError);
  assert.throws(() => resolveUnder(root, "link/new.txt"), SandboxError);
  assert.throws(() => resolveUnder(root, "link"), SandboxError);
});

test("accepts symlink inside root pointing inside", () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "real"));
  fs.writeFileSync(path.join(root, "real", "file.txt"), "ok");
  fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));

  assert.doesNotThrow(() => resolveUnder(root, "link/file.txt"));
});
