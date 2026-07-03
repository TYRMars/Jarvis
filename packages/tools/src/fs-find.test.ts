import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Tool } from "@jarvis/core";
import { FsFindTool } from "./fs-find.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-find-"));
}

function write(p: string, contents: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

test("finds files across subdirs", async () => {
  const dir = tmpdir();
  write(path.join(dir, "a.rs"), "fn alpha() {}\n");
  write(path.join(dir, "sub/b.rs"), "fn beta() {}\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("a.rs"), `got: ${out}`);
  assert.ok(out.includes("b.rs"), `got: ${out}`);
});

test("glob excludes other extensions", async () => {
  const dir = tmpdir();
  write(path.join(dir, "a.rs"), "fn alpha() {}\n");
  write(path.join(dir, "b.txt"), "plain text\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("a.rs"), `got: ${out}`);
  assert.ok(!out.includes("b.txt"), `got: ${out}`);
});

test("no matches message", async () => {
  const dir = tmpdir();
  write(path.join(dir, "a.txt"), "plain text\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("no matches"), `got: ${out}`);
});

test("respects .gitignore", async () => {
  const dir = tmpdir();
  write(path.join(dir, "keep.rs"), "x\n");
  write(path.join(dir, "target/skip.rs"), "x\n");
  write(path.join(dir, ".gitignore"), "target/\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("keep.rs"), `got: ${out}`);
  assert.ok(!out.includes("skip.rs"), `got: ${out}`);
});

test("nested bare-name .gitignore pattern does not leak onto sibling subtrees", async () => {
  // Regression for #300: a bare-name pattern in a nested .gitignore must apply
  // only within its declaring directory's subtree, not globally. Here `build`
  // in a/.gitignore must hide a/build/** but leave the unrelated b/build/**.
  const dir = tmpdir();
  write(path.join(dir, "a/.gitignore"), "build\n");
  write(path.join(dir, "a/build/gen.rs"), "x\n"); // ignored by a/.gitignore
  write(path.join(dir, "a/nested/build/deep.rs"), "x\n"); // ignored at any depth under a/
  write(path.join(dir, "a/src.rs"), "x\n"); // kept
  write(path.join(dir, "b/build/real.rs"), "x\n"); // MUST be kept (no rule here)
  write(path.join(dir, "c/build/also.rs"), "x\n"); // MUST be kept
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("src.rs"), `got: ${out}`);
  assert.ok(out.includes(path.join("b", "build", "real.rs")), `sibling wrongly filtered: ${out}`);
  assert.ok(out.includes(path.join("c", "build", "also.rs")), `cousin wrongly filtered: ${out}`);
  assert.ok(!out.includes("gen.rs"), `a/build not ignored: ${out}`);
  assert.ok(!out.includes("deep.rs"), `a/**/build not ignored: ${out}`);
});

test("skips hidden files and .git", async () => {
  const dir = tmpdir();
  write(path.join(dir, "visible.rs"), "x\n");
  write(path.join(dir, ".hidden.rs"), "x\n");
  write(path.join(dir, ".git/config.rs"), "x\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("visible.rs"), `got: ${out}`);
  assert.ok(!out.includes(".hidden.rs"), `got: ${out}`);
  assert.ok(!out.includes("config.rs"), `got: ${out}`);
});

test("path narrows the search subtree", async () => {
  const dir = tmpdir();
  write(path.join(dir, "a.rs"), "x\n");
  write(path.join(dir, "sub/b.rs"), "x\n");
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs", path: "sub" });
  assert.ok(out.includes("b.rs"), `got: ${out}`);
  // Paths are emitted relative to the display root, so the narrowed result
  // should not list the top-level a.rs.
  assert.ok(!/(^|\n)a\.rs(\n|$)/.test(out), `got: ${out}`);
});

test("max_results truncates with marker", async () => {
  const dir = tmpdir();
  for (let i = 0; i < 5; i++) {
    write(path.join(dir, `f${i}.rs`), "x\n");
  }
  const tool = new FsFindTool({ root: dir });

  const out = await tool.invoke({ glob: "**/*.rs", max_results: 2 });
  assert.ok(out.includes("[... truncated at 2 results ...]"), `got: ${out}`);
  const fileLines = out
    .split("\n")
    .filter((l) => l.endsWith(".rs"));
  assert.equal(fileLines.length, 2, `got: ${out}`);
});

test("constructor maxResults default cap applies", async () => {
  const dir = tmpdir();
  for (let i = 0; i < 4; i++) {
    write(path.join(dir, `f${i}.rs`), "x\n");
  }
  const tool = new FsFindTool({ root: dir, maxResults: 1 });

  const out = await tool.invoke({ glob: "**/*.rs" });
  assert.ok(out.includes("[... truncated at 1 results ...]"), `got: ${out}`);
});

test("missing glob errors", async () => {
  const dir = tmpdir();
  const tool = new FsFindTool({ root: dir });
  await assert.rejects(() => tool.invoke({}), /missing `glob`/);
});

test("is category read, not approval-gated", () => {
  const tool: Tool = new FsFindTool({ root: "/x" });
  assert.equal(tool.category, "read");
  assert.equal(tool.requiresApproval, undefined);
});
