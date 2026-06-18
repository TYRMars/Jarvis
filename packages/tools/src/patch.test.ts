// Tests for fs.patch — ported from the `#[cfg(test)]` module in
// crates/harness-tools/src/patch.rs, plus a couple of TS-specific guards.
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FsPatchTool } from "./patch.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jarvis-fspatch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (rel: string): Promise<string> => readFile(join(dir, rel), "utf8");

async function expectError(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected the call to reject, but it resolved");
}

test("modifies existing file", async () => {
  await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
  const tool = new FsPatchTool({ root: dir });

  const diff = `--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;
  const out = await tool.invoke({ diff });
  assert.ok(out.includes("M a.txt"), `got: ${out}`);
  assert.equal(await read("a.txt"), "one\nTWO\nthree\n");
});

test("creates new file", async () => {
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
  const out = await tool.invoke({ diff });
  assert.ok(out.includes("A new.txt"), `got: ${out}`);
  assert.equal(await read("new.txt"), "hello\nworld\n");
});

test("deletes file", async () => {
  await writeFile(join(dir, "gone.txt"), "bye\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
  const out = await tool.invoke({ diff });
  assert.ok(out.includes("D gone.txt"), `got: ${out}`);
  assert.ok(!existsSync(join(dir, "gone.txt")));
});

test("multi-file diff with git headers", async () => {
  await writeFile(join(dir, "a.txt"), "alpha\n");
  await writeFile(join(dir, "b.txt"), "beta\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-beta
+BETA
`;
  const out = await tool.invoke({ diff });
  assert.ok(out.includes("M a.txt"), `got: ${out}`);
  assert.ok(out.includes("M b.txt"), `got: ${out}`);
  assert.equal(await read("a.txt"), "ALPHA\n");
  assert.equal(await read("b.txt"), "BETA\n");
});

test("rejects path escape", async () => {
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- a/../etc/passwd
+++ b/../etc/passwd
@@ -1 +1 @@
-x
+y
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes(".."), `got: ${err.message}`);
});

test("rejects binary patch", async () => {
  const tool = new FsPatchTool({ root: dir });
  const diff = `diff --git a/img.bin b/img.bin
GIT binary patch
delta 1
abcd
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("binary"), `got: ${err.message}`);
});

test("rejects rename patch", async () => {
  await writeFile(join(dir, "old.txt"), "x\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `diff --git a/old.txt b/new.txt
rename from old.txt
rename to new.txt
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("rename"), `got: ${err.message}`);
});

test("stale hunk rolls back all files", async () => {
  await writeFile(join(dir, "a.txt"), "alpha\n");
  await writeFile(join(dir, "b.txt"), "beta\n");
  const tool = new FsPatchTool({ root: dir });
  // First hunk applies, second hunk's context doesn't match.
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-NOT_BETA
+gamma
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("apply patch"), `got: ${err.message}`);
  // a.txt must NOT have been modified — phase-1 atomicity: nothing reaches
  // disk until every block applies.
  assert.equal(await read("a.txt"), "alpha\n", "atomicity violated");
});

test("phase-two io failure rolls back committed writes", async () => {
  // Phase 1 (parse/apply) succeeds for both files; the disk-commit phase
  // writes `a.txt` successfully, then fails creating `blocker/x.txt` because
  // `blocker` is an existing regular file (so mkdir errors). The earlier write
  // to `a.txt` must be rolled back to honour the "atomic per call" contract.
  await writeFile(join(dir, "a.txt"), "alpha\n");
  await writeFile(join(dir, "blocker"), "i am a file\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/blocker/x.txt b/blocker/x.txt
--- /dev/null
+++ b/blocker/x.txt
@@ -0,0 +1 @@
+nope
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("rolled back"), `got: ${err.message}`);
  // a.txt must be restored to its pre-call content.
  assert.equal(await read("a.txt"), "alpha\n", "phase-2 atomicity violated");
  // The blocker file is untouched and the nested write didn't land.
  assert.ok((await stat(join(dir, "blocker"))).isFile());
  assert.ok(!existsSync(join(dir, "blocker", "x.txt")));
});

test("rejects create over existing file", async () => {
  await writeFile(join(dir, "a.txt"), "exists\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+new
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("existing"), `got: ${err.message}`);
});

test("rejects modify of missing file", async () => {
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- a/nope.txt
+++ b/nope.txt
@@ -1 +1 @@
-x
+y
`;
  const err = await expectError(tool.invoke({ diff }));
  assert.ok(err.message.includes("missing file"), `got: ${err.message}`);
});

test("no patch blocks found", async () => {
  const tool = new FsPatchTool({ root: dir });
  const err = await expectError(tool.invoke({ diff: "just some prose, no headers\n" }));
  assert.ok(err.message.includes("no patch blocks"), `got: ${err.message}`);
});

test("missing diff argument", async () => {
  const tool = new FsPatchTool({ root: dir });
  const err = await expectError(tool.invoke({}));
  assert.ok(err.message.includes("missing `diff`"), `got: ${err.message}`);
});

test("requiresApproval is true and category is write", () => {
  const tool = new FsPatchTool({ root: "/tmp" });
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.category, "write");
  assert.equal(tool.name, "fs.patch");
});

test("summary reports added/removed counts", async () => {
  await writeFile(join(dir, "c.txt"), "one\ntwo\nthree\n");
  const tool = new FsPatchTool({ root: dir });
  const diff = `--- a/c.txt
+++ b/c.txt
@@ -1,3 +1,4 @@
 one
-two
+TWO
+TWO-AND-A-HALF
 three
`;
  const out = await tool.invoke({ diff });
  // 2 added (+TWO, +TWO-AND-A-HALF), 1 removed (-two).
  assert.ok(out.includes("(+2 -1)"), `got: ${out}`);
});
