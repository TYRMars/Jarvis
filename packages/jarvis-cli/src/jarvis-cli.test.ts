import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ApprovalRequest,
  ChatRequest,
  ChatResponse,
  JsonValue,
  LlmChunk,
  LlmProvider,
  Message,
} from "@jarvis/core";
import { newConversation } from "@jarvis/core";

import { loadCliConfig } from "./config.ts";
import { buildAgent, loadProjectContext } from "./agent.ts";
import { runPipe, parseArgs } from "./main.ts";
import {
  PolicyTable,
  ReadlineApprover,
  decisionForReply,
  parseSlashCommand,
  runRepl,
  runTurn,
  shortArgs,
  type ReplDeps,
} from "./repl.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixture env with the minimal keys loadCliConfig needs (openai default). */
function fixtureEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { OPENAI_API_KEY: "test-key", JARVIS_NO_PROJECT_CONTEXT: "1", ...extra };
}

/**
 * A stub LlmProvider that replays a scripted sequence of ChatResponses, one per
 * `complete` call. `completeStream` re-uses `complete` and emits a single
 * `finish` chunk (the default-stream contract), so it drives both Agent.run and
 * Agent.runStream deterministically with no network.
 */
class ScriptedProvider implements LlmProvider {
  #queue: ChatResponse[];
  readonly seen: ChatRequest[] = [];

  constructor(responses: ChatResponse[]) {
    this.#queue = [...responses];
  }

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(req);
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("ScriptedProvider: ran out of scripted responses");
    return Promise.resolve(next);
  }

  async *completeStream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    const resp = await this.complete(req);
    yield { type: "finish", message: resp.message, finish_reason: resp.finish_reason };
  }
}

function assistantStop(content: string): ChatResponse {
  const message: Message = { role: "assistant", content };
  return { message, finish_reason: "stop" };
}

// ---------------------------------------------------------------------------
// Pipe-mode single-turn path
// ---------------------------------------------------------------------------

test("pipe mode: single turn returns the final assistant text", async () => {
  const provider = new ScriptedProvider([assistantStop("hello from the stub model")]);
  const text = await runPipe({
    parsed: parseArgs(["--no-interactive", "--prompt", "say hi"]),
    env: fixtureEnv(),
    provider,
  });
  assert.equal(text, "hello from the stub model");
  // The user prompt reached the provider.
  const lastReq = provider.seen.at(-1);
  assert.ok(lastReq);
  assert.ok(lastReq.messages.some((m) => m.role === "user" && m.content === "say hi"));
});

test("pipe mode: reads the prompt from injected stdin reader when --prompt absent", async () => {
  const provider = new ScriptedProvider([assistantStop("piped answer")]);
  const text = await runPipe({
    parsed: parseArgs(["--no-interactive"]),
    env: fixtureEnv(),
    provider,
    readPrompt: () => Promise.resolve("  summarise the repo\n"),
  });
  assert.equal(text, "piped answer");
});

test("pipe mode: empty prompt is rejected", async () => {
  const provider = new ScriptedProvider([assistantStop("unreached")]);
  await assert.rejects(
    runPipe({
      parsed: parseArgs(["--no-interactive"]),
      env: fixtureEnv(),
      provider,
      readPrompt: () => Promise.resolve("   \n  "),
    }),
    /non-empty prompt/,
  );
});

test("pipe mode: a gated tool call is auto-denied under AlwaysDeny, then the model recovers", async () => {
  // Turn 1: the model asks to write a file (gated, requiresApproval). Pipe mode
  // runs under AlwaysDeny, so the tool is NOT invoked — "tool denied: ..." is
  // surfaced. Turn 2: the model reads that and answers in text.
  const provider = new ScriptedProvider([
    {
      message: {
        role: "assistant",
        tool_calls: [{ id: "call_1", name: "fs.write", arguments: { path: "x.txt", content: "hi" } }],
      },
      finish_reason: "tool_calls",
    },
    assistantStop("could not write, here is the plan instead"),
  ]);

  const text = await runPipe({
    parsed: parseArgs(["--no-interactive", "--prompt", "write x.txt", "--allow-fs-write"]),
    env: fixtureEnv(),
    provider,
  });

  assert.equal(text, "could not write, here is the plan instead");
  // The tool-result message fed back into the 2nd request carries the deny
  // sentinel (the file was never written because AlwaysDeny short-circuited it).
  const secondReq = provider.seen.at(-1);
  assert.ok(secondReq);
  const toolMsg = secondReq.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.content, /tool denied/);
});

// ---------------------------------------------------------------------------
// Readline Approver: y → approve, else → deny
// ---------------------------------------------------------------------------

function req(toolName: string): ApprovalRequest {
  return { tool_call_id: "c1", tool_name: toolName, arguments: {}, category: "write" };
}

test("ReadlineApprover: 'y' / 'yes' / empty map to approve", async () => {
  for (const reply of ["y", "yes", "Y", " y ", ""]) {
    const approver = new ReadlineApprover(() => Promise.resolve(reply));
    const decision = await approver.approve(req("fs.write"));
    assert.equal(decision.decision, "approve", `reply ${JSON.stringify(reply)} should approve`);
  }
});

test("ReadlineApprover: anything else maps to deny", async () => {
  for (const reply of ["n", "no", "nope", "x", "wat"]) {
    const approver = new ReadlineApprover(() => Promise.resolve(reply));
    const decision = await approver.approve(req("fs.write"));
    assert.equal(decision.decision, "deny", `reply ${JSON.stringify(reply)} should deny`);
  }
});

test("ReadlineApprover: 'a' approves and always-allows; subsequent calls skip the prompt", async () => {
  const policy = new PolicyTable();
  let prompts = 0;
  const approver = new ReadlineApprover(() => {
    prompts++;
    return Promise.resolve("a");
  }, policy);

  const first = await approver.approve(req("shell.exec"));
  assert.equal(first.decision, "approve");
  assert.equal(policy.lookup("shell.exec"), "always-allow");

  // Second call to the same tool is auto-resolved by policy — no new prompt.
  const second = await approver.approve(req("shell.exec"));
  assert.equal(second.decision, "approve");
  assert.equal(prompts, 1, "the second approval should be auto-resolved without prompting");
});

test("ReadlineApprover: 'd' denies and always-denies the tool for the session", async () => {
  const policy = new PolicyTable();
  const approver = new ReadlineApprover(() => Promise.resolve("d"), policy);
  const decision = await approver.approve(req("fs.write"));
  assert.equal(decision.decision, "deny");
  assert.equal(policy.lookup("fs.write"), "always-deny");
  // A fresh approver sharing the policy auto-denies without prompting.
  const approver2 = new ReadlineApprover(() => {
    throw new Error("should not prompt — policy is always-deny");
  }, policy);
  const d2 = await approver2.approve(req("fs.write"));
  assert.equal(d2.decision, "deny");
});

test("decisionForReply: pure mapping records session policy", () => {
  const policy = new PolicyTable();
  assert.equal(decisionForReply("y", "t").decision.decision, "approve");
  assert.equal(decisionForReply("", "t").decision.decision, "approve");
  assert.equal(decisionForReply("n", "t").decision.decision, "deny");
  assert.equal(decisionForReply("a", "fs.edit", policy).decision.decision, "approve");
  assert.equal(policy.lookup("fs.edit"), "always-allow");
  assert.equal(decisionForReply("d", "shell.exec", policy).decision.decision, "deny");
  assert.equal(policy.lookup("shell.exec"), "always-deny");
});

// ---------------------------------------------------------------------------
// Slash-command parsing
// ---------------------------------------------------------------------------

test("parseSlashCommand: plain text is a prompt", () => {
  assert.deepEqual(parseSlashCommand("explain this function"), {
    kind: "prompt",
    text: "explain this function",
  });
  assert.deepEqual(parseSlashCommand("   "), { kind: "empty" });
});

test("parseSlashCommand: bare commands", () => {
  assert.equal(parseSlashCommand("/help").kind, "help");
  assert.equal(parseSlashCommand("/?").kind, "help");
  assert.equal(parseSlashCommand("/reset").kind, "reset");
  assert.equal(parseSlashCommand("/clear").kind, "reset");
  assert.equal(parseSlashCommand("/exit").kind, "exit");
  assert.equal(parseSlashCommand("/quit").kind, "exit");
  assert.equal(parseSlashCommand("/q").kind, "exit");
  assert.equal(parseSlashCommand("/tools").kind, "tools");
  assert.equal(parseSlashCommand("/policy").kind, "policy");
});

test("parseSlashCommand: commands are case-insensitive and trim whitespace", () => {
  assert.equal(parseSlashCommand("  /HELP  ").kind, "help");
});

test("parseSlashCommand: /model with and without an argument", () => {
  assert.deepEqual(parseSlashCommand("/model"), { kind: "model" });
  assert.deepEqual(parseSlashCommand("/model  gpt-4o "), { kind: "model", model: "gpt-4o" });
});

test("parseSlashCommand: /mode with and without an argument", () => {
  assert.deepEqual(parseSlashCommand("/mode"), { kind: "mode" });
  assert.deepEqual(parseSlashCommand("/mode auto"), { kind: "mode", mode: "auto" });
});

test("parseSlashCommand: unknown command", () => {
  assert.deepEqual(parseSlashCommand("/frobnicate now"), { kind: "unknown", name: "/frobnicate" });
});

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

test("parseArgs: flags map onto config overrides", () => {
  const p = parseArgs([
    "--no-interactive",
    "--workspace",
    "/tmp/ws",
    "--provider",
    "anthropic",
    "--model",
    "claude-x",
    "--permission-mode",
    "auto",
    "--allow-shell",
    "--no-git-read",
    "--no-project-context",
    "--max-iterations",
    "7",
    "--prompt",
    "do the thing",
  ]);
  assert.equal(p.noInteractive, true);
  assert.equal(p.prompt, "do the thing");
  assert.equal(p.noProjectContext, true);
  assert.deepEqual(p.overrides, {
    fsRoot: "/tmp/ws",
    provider: "anthropic",
    model: "claude-x",
    permissionMode: "auto",
    allowShell: true,
    noGitRead: true,
    noProjectContext: true,
    maxIterations: 7,
  });
});

test("parseArgs: --fs-root is an alias for --workspace, --help short-circuits", () => {
  assert.equal(parseArgs(["--fs-root", "/repo"]).overrides.fsRoot, "/repo");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: invalid --max-iterations is ignored (falls back to default)", () => {
  assert.equal(parseArgs(["--max-iterations", "0"]).overrides.maxIterations, undefined);
  assert.equal(parseArgs(["--max-iterations", "abc"]).overrides.maxIterations, undefined);
});

// ---------------------------------------------------------------------------
// config + agent wiring (in-memory, stub provider)
// ---------------------------------------------------------------------------

test("loadCliConfig + buildAgent: wires a working agent off a fixture env", async () => {
  const config = loadCliConfig(fixtureEnv({ JARVIS_PROVIDER: "openai", JARVIS_MODEL: "gpt-stub" }), {});
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-stub");
  // fs.edit / fs.patch are on by default for the coding REPL.
  assert.equal(config.enableFsEdit, true);
  assert.equal(config.enableFsPatch, true);

  const provider = new ScriptedProvider([assistantStop("ack")]);
  const agent = await buildAgent({ config, provider, systemPrompt: "you are a test agent" });
  assert.equal(agent.config.model, "gpt-stub");
  // The builtin read tools are registered (workspace.context is the canonical first call).
  assert.ok(agent.config.tools.names().includes("workspace.context"));
});

test("shortArgs: truncates long JSON args", () => {
  assert.equal(shortArgs({ a: 1 }), '{"a":1}');
  const long = shortArgs({ blob: "x".repeat(200) });
  assert.ok(long.endsWith("…"));
  assert.ok(long.length <= 81);
});

// ---------------------------------------------------------------------------
// REPL streaming via Agent.runStream — the production render path. The shipped
// ScriptedProvider above never emits content deltas (its tests use the blocking
// run() via runPipe), so these add a delta-aware stub to drive runTurn / runRepl
// through Agent.runStream — the path main.ts::runInteractive actually uses.
// ---------------------------------------------------------------------------

/**
 * A stub that, unlike ScriptedProvider, splits each assistant turn's text into
 * `content_delta` chunks before the terminal `finish` — exactly what the real
 * SSE providers do — so the inline-text render path is exercised. Tool-call
 * turns emit no deltas (the call rides on the finish message).
 */
class StreamingProvider implements LlmProvider {
  #queue: ChatResponse[];
  readonly seen: ChatRequest[] = [];

  constructor(responses: ChatResponse[]) {
    this.#queue = [...responses];
  }

  complete(req: ChatRequest): Promise<ChatResponse> {
    this.seen.push(req);
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("StreamingProvider: out of responses");
    return Promise.resolve(next);
  }

  async *completeStream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    const resp = await this.complete(req);
    const text = resp.message.role === "assistant" ? (resp.message.content ?? "") : "";
    for (const word of text.length > 0 ? text.split(" ") : []) {
      yield { type: "content_delta", content: `${word} ` };
    }
    yield { type: "finish", message: resp.message, finish_reason: resp.finish_reason };
  }
}

function toolCallTurn(id: string, name: string, args: JsonValue): ChatResponse {
  const message: Message = { role: "assistant", tool_calls: [{ id, name, arguments: args }] };
  return { message, finish_reason: "tool_calls" };
}

test("runTurn: streams a tool-call turn then final text through the render path", async () => {
  // Turn drives two LLM rounds: a read-only tool call (time.now, ungated → runs)
  // then a stop with text. Verifies the tool status line AND the streamed text
  // both render, and the returned conversation carries the tool result + reply.
  const provider = new StreamingProvider([
    toolCallTurn("c1", "time.now", {}),
    assistantStop("the time is now"),
  ]);
  const config = loadCliConfig(fixtureEnv(), {});
  const agent = await buildAgent({ config, provider, systemPrompt: "test agent" });

  const buf: string[] = [];
  let conv = newConversation();
  conv.messages.push({ role: "user", content: "what time is it" });
  conv = await runTurn(agent, conv, (s) => buf.push(s));

  const out = buf.join("");
  assert.match(out, /time\.now/, "the tool status line renders");
  assert.match(out, /the time is now/, "the streamed assistant text renders");
  // The conversation carries the tool result and the final assistant reply.
  assert.ok(conv.messages.some((m) => m.role === "tool"));
  assert.equal(conv.messages.at(-1)?.role, "assistant");
});

test("runRepl: a gated tool call routes through the ReadlineApprover and is denied", async () => {
  // /allow fs.write so the tool is registered; the injected approver replies "n"
  // → deny → "tool denied: ..." flows back → the model answers in text.
  const provider = new StreamingProvider([
    toolCallTurn("c1", "fs.write", { path: "x.txt", content: "hi" }),
    assistantStop("denied, so here is a summary"),
  ]);
  const config = loadCliConfig(fixtureEnv(), { allowFsWrite: true });
  const policy = new PolicyTable();
  const approver = new ReadlineApprover(() => Promise.resolve("n"), policy);

  const buf: string[] = [];
  async function* input(): AsyncGenerator<string> {
    yield "please write x.txt";
    yield "/exit";
  }
  const deps: ReplDeps = {
    config,
    policy,
    buildAgent: (model) => buildAgent({ config: { ...config, model }, provider, approver, systemPrompt: "t" }),
    input: input(),
    out: (s) => buf.push(s),
  };
  await runRepl(deps);

  assert.match(buf.join(""), /denied, so here is a summary/);
  // The deny sentinel reached the 2nd request (the file was never written).
  const lastReq = provider.seen.at(-1);
  assert.ok(lastReq);
  const toolMsg = lastReq.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.content, /tool denied/);
});

test("runRepl: /reset clears the conversation, /tools lists builtins, /exit ends the loop", async () => {
  const provider = new StreamingProvider([]);
  const config = loadCliConfig(fixtureEnv(), {});
  const buf: string[] = [];
  async function* input(): AsyncGenerator<string> {
    yield "/reset";
    yield "/tools";
    yield "/model";
    yield "/exit";
  }
  const deps: ReplDeps = {
    config,
    policy: new PolicyTable(),
    buildAgent: (model) => buildAgent({ config: { ...config, model }, provider, systemPrompt: "t" }),
    input: input(),
    out: (s) => buf.push(s),
  };
  await runRepl(deps);
  const out = buf.join("");
  assert.match(out, /conversation reset/);
  assert.match(out, /workspace\.context/, "/tools lists the builtin read tools");
  assert.match(out, /current model/);
});

// ---------------------------------------------------------------------------
// Project-context auto-load (loadProjectContext) — touches the filesystem, so
// it uses a real temp dir (no env, no network).
// ---------------------------------------------------------------------------

test("loadProjectContext: concatenates present instruction files, skips absent ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-cli-ctx-"));
  try {
    await writeFile(path.join(dir, "AGENTS.md"), "agents body");
    await writeFile(path.join(dir, "CLAUDE.md"), "claude body");
    // AGENT.md deliberately absent; README.md present but must be ignored.
    await writeFile(path.join(dir, "README.md"), "should never appear");

    const ctx = await loadProjectContext(dir, 32 * 1024);
    assert.ok(ctx);
    assert.match(ctx, /=== project context: AGENTS\.md ===/);
    assert.match(ctx, /agents body/);
    assert.match(ctx, /=== project context: CLAUDE\.md ===/);
    assert.match(ctx, /claude body/);
    assert.doesNotMatch(ctx, /AGENT\.md/);
    assert.doesNotMatch(ctx, /should never appear/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: returns undefined when no instruction files exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-cli-ctx-empty-"));
  try {
    assert.equal(await loadProjectContext(dir, 32 * 1024), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: caps on UTF-8 bytes, not UTF-16 units, for CJK content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-cli-ctx-cjk-"));
  try {
    // 1000 CJK chars = 3000 UTF-8 bytes but only 1000 UTF-16 code units. The
    // old .length/.slice path would have admitted all 3000 bytes under a
    // 1500-byte cap; the byte-accurate path must keep the result within budget.
    const body = "字".repeat(1000);
    await writeFile(path.join(dir, "AGENTS.md"), body);

    const maxBytes = 1500;
    const ctx = await loadProjectContext(dir, maxBytes);
    assert.ok(ctx);
    assert.match(ctx, /\[\.\.\.truncated\]/, "long CJK body should be truncated");

    // The injected CJK content must not exceed the configured byte budget.
    const inner = ctx.replace(/^=== project context: AGENTS\.md ===\n/, "");
    const cjkOnly = inner.replace("\n[...truncated]", "");
    assert.ok(
      Buffer.byteLength(cjkOnly, "utf8") <= maxBytes,
      `truncated body ${Buffer.byteLength(cjkOnly, "utf8")} bytes must be <= ${maxBytes}`,
    );
    // And it must cut on a character boundary — no replacement char from a
    // split multi-byte sequence.
    assert.doesNotMatch(cjkOnly, /�/, "must not split a multi-byte character");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
