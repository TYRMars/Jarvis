// `subagent.claude_code` — delegate a coding task to the local `claude` CLI
// (Anthropic's Claude Code distribution). Spawns
// `claude --print --output-format stream-json --verbose --permission-mode
// bypassPermissions [--model M] [extra...] <task>`, parses each SDKMessage
// line on stdout, and emits the equivalent SubAgentEvent frames. Ported from
// harness-subagents/src/claude_code.rs.
//
// Discovery: the composition root calls `probe` once at startup; if `claude`
// isn't on PATH (or --version fails / is unrecognised) it rejects and the
// subagent is NOT registered (no panic).
//
// Authentication: the spawned `claude` inherits the parent process env, so an
// interactively-logged-in user gets seamless auth. Extra CLI flags (e.g.
// `--bare` in keychain-less environments) are forwarded via
// `ClaudeCodeConfig.extra_args`.
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonValue } from "@jarvis/core";
import {
  emitSubagent,
  type Artifact,
  type SubAgent,
  type SubAgentEvent,
  type SubAgentInput,
  type SubAgentOutput,
} from "./subagent.ts";

export const DESCRIPTION =
  "Delegate a coding task to Claude Code (Anthropic's `claude` CLI). It can read, edit, and run shell commands inside the workspace; treat it like a peer coder you hand a focused task to. Will modify files; the call is approval-gated.";

export interface ClaudeCodeConfig {
  /** Path or name of the `claude` binary. Default `claude` (PATH lookup). */
  claude_bin: string;
  /** Optional model override forwarded as `--model`. `undefined` = CLI default. */
  model?: string;
  /**
   * Extra args forwarded verbatim, inserted after the standard flags + any
   * `--model`, before the final task positional. Empty by default. Absent on
   * the wire when empty (serde `default`).
   */
  extra_args?: string[];
  /**
   * Wall-clock budget for a single run, in milliseconds. When the spawned
   * `claude` outruns it the child is SIGKILL'd and `invoke` rejects — a hung
   * CLI must never block the caller forever. Defaults to
   * {@link CLAUDE_CODE_DEFAULT_TIMEOUT_MS}.
   */
  timeout_ms?: number;
}

/**
 * Default run timeout: 10 minutes, matching `JARVIS_WORK_RUN_TIMEOUT_MS`
 * (the auto-loop's per-run budget) so a delegated `claude` run can't outlast
 * the work unit that dispatched it.
 */
export const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 600_000;

export function defaultClaudeCodeConfig(): ClaudeCodeConfig {
  return { claude_bin: "claude" };
}

/**
 * Probe the host: is `claude` on PATH and does `--version` recognise it as
 * Claude Code? Run once at startup; on failure callers skip registration.
 * Rejects with a reason string (mirrors Rust's `Result<(), String>`).
 */
export function probe(claudeBin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(claudeBin, ["--version"], { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        // ENOENT (binary missing) or non-zero exit both land here.
        if ((err as { code?: string }).code === "ENOENT") {
          reject(new Error(`spawn \`${claudeBin}\` failed: ${err.message}`));
        } else {
          reject(new Error(`\`${claudeBin} --version\` exited with error: ${err.message}`));
        }
        return;
      }
      // The CLI prints e.g. `2.1.119 (Claude Code)` — the parenthesised tag
      // disambiguates the official binary from someone else's `claude`.
      if (!stdout.includes("Claude Code")) {
        reject(new Error(`\`${claudeBin} --version\` output unrecognised (got: ${stdout.trim()})`));
        return;
      }
      resolve();
    });
  });
}

const STDERR_CAP = 64 * 1024;

export class ClaudeCodeSubAgent implements SubAgent {
  readonly name = "claude_code";
  readonly description = DESCRIPTION;
  readonly #config: ClaudeCodeConfig;

  constructor(config: ClaudeCodeConfig) {
    this.#config = config;
  }

  inputSchema(): JsonValue {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Natural-language coding task. Claude Code will plan + execute autonomously.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    };
  }

  requiresApproval(): boolean {
    // The CLI will mutate the workspace. The outer approver MUST gate this;
    // per-tool approvals inside the CLI run under bypassPermissions (the user
    // already approved the outer call, and --print mode can't surface prompts).
    return true;
  }

  async invoke(input: SubAgentInput): Promise<SubAgentOutput> {
    const id = crypto.randomUUID();
    const push = (event: SubAgentEvent): void => {
      emitSubagent({ subagent_id: id, subagent_name: this.name, event });
    };

    const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    if (this.#config.model !== undefined) args.push("--model", this.#config.model);
    if (this.#config.extra_args && this.#config.extra_args.length > 0) args.push(...this.#config.extra_args);
    args.push(input.task); // final positional

    const startEvent: SubAgentEvent = { kind: "started", task: input.task };
    if (this.#config.model !== undefined) startEvent.model = this.#config.model;
    push(startEvent);

    let child;
    try {
      child = spawn(this.#config.claude_bin, args, {
        cwd: input.workspace_root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      throw new Error(`spawn \`${this.#config.claude_bin}\`: ${stringifyError(e)}`);
    }

    // A spawn failure (ENOENT) surfaces asynchronously via the 'error' event,
    // not as a throw — capture it so `invoke` rejects rather than hanging.
    let spawnError: Error | undefined;
    child.on("error", (e) => {
      spawnError = e;
    });

    // Drain stderr in the background, capped at 64 KiB. Swallow stream errors
    // on the diagnostic channel so an stderr EPIPE can't escape as an
    // unhandled rejection (the run's success is judged by the result message
    // and exit code, not by stderr).
    let stderrText = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderrText.length < STDERR_CAP) stderrText += chunk;
      });
      child.stderr.on("error", () => {});
    }

    let finalMessage = "";
    let errorMessage: string | undefined;
    // tool_use_id -> tool name, so tool_result blocks pair back to ToolEnd.
    const toolNames = new Map<string, string>();

    // Enforce a wall-clock budget: a hung/stalled CLI is SIGKILL'd so `invoke`
    // can never await forever. The kill closes stdout, ending the loop below,
    // and the flag is surfaced as a timeout error after the child is reaped.
    const timeoutMs = this.#config.timeout_ms ?? CLAUDE_CODE_DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let streamError: Error | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    try {
      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        // Capture an stdout stream error (e.g. EPIPE) rather than letting it
        // reject the `for await` and unwind out of `invoke` with the child
        // still alive — the `finally` below reaps it regardless.
        child.stdout.on("error", (e: Error) => {
          if (streamError === undefined) streamError = e;
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
          const msg = parseSdkMessage(line);
          if (msg === undefined) continue; // blank / garbage
          if (msg.type === "system") {
            if (msg.subtype !== undefined) push({ kind: "status", message: `system:${msg.subtype}` });
          } else if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text") {
                if (block.text.length > 0) push({ kind: "delta", text: block.text });
              } else if (block.type === "tool_use") {
                toolNames.set(block.id, block.name);
                push({ kind: "tool_start", name: block.name, arguments: block.input });
              }
              // thinking / tool_result on assistant turns: forward-compat ignore.
            }
          } else if (msg.type === "user") {
            for (const block of msg.message.content) {
              if (block.type === "tool_result") {
                const name = toolNames.get(block.tool_use_id) ?? "unknown";
                toolNames.delete(block.tool_use_id);
                push({ kind: "tool_end", name, output: stringifyToolResult(block.content) });
              }
            }
          } else if (msg.type === "result") {
            if (msg.is_error || msg.subtype !== "success") {
              errorMessage = msg.result ?? `claude returned error subtype=${JSON.stringify(msg.subtype)}`;
            } else if (msg.result !== undefined) {
              finalMessage = msg.result;
            }
          }
          // unknown message kind: skip silently.
        }
      }
    } catch (e) {
      // A throw from the stream (or the loop body) must not orphan the child.
      if (streamError === undefined) streamError = e instanceof Error ? e : new Error(String(e));
    } finally {
      // Reap the child on any abnormal exit path — Node does not kill children
      // on GC, so an un-reaped `claude` (running under bypassPermissions) would
      // keep mutating the workspace and burning quota. On a clean completion we
      // leave it to exit on its own so the real exit code is observed below.
      if ((timedOut || streamError !== undefined) && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    const code = await waitForExit(child);
    clearTimeout(timer);

    if (timedOut) {
      const msg = `\`claude\` timed out after ${timeoutMs} ms`;
      push({ kind: "error", message: msg });
      throw new Error(msg);
    }
    if (spawnError !== undefined) {
      throw new Error(`spawn \`${this.#config.claude_bin}\`: ${spawnError.message}`);
    }
    if (streamError !== undefined) {
      const msg = `\`claude\` stdout stream error: ${streamError.message}`;
      push({ kind: "error", message: msg });
      throw new Error(msg);
    }

    if (errorMessage !== undefined) {
      push({ kind: "error", message: errorMessage });
      throw new Error(`subagent error: ${errorMessage}`);
    }

    if (code !== 0) {
      const trimmed = stderrText.trim();
      const msg = trimmed.length === 0 ? `\`claude\` exited ${code}` : `\`claude\` exited ${code}: ${trimmed}`;
      push({ kind: "error", message: msg });
      throw new Error(msg);
    }

    push({ kind: "done", final_message: finalMessage });

    const artifacts = artifactsForRun();
    const out: SubAgentOutput = { message: finalMessage };
    if (artifacts.length > 0) out.artifacts = artifacts;
    return out;
  }
}

/** Future enhancement: parse git status/diff to populate FilesChanged. */
function artifactsForRun(): Artifact[] {
  return [];
}

// ---------------------------------------------------------------------------
// SDKMessage envelope parsing (claude --output-format stream-json)
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonValue }
  | { type: "tool_result"; tool_use_id: string; content: JsonValue }
  | { type: "thinking"; thinking: string }
  | { type: "__unknown__" };

type SdkMessage =
  | { type: "system"; subtype?: string }
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "user"; message: { content: ContentBlock[] } }
  | { type: "result"; subtype?: string; result?: string; is_error: boolean }
  | { type: "__unknown__" };

/** Parse one stdout line into an SDKMessage; undefined for blank/garbage. */
export function parseSdkMessage(line: string): SdkMessage | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  switch (obj["type"]) {
    case "system":
      return { type: "system", subtype: typeof obj["subtype"] === "string" ? obj["subtype"] : undefined };
    case "assistant":
      return { type: "assistant", message: { content: parseContent(messageContent(obj)) } };
    case "user":
      // `content` is normally an array for stream-json; non-arrays (legacy
      // plain-string content) default to empty.
      return { type: "user", message: { content: parseContent(messageContent(obj)) } };
    case "result":
      return {
        type: "result",
        subtype: typeof obj["subtype"] === "string" ? obj["subtype"] : undefined,
        result: typeof obj["result"] === "string" ? obj["result"] : undefined,
        is_error: obj["is_error"] === true,
      };
    default:
      return { type: "__unknown__" };
  }
}

function messageContent(obj: Record<string, unknown>): unknown {
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return undefined;
  return (message as Record<string, unknown>)["content"];
}

function parseContent(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    switch (block["type"]) {
      case "text":
        out.push({ type: "text", text: typeof block["text"] === "string" ? block["text"] : "" });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: typeof block["id"] === "string" ? block["id"] : "",
          name: typeof block["name"] === "string" ? block["name"] : "",
          input: (block["input"] ?? {}) as JsonValue,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "",
          content: (block["content"] ?? null) as JsonValue,
        });
        break;
      case "thinking":
        out.push({ type: "thinking", thinking: typeof block["thinking"] === "string" ? block["thinking"] : "" });
        break;
      default:
        out.push({ type: "__unknown__" });
    }
  }
  return out;
}

/**
 * Tool results land as either a plain string or an array of `{type,text}`
 * blocks. Flatten to a single string. Null -> "". Other -> JSON.
 */
export function stringifyToolResult(v: JsonValue): string {
  if (typeof v === "string") return v;
  if (v === null) return "";
  if (Array.isArray(v)) {
    let out = "";
    for (const item of v) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const text = (item as Record<string, JsonValue>)["text"];
        if (typeof text === "string") {
          if (out.length > 0) out += "\n";
          out += text;
        }
      }
    }
    return out;
  }
  return JSON.stringify(v);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
  });
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
