// ClaudeCodeSubAgent tests. Ported from
// harness-subagents/src/claude_code.rs::tests — the stream-json parsing,
// stringify, probe, config defaults, plus an end-to-end spawn against a fake
// `claude` script so the SDKMessage -> SubAgentEvent relay is exercised
// without the real binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ClaudeCodeSubAgent,
  buildClaudeArgs,
  defaultClaudeCodeConfig,
  probe,
  parseSdkMessage,
  stringifyToolResult,
} from "./claude-code.ts";
import { withSubagent, type SubAgentFrame } from "./subagent.ts";

test("buildClaudeArgs puts the task after a `--` separator (no arg injection)", () => {
  const cfg = defaultClaudeCodeConfig();
  // A task that begins with `--` must NOT be parsed by claude's CLI as a flag.
  const malicious = "--add-dir / and do the thing";
  const args = buildClaudeArgs(cfg, malicious);
  const sep = args.indexOf("--");
  assert.ok(sep >= 0, "argv must contain a `--` end-of-options separator");
  // The task is the final positional, immediately after `--`.
  assert.equal(args[args.length - 1], malicious);
  assert.equal(args.indexOf("--"), args.length - 2);
  // Nothing the task contains can appear before the separator as a flag.
  assert.ok(!args.slice(0, sep).includes(malicious));
});

test("buildClaudeArgs keeps a single trailing `--` even with extra_args", () => {
  const cfg = { ...defaultClaudeCodeConfig(), model: "claude-x", extra_args: ["--foo", "bar"] };
  const args = buildClaudeArgs(cfg, "do work");
  assert.deepEqual(args.slice(-2), ["--", "do work"]);
  // extra_args land before the separator; exactly one `--` separator is added.
  assert.equal(args.filter((a) => a === "--").length, 1);
  assert.ok(args.includes("--foo") && args.includes("bar"));
  assert.deepEqual(args.slice(0, 2), ["--print", "--output-format"]);
});

test("parses an assistant text block", () => {
  const msg = parseSdkMessage('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}');
  assert.ok(msg && msg.type === "assistant");
  if (msg.type === "assistant") {
    const block = msg.message.content[0]!;
    assert.equal(block.type, "text");
    if (block.type === "text") assert.equal(block.text, "hello");
  }
});

test("parses an assistant tool_use block", () => {
  const msg = parseSdkMessage(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"u1","name":"Read","input":{"path":"a.rs"}}]}}',
  );
  assert.ok(msg && msg.type === "assistant");
  if (msg.type === "assistant") {
    const block = msg.message.content[0]!;
    assert.equal(block.type, "tool_use");
    if (block.type === "tool_use") {
      assert.equal(block.id, "u1");
      assert.equal(block.name, "Read");
      assert.deepEqual(block.input, { path: "a.rs" });
    }
  }
});

test("parses a user tool_result with string content", () => {
  const msg = parseSdkMessage(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":"file body"}]}}',
  );
  assert.ok(msg && msg.type === "user");
  if (msg.type === "user") {
    const block = msg.message.content[0]!;
    assert.equal(block.type, "tool_result");
    if (block.type === "tool_result") {
      assert.equal(block.tool_use_id, "u1");
      assert.equal(stringifyToolResult(block.content), "file body");
    }
  }
});

test("parses a user tool_result with array content (flattened)", () => {
  const msg = parseSdkMessage(
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":[{"type":"text","text":"line a"},{"type":"text","text":"line b"}]}]}}',
  );
  assert.ok(msg && msg.type === "user");
  if (msg.type === "user") {
    const block = msg.message.content[0]!;
    if (block.type === "tool_result") {
      assert.equal(stringifyToolResult(block.content), "line a\nline b");
    }
  }
});

test("parses result success + error", () => {
  const ok = parseSdkMessage('{"type":"result","subtype":"success","result":"all done","is_error":false}');
  assert.ok(ok && ok.type === "result");
  if (ok.type === "result") {
    assert.equal(ok.subtype, "success");
    assert.equal(ok.result, "all done");
    assert.equal(ok.is_error, false);
  }
  const bad = parseSdkMessage('{"type":"result","subtype":"error_max_turns","is_error":true}');
  assert.ok(bad && bad.type === "result");
  if (bad.type === "result") {
    assert.equal(bad.subtype, "error_max_turns");
    assert.equal(bad.is_error, true);
  }
});

test("unknown message kind + blank/garbage lines do not throw", () => {
  const unknown = parseSdkMessage('{"type":"future_kind_we_havent_seen","stuff":1}');
  assert.ok(unknown && unknown.type === "__unknown__");
  assert.equal(parseSdkMessage(""), undefined);
  assert.equal(parseSdkMessage("   "), undefined);
  assert.equal(parseSdkMessage("not json"), undefined);
});

test("stringifyToolResult handles null + non-string scalars", () => {
  assert.equal(stringifyToolResult(null), "");
  assert.equal(stringifyToolResult(true), "true");
});

test("default config + extra_args round-trip", () => {
  const cfg = defaultClaudeCodeConfig();
  assert.equal(cfg.claude_bin, "claude");
  assert.equal(cfg.model, undefined);
  assert.equal(cfg.extra_args, undefined);
  const withExtra = { claude_bin: "claude", model: "claude-sonnet-4-5", extra_args: ["--bare", "--foo=bar"] };
  const back = JSON.parse(JSON.stringify(withExtra)) as typeof withExtra;
  assert.deepEqual(back.extra_args, ["--bare", "--foo=bar"]);
});

test("probe rejects when the binary is missing", async () => {
  await assert.rejects(() => probe("/no/such/binary-jarvis-test"), /spawn/);
});

test("end-to-end: a fake `claude` stream-json run relays frames + final message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-claude-"));
  const fakeJs = path.join(dir, "fake-claude.mjs");
  // A fake CLI that ignores its args, emits a stream-json transcript, exits 0.
  await writeFile(
    fakeJs,
    `const lines = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reading" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Read", input: { path: "a.ts" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "body" }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "done editing", is_error: false }),
];
for (const l of lines) process.stdout.write(l + "\\n");
process.exit(0);
`,
    "utf8",
  );
  // A shell wrapper so the spawned `claude_bin` ignores the flags Jarvis
  // appends (which node itself would otherwise try to interpret).
  const fake = path.join(dir, "fake-claude.sh");
  await writeFile(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeJs)}\n`, "utf8");
  await chmod(fake, 0o755);

  const sub = new ClaudeCodeSubAgent({ claude_bin: fake });
  const frames: SubAgentFrame[] = [];
  const out = await withSubagent(
    (f) => frames.push(f),
    () => sub.invoke({ task: "edit a.ts", workspace_root: dir }),
  );
  assert.equal(out.message, "done editing");
  const kinds = frames.map((f) => f.event.kind);
  assert.ok(kinds.includes("started"));
  assert.ok(kinds.includes("status")); // system:init
  assert.ok(kinds.includes("delta")); // "reading"
  assert.ok(kinds.includes("tool_start"));
  assert.ok(kinds.includes("tool_end"));
  assert.ok(kinds.includes("done"));
  // tool_end pairs the name back from tool_use_id.
  const toolEnd = frames.find((f) => f.event.kind === "tool_end");
  assert.ok(toolEnd && toolEnd.event.kind === "tool_end");
  if (toolEnd && toolEnd.event.kind === "tool_end") {
    assert.equal(toolEnd.event.name, "Read");
    assert.equal(toolEnd.event.output, "body");
  }
});

test("requiresApproval is true (workspace-mutating)", () => {
  const sub = new ClaudeCodeSubAgent(defaultClaudeCodeConfig());
  assert.ok(sub.requiresApproval());
  assert.equal(sub.name, "claude_code");
});
