// shell.exec — run a shell command (`sh -c` on POSIX, `cmd /C` on Windows),
// capturing stdout and stderr separately, each truncated to a per-stream byte
// cap, and killed if it runs longer than the timeout. Ported from
// crates/harness-tools/src/shell.rs.
//
// The `Sandbox::None` Rust default is the only behaviour ported here: the path
// sandbox (`resolveUnder` for any `cwd` arg) + the approval gate. The optional
// OS-level isolation primitives (bwrap / sandbox-exec) and `setrlimit`-based
// resource limits are intentionally not carried over.
//
// Intentionally opt-in + approval-gated (`requiresApproval = true`, category
// "exec"), mirroring the Rust trait.
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { spawn } from "node:child_process";

import { resolveUnder } from "./sandbox.ts";

/** Per-stream truncation cap: 64 KiB, matching the Rust `DEFAULT_MAX_BYTES`. */
export const SHELL_DEFAULT_MAX_BYTES = 64 * 1024;
/** Default command timeout: 30s, matching the Rust `DEFAULT_TIMEOUT_MS`. */
export const SHELL_DEFAULT_TIMEOUT_MS = 30_000;

export interface ShellExecConfig {
  /** Sandbox root. `cwd` args resolve under it; commands run with cwd here. */
  root: string;
  /** Default timeout in milliseconds. Defaults to {@link SHELL_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Per-stream byte cap. Defaults to {@link SHELL_DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
}

/** Accumulator state for one captured stream. */
interface StreamBuf {
  buf: string;
  total: number;
  truncated: boolean;
}

export class ShellExecTool implements Tool {
  readonly name = "shell.exec";
  readonly description =
    "Run a shell command (`sh -c` on unix, `cmd /C` on windows). " +
    "`cwd` is relative to the tool root; absolute paths and `..` are " +
    "rejected. Returns exit code, stdout, and stderr (each truncated). " +
    "Killed after `timeout_ms` (default 30000).";
  readonly requiresApproval = true;
  readonly category: ToolCategory = "exec";
  readonly cacheable = true;

  readonly #root: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxBytes: number;

  constructor(config: ShellExecConfig) {
    this.#root = config.root;
    this.#defaultTimeoutMs = config.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS;
    this.#maxBytes = config.maxBytes ?? SHELL_DEFAULT_MAX_BYTES;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command line passed to `sh -c` / `cmd /C`.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory, relative to the tool root.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          description: "Timeout in milliseconds. Defaults to 30000.",
        },
      },
      required: ["command"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = isObject(args) ? args : {};

    const command = obj["command"];
    if (typeof command !== "string") {
      throw new Error("missing `command` argument");
    }

    const rawCwd = obj["cwd"];
    // `resolveUnder` rejects absolute paths / `..` escapes; let its
    // SandboxError propagate (the agent loop surfaces it as a tool error).
    const cwd = typeof rawCwd === "string" ? resolveUnder(this.#root, rawCwd) : this.#root;

    const rawTimeout = obj["timeout_ms"];
    const timeoutMs =
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.floor(rawTimeout)
        : this.#defaultTimeoutMs;

    const isWindows = process.platform === "win32";
    const [program, programArgs] = isWindows
      ? (["cmd", ["/C", command]] as const)
      : (["sh", ["-c", command]] as const);

    const child = spawn(program, programArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: StreamBuf = { buf: "", total: 0, truncated: false };
    const stderr: StreamBuf = { buf: "", total: 0, truncated: false };
    this.#accumulate(child.stdout, stdout);
    this.#accumulate(child.stderr, stderr);

    const result = await new Promise<
      { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "timeout" } | { kind: "error"; error: Error }
    >((resolve) => {
      let settled = false;
      const finish = (
        value:
          | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
          | { kind: "timeout" }
          | { kind: "error"; error: Error },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        // Timeout: kill the whole child (SIGKILL — `kill_on_drop` analogue);
        // the streams close and accumulation stops.
        child.kill("SIGKILL");
        finish({ kind: "timeout" });
      }, timeoutMs);

      child.on("error", (error) => finish({ kind: "error", error }));
      child.on("close", (code, signal) => finish({ kind: "exit", code, signal }));
    });

    if (result.kind === "error") {
      throw new Error(`process error: ${result.error.message}`);
    }
    if (result.kind === "timeout") {
      throw new Error(`timed out after ${timeoutMs} ms`);
    }

    // `null` exit code means the process was terminated by a signal.
    const exit = result.code !== null ? String(result.code) : "signal";

    let s = "";
    s += `exit=${exit}\n`;
    s += `--- stdout (${stdout.total} bytes) ---\n`;
    s += stdout.buf;
    if (stdout.truncated) {
      s += `\n[... stdout truncated at ${this.#maxBytes} bytes ...]`;
    }
    s += `\n--- stderr (${stderr.total} bytes) ---\n`;
    s += stderr.buf;
    if (stderr.truncated) {
      s += `\n[... stderr truncated at ${this.#maxBytes} bytes ...]`;
    }
    return s;
  }

  /**
   * Read `stream` line-by-line, accumulating up to `maxBytes` into `out.buf`.
   * Mirrors the Rust `stream_pipe`: `total` counts every observed byte
   * (including the per-line `\n` that the line reader strips), and `buf` only
   * appends whole lines while under budget — once it would exceed the cap,
   * `truncated` latches and no further lines are kept.
   */
  #accumulate(stream: NodeJS.ReadableStream | null, out: StreamBuf): void {
    if (!stream) return;
    let pending = "";
    // UTF-8 byte length of `out.buf`, tracked incrementally so the cap
    // comparison stays in true bytes (matching the Rust origin's `line.len()`,
    // which is UTF-8 byte length) rather than JS `.length` (UTF-16 code units).
    let bufBytes = 0;
    const onLine = (line: string) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      out.total += lineBytes + 1; // +1 for the stripped newline
      if (out.truncated) return;
      if (bufBytes + lineBytes + 1 > this.#maxBytes) {
        out.truncated = true;
      } else {
        out.buf += line;
        out.buf += "\n";
        bufBytes += lineBytes + 1;
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf("\n")) !== -1) {
        // Strip a trailing `\r` so CRLF output matches the line reader's view.
        let line = pending.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        pending = pending.slice(idx + 1);
        onLine(line);
      }
    });
    stream.on("end", () => {
      // A final unterminated line (no trailing newline) is still a line to the
      // BufReader::lines() reader the Rust uses.
      if (pending.length > 0) {
        let line = pending;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        pending = "";
      }
    });
  }
}

function isObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
