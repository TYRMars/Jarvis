// Tests for code.grep — ported from the Rust test suite in
// crates/harness-tools/src/grep.rs plus a few TS-specific cases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { Tool } from "@jarvis/core";

import { CodeGrepTool } from "./grep.ts";

const dirs: string[] = [];

after(async () => {
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true });
  }
});

async function tempdir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "grep-test-"));
  dirs.push(d);
  return d;
}

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test("finds matches across files", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "a.rs"), "fn alpha() {}\nfn beta() {}\n");
  await write(path.join(dir, "sub/b.rs"), "fn gamma() {}\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "^fn \\w+" });
  assert.ok(out.includes("a.rs:1:"), `got: ${out}`);
  assert.ok(out.includes("a.rs:2:"), `got: ${out}`);
  assert.ok(out.includes("b.rs:1:"), `got: ${out}`);
});

test("glob filters files", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "a.rs"), "needle\n");
  await write(path.join(dir, "b.txt"), "needle\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "needle", glob: "*.rs" });
  assert.ok(out.includes("a.rs"), `got: ${out}`);
  assert.ok(!out.includes("b.txt"), `got: ${out}`);
});

test("glob with subdir pattern", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "src/a.ts"), "needle\n");
  await write(path.join(dir, "src/deep/b.ts"), "needle\n");
  await write(path.join(dir, "other/c.ts"), "needle\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "needle", glob: "src/**/*.ts" });
  assert.ok(out.includes("src/a.ts"), `got: ${out}`);
  assert.ok(out.includes("src/deep/b.ts"), `got: ${out}`);
  assert.ok(!out.includes("other/c.ts"), `got: ${out}`);
});

test("case insensitive", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "a.txt"), "Hello World\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "hello", case_insensitive: true });
  assert.ok(out.includes("Hello World"), `got: ${out}`);
});

test("case sensitive by default", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "a.txt"), "Hello World\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "hello" });
  assert.equal(out, "(no matches)", `got: ${out}`);
});

test("no matches message", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "a.txt"), "abc\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "xyz" });
  assert.ok(out.includes("no matches"), `got: ${out}`);
});

test("invalid regex errors", async () => {
  const dir = await tempdir();
  const tool = new CodeGrepTool({ root: dir });
  await assert.rejects(
    () => tool.invoke({ pattern: "(" }),
    (e: unknown) => e instanceof Error && e.message.includes("invalid regex"),
  );
});

test("missing pattern errors", async () => {
  const dir = await tempdir();
  const tool = new CodeGrepTool({ root: dir });
  await assert.rejects(
    () => tool.invoke({}),
    (e: unknown) => e instanceof Error && e.message.includes("pattern"),
  );
});

test("rejects path escape", async () => {
  const dir = await tempdir();
  const tool = new CodeGrepTool({ root: dir });
  await assert.rejects(
    () => tool.invoke({ pattern: "x", path: "../etc" }),
    (e: unknown) => e instanceof Error && e.message.includes(".."),
  );
});

test("rejects absolute path", async () => {
  const dir = await tempdir();
  const tool = new CodeGrepTool({ root: dir });
  await assert.rejects(
    () => tool.invoke({ pattern: "x", path: "/etc" }),
    (e: unknown) => e instanceof Error,
  );
});

test("scopes search to path subdir", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "top.txt"), "needle\n");
  await write(path.join(dir, "sub/inner.txt"), "needle\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "needle", path: "sub" });
  assert.ok(out.includes("sub/inner.txt"), `got: ${out}`);
  assert.ok(!out.includes("top.txt"), `got: ${out}`);
});

test("caps results", async () => {
  const dir = await tempdir();
  let content = "";
  for (let i = 0; i < 50; i++) content += "match\n";
  await write(path.join(dir, "a.txt"), content);
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "match", max_results: 5 });
  assert.ok(out.includes("truncated"), `got: ${out}`);
  const occurrences = out.split("a.txt:").length - 1;
  assert.equal(occurrences, 5, `got: ${out}`);
});

test("clamps out-of-range max_results to the configured default", async () => {
  const dir = await tempdir();
  let content = "";
  for (let i = 0; i < 50; i++) content += "match\n";
  await write(path.join(dir, "a.txt"), content);
  // Default cap of 3 lets us observe the fallback for invalid bounds.
  const tool = new CodeGrepTool({ root: dir, maxResults: 3 });

  // `0` (schema minimum is 1) must fall back to the default, not cap at 1.
  const zero = await tool.invoke({ pattern: "match", max_results: 0 });
  assert.equal(zero.split("a.txt:").length - 1, 3, `got: ${zero}`);

  // A negative value must also fall back, not disable the count cap entirely.
  const negative = await tool.invoke({ pattern: "match", max_results: -5 });
  assert.equal(negative.split("a.txt:").length - 1, 3, `got: ${negative}`);
});

test("respects byte budget", async () => {
  const dir = await tempdir();
  // Each line is well over the byte budget collectively; many short matches.
  let content = "";
  for (let i = 0; i < 2000; i++) content += "match this line\n";
  await write(path.join(dir, "a.txt"), content);
  // Tiny budget forces a byte-based truncation before max_results.
  const tool = new CodeGrepTool({ root: dir, maxBytes: 200 });

  const out = await tool.invoke({ pattern: "match" });
  assert.ok(out.includes("truncated"), `got: ${out}`);
  assert.ok(Buffer.byteLength(out, "utf8") <= 200 + 80, `byte budget overrun: ${out.length}`);
});

test("respects root .gitignore", async () => {
  const dir = await tempdir();
  await write(path.join(dir, ".gitignore"), "ignored.txt\nbuild/\n");
  await write(path.join(dir, "kept.txt"), "needle\n");
  await write(path.join(dir, "ignored.txt"), "needle\n");
  await write(path.join(dir, "build/artifact.txt"), "needle\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "needle" });
  assert.ok(out.includes("kept.txt"), `got: ${out}`);
  assert.ok(!out.includes("ignored.txt"), `got: ${out}`);
  assert.ok(!out.includes("artifact.txt"), `got: ${out}`);
});

test("skips .git directory and dotfiles", async () => {
  const dir = await tempdir();
  await write(path.join(dir, ".git/config"), "needle\n");
  await write(path.join(dir, ".hidden.txt"), "needle\n");
  await write(path.join(dir, "visible.txt"), "needle\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "needle" });
  assert.ok(out.includes("visible.txt"), `got: ${out}`);
  assert.ok(!out.includes(".git"), `got: ${out}`);
  assert.ok(!out.includes(".hidden.txt"), `got: ${out}`);
});

test("skips binary files", async () => {
  const dir = await tempdir();
  await write(path.join(dir, "text.txt"), "needle\n");
  await writeFile(
    path.join(dir, "binary.bin"),
    Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c, 0x65]),
  );
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "need" });
  assert.ok(out.includes("text.txt"), `got: ${out}`);
  assert.ok(!out.includes("binary.bin"), `got: ${out}`);
});

test("truncates long lines", async () => {
  const dir = await tempdir();
  const longLine = "x".repeat(300) + "needle";
  await write(path.join(dir, "a.txt"), longLine + "\n");
  const tool = new CodeGrepTool({ root: dir });

  const out = await tool.invoke({ pattern: "x" });
  assert.ok(out.includes(" …"), `expected ellipsis, got: ${out}`);
  // The reported snippet should not contain the full 300-char run + needle.
  assert.ok(!out.includes("needle"), `should have been truncated: ${out}`);
});

test("metadata: name, category, cacheable, schema", () => {
  const tool: Tool = new CodeGrepTool({ root: "/tmp" });
  assert.equal(tool.name, "code.grep");
  assert.equal(tool.category, "read");
  assert.equal(tool.cacheable, true);
  assert.equal(tool.requiresApproval ?? false, false);
  const params = tool.parameters as { type: string; required: string[] };
  assert.equal(params.type, "object");
  assert.deepEqual(params.required, ["pattern"]);
});
