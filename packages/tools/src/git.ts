// Git tools — read-only.
//
// Ported from crates/harness-tools/src/git.rs (read-only group only:
// git.{status,diff,log,show}). The write group (git.add/commit/merge) is
// intentionally NOT ported here.
//
// Each tool spawns the host's `git` binary via node:child_process execFile
// (NOT a shell), with a fixed first argument (the subcommand) and a small set
// of carefully-chosen flags, then returns the captured stdout. They are
// deliberately split per-subcommand so the JSON schema can describe exactly the
// arguments each one understands.
//
// The cwd is always the configured tool root (passed `-C <root>`), so `git`
// resolves to that repo. If the root isn't a git working tree the tool returns
// a plain "(not a git repository)" string instead of throwing so the model can
// adapt.
import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";
import { execFile } from "node:child_process";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

interface GitToolOptions {
  root: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Result of a finished git subprocess: exit code (or null on signal) + raw buffers. */
interface GitOutput {
  code: number | null;
  signalled: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Spawn `git -C <root> <args...>` with stdin closed and no shell. Resolves with
 * the captured output; rejects only on spawn failure or timeout.
 */
function spawnGit(root: string, args: string[], timeoutMs: number): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      {
        timeout: timeoutMs,
        // Capture bytes so we can measure/truncate exactly as the Rust does.
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            code?: number | string;
            killed?: boolean;
            signal?: string | null;
          };
          // Timeout / kill: execFile sets `killed` true and a signal.
          if (e.killed) {
            reject(new Error(`git timed out after ${timeoutMs} ms`));
            return;
          }
          // Failure to spawn (e.g. git not installed): no numeric exit code.
          if (typeof e.code === "string") {
            reject(new Error(`failed to spawn git: ${e.message}`));
            return;
          }
          // Non-zero exit: surface as a normal result so callers can inspect
          // stderr (the "(not a git repository)" soft path lives in run()).
          resolve({
            code: typeof e.code === "number" ? e.code : null,
            signalled: e.signal != null,
            stdout: stdout as unknown as Buffer,
            stderr: stderr as unknown as Buffer,
          });
          return;
        }
        resolve({
          code: 0,
          signalled: false,
          stdout: stdout as unknown as Buffer,
          stderr: stderr as unknown as Buffer,
        });
      },
    );
  });
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, slicing on a char
 * boundary, and append the same marker the Rust tool uses. Mirrors
 * `String::truncate` over a `char_indices()` prefix.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let cut = 0;
  for (const ch of s) {
    const next = cut + Buffer.byteLength(ch, "utf8");
    if (next > maxBytes) break;
    cut += Buffer.byteLength(ch, "utf8");
  }
  // `cut` is a byte offset; build the prefix from the Buffer to honour it.
  const buf = Buffer.from(s, "utf8");
  const prefix = buf.subarray(0, cut).toString("utf8");
  return `${prefix}\n[... truncated at ${maxBytes} bytes ...]\n`;
}

/**
 * Run a read-only git subcommand and return captured stdout. "(not a git
 * repository)" stderr is folded into a soft success string; any other non-zero
 * exit throws (the agent loop catches it → "tool error: ...").
 */
async function runGit(
  root: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const out = await spawnGit(root, args, timeoutMs);

  if (out.code !== 0) {
    const stderr = out.stderr.toString("utf8");
    if (stderr.includes("not a git repository") || stderr.includes("Not a git repository")) {
      return "(not a git repository)";
    }
    const codeStr = out.code != null ? String(out.code) : "signal";
    throw new Error(`git exited ${codeStr}: ${stderr.trim()}`);
  }

  let s = out.stdout.toString("utf8");
  if (Buffer.byteLength(s, "utf8") > maxBytes) {
    s = truncateToBytes(s, maxBytes);
  }
  return s;
}

function asObject(args: JsonValue): { [key: string]: JsonValue } {
  return args != null && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function argBool(args: JsonValue, key: string): boolean {
  const v = asObject(args)[key];
  return typeof v === "boolean" ? v : false;
}

function argOptStr(args: JsonValue, key: string): string | undefined {
  const v = asObject(args)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Reject any argument that could be interpreted as an option (starts with `-`)
 * or that contains null/newline bytes. Refs / paths in real-world use never
 * need any of these. Throws on violation. Mirrors `check_safe_arg`.
 */
function checkSafeArg(name: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`\`${name}\` must not be empty`);
  }
  if (value.startsWith("-")) {
    throw new Error(`\`${name}\` must not start with \`-\``);
  }
  if (value.includes("\0") || value.includes("\n")) {
    throw new Error(`\`${name}\` contains forbidden characters`);
  }
}

/** `git status` (porcelain v1) — short, machine-friendly. */
export class GitStatusTool implements Tool {
  readonly name = "git.status";
  readonly category: ToolCategory = "read";
  readonly cacheable = true;
  readonly description =
    "Show working-tree status of the repository at the tool root. " +
    "Uses `git status --porcelain=v1 --branch` so output is stable and " +
    "compact: each changed file appears on its own line prefixed with " +
    "a two-letter index/worktree status code.";
  readonly parameters: JsonValue = { type: "object", properties: {} };

  readonly #root: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(opts: GitToolOptions) {
    this.#root = opts.root;
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async invoke(_args: JsonValue): Promise<string> {
    return runGit(
      this.#root,
      ["status", "--porcelain=v1", "--branch"],
      this.#maxBytes,
      this.#timeoutMs,
    );
  }
}

/** `git diff` — unstaged, staged, or between revisions. */
export class GitDiffTool implements Tool {
  readonly name = "git.diff";
  readonly category: ToolCategory = "read";
  readonly cacheable = true;
  readonly description =
    "Show diffs in the repository at the tool root. By default returns " +
    "the unstaged worktree diff. Set `staged: true` for the index diff. " +
    "Provide `from` (and optionally `to`) to diff between revisions " +
    "(`from..to`, or `from` alone meaning `from..HEAD`). Optional " +
    "`path` narrows the diff to a single file.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "If true, show the staged (index) diff. Mutually exclusive with `from`/`to`.",
      },
      from: {
        type: "string",
        description:
          "Base revision (sha, branch, or tag). When set, diffs `from..to` (or `from..HEAD` if `to` omitted).",
      },
      to: {
        type: "string",
        description: "Target revision. Only used when `from` is set.",
      },
      path: {
        type: "string",
        description: "Optional path to scope the diff to (relative to the repo root).",
      },
      stat_only: {
        type: "boolean",
        description: "If true, return `--stat` summary instead of the full patch.",
      },
    },
  };

  readonly #root: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(opts: GitToolOptions) {
    this.#root = opts.root;
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async invoke(args: JsonValue): Promise<string> {
    const staged = argBool(args, "staged");
    const statOnly = argBool(args, "stat_only");
    const from = argOptStr(args, "from");
    const to = argOptStr(args, "to");
    const path = argOptStr(args, "path");

    if (staged && from !== undefined) {
      throw new Error("`staged` and `from` are mutually exclusive");
    }
    if (to !== undefined && from === undefined) {
      throw new Error("`to` requires `from`");
    }

    const argv: string[] = ["diff"];
    if (statOnly) argv.push("--stat");
    if (staged) argv.push("--cached");
    if (from !== undefined) {
      checkSafeArg("from", from);
      if (to !== undefined) {
        checkSafeArg("to", to);
        argv.push(`${from}..${to}`);
      } else {
        argv.push(`${from}..HEAD`);
      }
    }
    if (path !== undefined) {
      checkSafeArg("path", path);
      argv.push("--", path);
    }

    const out = await runGit(this.#root, argv, this.#maxBytes, this.#timeoutMs);
    if (out.length === 0) {
      return "(no changes)";
    }
    return out;
  }
}

/** `git log` — recent commit list. */
export class GitLogTool implements Tool {
  readonly name = "git.log";
  readonly category: ToolCategory = "read";
  readonly cacheable = true;
  readonly description =
    "Recent commit history of the repo at the tool root. Returns one " +
    "commit per line in `<short-sha> <subject>` form by default. Set " +
    '`format: "full"` for author + date + body. Optional `limit` ' +
    "(default 20, hard cap 200), `revision` (branch / sha / range), " +
    "and `path` (file or directory) narrow the result.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Number of commits to return. Default 20.",
      },
      revision: {
        type: "string",
        description: "Branch, sha, or range to walk (e.g. `main`, `abc123..HEAD`).",
      },
      path: {
        type: "string",
        description: "Optional path to filter commits by (file or directory).",
      },
      format: {
        type: "string",
        enum: ["short", "full"],
        description: "`short` (default): one-line per commit. `full`: include author/date/body.",
      },
    },
  };

  readonly #root: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(opts: GitToolOptions) {
    this.#root = opts.root;
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async invoke(args: JsonValue): Promise<string> {
    const limitRaw = asObject(args)["limit"];
    // Mirror Rust `as_u64().unwrap_or(20).min(200)`: only non-negative
    // integers count; anything else falls back to the default.
    let limit = 20;
    if (typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw >= 0) {
      limit = Math.min(limitRaw, 200);
    }
    const revision = argOptStr(args, "revision");
    const path = argOptStr(args, "path");
    const format = argOptStr(args, "format") ?? "short";

    const argv: string[] = ["log", `-n${limit}`];
    if (format === "short") {
      argv.push("--pretty=format:%h %s");
    } else if (format === "full") {
      argv.push("--pretty=format:%h %an <%ae> %ad%n  %s%n%b%n");
      argv.push("--date=iso-strict");
    } else {
      throw new Error(`unknown \`format\`: ${format}`);
    }
    if (revision !== undefined) {
      checkSafeArg("revision", revision);
      argv.push(revision);
    }
    if (path !== undefined) {
      checkSafeArg("path", path);
      argv.push("--", path);
    }

    return runGit(this.#root, argv, this.#maxBytes, this.#timeoutMs);
  }
}

/** `git show` — a single commit's metadata + diff (or just metadata). */
export class GitShowTool implements Tool {
  readonly name = "git.show";
  readonly category: ToolCategory = "read";
  readonly cacheable = true;
  readonly description =
    "Show a single commit (metadata + patch) by sha or ref. Set " +
    "`metadata_only: true` to skip the diff and return only " +
    "author / date / subject / body. Optional `path` scopes the diff " +
    "to a single file.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      revision: {
        type: "string",
        description: "Commit sha, branch tip, tag, or `HEAD~N`.",
      },
      metadata_only: {
        type: "boolean",
        description: "If true, omit the patch body.",
      },
      path: {
        type: "string",
        description: "Optional path to scope the diff to.",
      },
    },
    required: ["revision"],
  };

  readonly #root: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(opts: GitToolOptions) {
    this.#root = opts.root;
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async invoke(args: JsonValue): Promise<string> {
    const revision = argOptStr(args, "revision");
    if (revision === undefined) {
      throw new Error("missing `revision` argument");
    }
    checkSafeArg("revision", revision);
    const metadataOnly = argBool(args, "metadata_only");
    const path = argOptStr(args, "path");

    const argv: string[] = ["show"];
    if (metadataOnly) argv.push("--no-patch");
    argv.push("--pretty=fuller");
    argv.push(revision);
    if (path !== undefined) {
      checkSafeArg("path", path);
      argv.push("--", path);
    }

    return runGit(this.#root, argv, this.#maxBytes, this.#timeoutMs);
  }
}

/**
 * Build the read-only git tool group (`git.status`, `git.diff`, `git.log`,
 * `git.show`) all rooted at `root`. `opts` overrides the byte cap / timeout for
 * every tool in the group.
 */
export function gitTools(
  root: string,
  opts?: { maxBytes?: number; timeoutMs?: number },
): [GitStatusTool, GitDiffTool, GitLogTool, GitShowTool] {
  const o: GitToolOptions = { root, maxBytes: opts?.maxBytes, timeoutMs: opts?.timeoutMs };
  return [new GitStatusTool(o), new GitDiffTool(o), new GitLogTool(o), new GitShowTool(o)];
}
