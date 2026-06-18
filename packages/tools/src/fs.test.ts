import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Tool } from "@jarvis/core";
import { FsEditTool, FsListTool, FsReadTool, FsWriteTool } from "./fs.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fs-"));
}

test("read/write roundtrip", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const read = new FsReadTool({ root: dir });

  await write.invoke({ path: "sub/hello.txt", content: "world" });
  const got = await read.invoke({ path: "sub/hello.txt" });
  assert.equal(got, "world");
});

test("read truncates large files", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const read = new FsReadTool({ root: dir, maxBytes: 10 });

  const long = "a".repeat(100);
  await write.invoke({ path: "big.txt", content: long });
  const got = await read.invoke({ path: "big.txt" });
  assert.ok(got.startsWith("aaaaaaaaaa"), "should keep first 10 bytes");
  assert.ok(
    got.includes("[... truncated at 10 bytes ...]"),
    `should contain truncation marker, got: ${got}`,
  );
});

test("read truncates at char boundary", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const read = new FsReadTool({ root: dir, maxBytes: 5 });

  // "hello世界" — '世' starts at byte 5, so truncation must back up to byte 5.
  await write.invoke({ path: "utf8.txt", content: "hello世界" });
  const got = await read.invoke({ path: "utf8.txt" });
  assert.equal(got, "hello\n\n[... truncated at 5 bytes ...]");
});

test("write reports byte count and is approval-gated", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  assert.equal(write.requiresApproval, true);
  assert.equal(write.category, "write");
  const out = await write.invoke({ path: "a.txt", content: "héllo" });
  // 'é' is 2 bytes in UTF-8 → 6 bytes total.
  assert.ok(out.startsWith("wrote 6 bytes to "), `got: ${out}`);
});

test("list contains written file", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const list = new FsListTool({ root: dir });
  await write.invoke({ path: "a.txt", content: "x" });
  const out = await list.invoke({});
  assert.ok(out.includes("a.txt"), `list output was ${out}`);
  const parsed = JSON.parse(out) as Array<{ name: string; kind: string }>;
  const entry = parsed.find((e) => e.name === "a.txt");
  assert.deepEqual(entry, { name: "a.txt", kind: "file" });
});

test("list reports directories", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "sub"));
  const list = new FsListTool({ root: dir });
  const out = await list.invoke({ path: "." });
  const parsed = JSON.parse(out) as Array<{ name: string; kind: string }>;
  const entry = parsed.find((e) => e.name === "sub");
  assert.deepEqual(entry, { name: "sub", kind: "dir" });
});

test("read is category read, never approval-gated", () => {
  const read: Tool = new FsReadTool({ root: "/x" });
  const list: Tool = new FsListTool({ root: "/x" });
  assert.equal(read.category, "read");
  assert.equal(read.requiresApproval, undefined);
  assert.equal(list.category, "read");
  assert.equal(list.requiresApproval, undefined);
});

test("edit replaces unique match", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });
  const read = new FsReadTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "hello world" });
  await edit.invoke({ path: "f.txt", old_string: "world", new_string: "rust" });
  const got = await read.invoke({ path: "f.txt" });
  assert.equal(got, "hello rust");
});

test("edit rejects ambiguous match", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "ab ab ab" });
  await assert.rejects(
    () => edit.invoke({ path: "f.txt", old_string: "ab", new_string: "x" }),
    /matches 3/,
  );
});

test("edit replace_all", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });
  const read = new FsReadTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "ab ab ab" });
  await edit.invoke({
    path: "f.txt",
    old_string: "ab",
    new_string: "x",
    replace_all: true,
  });
  const got = await read.invoke({ path: "f.txt" });
  assert.equal(got, "x x x");
});

test("edit missing string errors", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "abc" });
  await assert.rejects(
    () => edit.invoke({ path: "f.txt", old_string: "xyz", new_string: "q" }),
    /not found/,
  );
});

test("edit rejects empty old", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "abc" });
  await assert.rejects(
    () => edit.invoke({ path: "f.txt", old_string: "", new_string: "q" }),
    /must not be empty/,
  );
});

test("edit rejects identical old/new", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "abc" });
  await assert.rejects(
    () => edit.invoke({ path: "f.txt", old_string: "abc", new_string: "abc" }),
    /identical/,
  );
});

test("edit handles $ in replacement literally", async () => {
  const dir = tmpdir();
  const write = new FsWriteTool({ root: dir });
  const edit = new FsEditTool({ root: dir });
  const read = new FsReadTool({ root: dir });

  await write.invoke({ path: "f.txt", content: "price = X" });
  await edit.invoke({ path: "f.txt", old_string: "X", new_string: "$1.00" });
  const got = await read.invoke({ path: "f.txt" });
  assert.equal(got, "price = $1.00");
});

test("edit is approval-gated, category write", () => {
  const edit = new FsEditTool({ root: "/x" });
  assert.equal(edit.requiresApproval, true);
  assert.equal(edit.category, "write");
});

test("paths escaping the root are rejected", async () => {
  const dir = tmpdir();
  const read = new FsReadTool({ root: dir });
  await assert.rejects(() => read.invoke({ path: "../escape.txt" }));
  await assert.rejects(() => read.invoke({ path: "/etc/passwd" }));
});

test("missing required args error", async () => {
  const dir = tmpdir();
  const read = new FsReadTool({ root: dir });
  const write = new FsWriteTool({ root: dir });
  await assert.rejects(() => read.invoke({}), /missing `path`/);
  await assert.rejects(() => write.invoke({ path: "a.txt" }), /missing `content`/);
});
