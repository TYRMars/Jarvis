import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { Tool } from "@jarvis/core";

import { SHELL_DEFAULT_MAX_BYTES, SHELL_DEFAULT_TIMEOUT_MS, ShellExecTool } from "./shell.ts";

const isWindows = process.platform === "win32";
// The Rust tests are gated `#[cfg(not(windows))]` — they assume a POSIX `sh`.
const posix = { skip: isWindows ? "POSIX-only (sh) shell tests" : false };

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "jarvis-shell-"));
}

test("metadata: opt-in + exec + approval-gated", () => {
  const tool: Tool = new ShellExecTool({ root: "/tmp" });
  assert.equal(tool.name, "shell.exec");
  assert.equal(tool.requiresApproval, true);
  assert.equal(tool.category, "exec");
  assert.equal(tool.cacheable, true);
});

test("parameters declare command/cwd/timeout_ms with required command", () => {
  const tool = new ShellExecTool({ root: "/tmp" });
  const params = tool.parameters as Record<string, unknown>;
  assert.equal(params["type"], "object");
  const props = params["properties"] as Record<string, unknown>;
  assert.ok(props["command"]);
  assert.ok(props["cwd"]);
  assert.ok(props["timeout_ms"]);
  assert.deepEqual(params["required"], ["command"]);
});

test("default constants match the Rust source", () => {
  assert.equal(SHELL_DEFAULT_MAX_BYTES, 64 * 1024);
  assert.equal(SHELL_DEFAULT_TIMEOUT_MS, 30_000);
});

test("runs a simple command", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  const out = await tool.invoke({ command: "echo hello" });
  assert.ok(out.includes("exit=0"), `got: ${out}`);
  assert.ok(out.includes("hello"), `got: ${out}`);
});

test("captures a nonzero exit code", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  const out = await tool.invoke({ command: "exit 7" });
  assert.ok(out.includes("exit=7"), `got: ${out}`);
});

test("captures stderr separately from stdout", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  const out = await tool.invoke({ command: "echo oops 1>&2; exit 1" });
  assert.ok(out.includes("--- stderr"), `got: ${out}`);
  assert.ok(out.includes("oops"), `got: ${out}`);
  assert.ok(out.includes("exit=1"), `got: ${out}`);
});

test("stdout and stderr land in their own sections", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  const out = await tool.invoke({ command: "echo OUT; echo ERR 1>&2" });
  const outIdx = out.indexOf("--- stdout");
  const errIdx = out.indexOf("--- stderr");
  // The stdout-section line comes before the stderr-section line, and each
  // payload sits in its own section.
  assert.ok(outIdx >= 0 && errIdx > outIdx, `got: ${out}`);
  assert.ok(out.slice(outIdx, errIdx).includes("OUT"), `OUT in stdout section: ${out}`);
  assert.ok(out.slice(errIdx).includes("ERR"), `ERR in stderr section: ${out}`);
});

test("rejects a cwd that escapes the root", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  await assert.rejects(
    () => tool.invoke({ command: "true", cwd: "../etc" }),
    /\.\./,
  );
});

test("rejects an absolute cwd", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  await assert.rejects(() => tool.invoke({ command: "true", cwd: "/etc" }));
});

test("runs in a resolved sub-cwd under the root", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  // mkdir a subdir then pwd inside it — output should contain the subdir name.
  await tool.invoke({ command: "mkdir -p sub" });
  const out = await tool.invoke({ command: "pwd", cwd: "sub" });
  assert.ok(out.includes("exit=0"), `got: ${out}`);
  assert.ok(out.includes("sub"), `expected pwd to mention sub: ${out}`);
});

test("enforces the timeout and throws", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root });
  await assert.rejects(
    () => tool.invoke({ command: "sleep 5", timeout_ms: 100 }),
    /timed out/,
  );
});

test("truncates large stdout at the byte cap", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root, maxBytes: 16 });
  const out = await tool.invoke({ command: "printf 'abcdefghijklmnopqrstuvwxyz'" });
  assert.ok(out.includes("stdout truncated at 16"), `got: ${out}`);
});

test("reports the full observed byte count even after truncation", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root, maxBytes: 8 });
  // 26 chars, no trailing newline → total counts 26 + 1 (the stripped newline
  // the line reader accounts for), per the Rust `stream_pipe`.
  const out = await tool.invoke({ command: "printf 'abcdefghijklmnopqrstuvwxyz'" });
  assert.ok(out.includes("--- stdout (27 bytes) ---"), `got: ${out}`);
  assert.ok(out.includes("stdout truncated at 8"), `got: ${out}`);
});

test("sizes and reports multibyte output in UTF-8 bytes, not chars", posix, async () => {
  const root = await tempRoot();
  const tool = new ShellExecTool({ root, maxBytes: 1024 });
  // "你好" = 2 chars / 6 UTF-8 bytes; +1 for the line reader's stripped newline.
  const out = await tool.invoke({ command: "printf '你好'" });
  assert.ok(out.includes("--- stdout (7 bytes) ---"), `got: ${out}`);
});

test("truncates multibyte output at the real byte cap", posix, async () => {
  const root = await tempRoot();
  // 8 chars × 3 bytes = 24 bytes; a 10-byte cap must truncate even though the
  // char count (8) is well under it.
  const tool = new ShellExecTool({ root, maxBytes: 10 });
  const out = await tool.invoke({ command: "printf '一二三四五六七八'" });
  assert.ok(out.includes("stdout truncated at 10"), `got: ${out}`);
  assert.ok(out.includes("--- stdout (25 bytes) ---"), `got: ${out}`);
});

test("missing command argument throws", async () => {
  const tool = new ShellExecTool({ root: "/tmp" });
  await assert.rejects(() => tool.invoke({}), /missing `command`/);
});
