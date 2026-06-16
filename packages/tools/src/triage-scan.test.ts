import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { JsonValue, Tool } from "@jarvis/core";
import { TriageScanTool } from "./triage-scan.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "triage-scan-"));
}

async function write(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function parse(out: string): Record<string, JsonValue> {
  return JSON.parse(out) as Record<string, JsonValue>;
}

test("surfaces TODO and FIXME with titles and paths", async () => {
  const dir = await tempDir();
  await write(
    path.join(dir, "a.rs"),
    "fn main() {\n    // TODO: hook up the spec parser\n    let _ = 1;\n    // FIXME — leak under heavy load\n}\n",
  );
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({}));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 2);
  assert.equal(cs[0]!.source, "todo_comment");
  assert.ok((cs[0]!.title as string).startsWith("TODO: "));
  assert.ok((cs[1]!.title as string).startsWith("FIXME: "));
  assert.equal(cs[0]!.path, "a.rs");
  assert.equal(cs[0]!.line, 2);
});

test("ignores empty markers", async () => {
  // Plain `// TODO` with no body shouldn't surface — we only emit candidates
  // that actually carry an actionable hint.
  const dir = await tempDir();
  await write(path.join(dir, "a.rs"), "// TODO\n// TODO:    \n// TODO: real one\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({}));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 1);
  assert.ok((cs[0]!.title as string).includes("real one"));
});

test("respects gitignore", async () => {
  // The ignore traversal respects .gitignore by default. Files under an
  // ignored directory must not surface candidates.
  const dir = await tempDir();
  await write(path.join(dir, ".gitignore"), "ignored/\n");
  await write(path.join(dir, "ignored/skipped.rs"), "// TODO: should not appear\n");
  await write(path.join(dir, "kept.rs"), "// TODO: should appear\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({}));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.path, "kept.rs");
});

test("limit caps results", async () => {
  const dir = await tempDir();
  let body = "";
  for (let i = 0; i < 10; i++) body += `// TODO: item ${i}\n`;
  await write(path.join(dir, "a.rs"), body);
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({ limit: 3 }));
  assert.equal((v.candidates as JsonValue[]).length, 3);
  assert.equal(v.count, 3);
});

test("unknown source is silently ignored", async () => {
  // Forward-compat: a caller listing only an unknown source gets zero
  // candidates back, not an error.
  const dir = await tempDir();
  await write(path.join(dir, "a.rs"), "// TODO: ignored?\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({ sources: ["future_source_v3"] }));
  assert.equal((v.candidates as JsonValue[]).length, 0);
});

test("rejects path escape", async () => {
  const dir = await tempDir();
  const tool = new TriageScanTool({ root: dir });
  await assert.rejects(
    () => tool.invoke({ path: "../escape" }),
    (err: unknown) => {
      const msg = String((err as Error).message).toLowerCase();
      return msg.includes("path") || msg.includes("..");
    },
  );
});

test("does not require approval", () => {
  const tool: Tool = new TriageScanTool({ root: "." });
  assert.equal(tool.requiresApproval ?? false, false);
  assert.equal(tool.category, "read");
});

test("hidden files and dot-directories are skipped", async () => {
  // The standard ignore filters skip dotfiles and the .git dir, so markers
  // inside them never surface.
  const dir = await tempDir();
  await write(path.join(dir, ".hidden.rs"), "// TODO: in a dotfile\n");
  await write(path.join(dir, ".git/config"), "// TODO: in .git\n");
  await write(path.join(dir, "visible.rs"), "// TODO: visible\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({}));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.path, "visible.rs");
});

test("path narrows scope to a subdirectory", async () => {
  const dir = await tempDir();
  await write(path.join(dir, "top.rs"), "// TODO: top level\n");
  await write(path.join(dir, "sub/inner.rs"), "// TODO: inner\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({ path: "sub" }));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 1);
  // Paths are reported relative to the workspace root, not the scope root.
  assert.equal(cs[0]!.path, "sub/inner.rs");
  assert.equal(cs[0]!.line, 1);
});

test("description carries source path, line, and code fence", async () => {
  const dir = await tempDir();
  await write(path.join(dir, "a.rs"), "x\n// XXX: needs review\n");
  const tool = new TriageScanTool({ root: dir });
  const v = parse(await tool.invoke({}));
  const cs = v.candidates as Array<Record<string, JsonValue>>;
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.title, "XXX: needs review");
  assert.equal(cs[0]!.line, 2);
  assert.equal(cs[0]!.description, "Source: `a.rs:2`\n\n```\nneeds review\n```");
});
