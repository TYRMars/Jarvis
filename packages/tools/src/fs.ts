// Sandboxed filesystem tools. Every tool is constructed with a `root`
// directory and refuses inputs that are absolute or contain `..` components,
// so the LLM can only read/list/write inside that root.
//
// Ported faithfully from crates/harness-tools/src/fs.rs.

import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import { resolveUnder } from "./sandbox.ts";
import { withDiagnostics, type DiagnosticsHook } from "./diagnostics.ts";

/** Configuration shared by the `fs.*` tools. */
export interface FsConfig {
  /** Sandbox root; every path argument is resolved under it. */
  root: string;
  /**
   * Optional post-write diagnostics hook. The write tools (`fs.write`,
   * `fs.edit`) call it with the path they wrote and append the returned
   * `<diagnostics>` block. Read-only tools ignore it. Absent → no change.
   */
  diagnostics?: DiagnosticsHook;
}

function asObject(args: JsonValue): { [key: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }
  return {};
}

function argStr(args: JsonValue, key: string): string {
  const v = asObject(args)[key];
  if (typeof v !== "string") {
    throw new Error(`missing \`${key}\` argument`);
  }
  return v;
}

/**
 * Truncate a UTF-8 string to at most `max` bytes without splitting a
 * multi-byte sequence, mirroring the Rust char-boundary backtrack.
 */
function truncateBytes(contents: string, max: number): string {
  const buf = Buffer.from(contents, "utf8");
  if (buf.length <= max) return contents;
  let idx = max;
  // Back up off a UTF-8 continuation byte (0b10xxxxxx) so we cut on a char
  // boundary, matching `is_char_boundary` in the Rust.
  while (idx > 0 && (buf[idx]! & 0xc0) === 0x80) {
    idx -= 1;
  }
  const head = buf.subarray(0, idx).toString("utf8");
  return `${head}\n\n[... truncated at ${max} bytes ...]`;
}

/** Read a UTF-8 file under the tool root. */
export class FsReadTool implements Tool {
  readonly name = "fs.read";
  readonly description =
    "Read a UTF-8 text file located under the tool's root directory. " +
    "`path` is relative; `..` and absolute paths are rejected. " +
    "Files larger than the configured byte limit are truncated.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  #root: string;
  #maxBytes: number | undefined;

  constructor(config: FsConfig & { maxBytes?: number }) {
    this.#root = config.root;
    this.#maxBytes = config.maxBytes;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path under the root." },
      },
      required: ["path"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const rel = argStr(args, "path");
    const abs = resolveUnder(this.#root, rel);
    const contents = await fs.readFile(abs, "utf8");
    if (this.#maxBytes !== undefined) {
      return truncateBytes(contents, this.#maxBytes);
    }
    return contents;
  }
}

/** List entries in a directory under the tool root. */
export class FsListTool implements Tool {
  readonly name = "fs.list";
  readonly description =
    "List entries in a directory under the tool root. Returns a JSON array " +
    "of {name, kind: 'file'|'dir'|'other'} objects.";
  readonly cacheable = true;
  readonly category: ToolCategory = "read";

  #root: string;

  constructor(config: FsConfig) {
    this.#root = config.root;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative directory path under the root. Defaults to the root itself.",
        },
      },
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const relRaw = asObject(args).path;
    const rel = typeof relRaw === "string" ? relRaw : ".";
    const abs = resolveUnder(this.#root, rel);
    const dirents = await fs.readdir(abs, { withFileTypes: true });

    const entries: JsonValue[] = [];
    for (const entry of dirents) {
      const kind = entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
      entries.push({ name: entry.name, kind });
    }
    return JSON.stringify(entries);
  }
}

/**
 * Write UTF-8 `content` to `path`, creating parent directories as needed.
 *
 * Overwrites existing files. Opt-in + approval-gated.
 */
export class FsWriteTool implements Tool {
  readonly name = "fs.write";
  readonly description =
    "Write UTF-8 text to a file under the tool root. Creates parent " +
    "directories as needed and overwrites existing files.";
  readonly requiresApproval = true;
  readonly cacheable = true;
  readonly category: ToolCategory = "write";

  #root: string;
  #diagnostics: DiagnosticsHook | undefined;

  constructor(config: FsConfig) {
    this.#root = config.root;
    this.#diagnostics = config.diagnostics;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path under the root." },
        content: { type: "string", description: "File contents (UTF-8)." },
      },
      required: ["path", "content"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const rel = argStr(args, "path");
    const content = argStr(args, "content");
    const abs = resolveUnder(this.#root, rel);
    const parent = path.dirname(abs);
    await fs.mkdir(parent, { recursive: true });
    const bytes = Buffer.byteLength(content, "utf8");
    await fs.writeFile(abs, content, "utf8");
    return withDiagnostics(`wrote ${bytes} bytes to ${abs}`, this.#diagnostics, [abs]);
  }
}

/**
 * Replace `old_string` with `new_string` in a UTF-8 file under the tool root.
 * By default the match must be unique so the LLM can't silently rewrite many
 * call-sites at once; pass `replace_all = true` to opt in.
 *
 * Opt-in + approval-gated.
 */
export class FsEditTool implements Tool {
  readonly name = "fs.edit";
  readonly description =
    "Replace `old_string` with `new_string` in a file under the tool root. " +
    "By default `old_string` must occur exactly once; pass " +
    "`replace_all = true` to replace every occurrence.";
  readonly requiresApproval = true;
  readonly cacheable = true;
  readonly category: ToolCategory = "write";

  #root: string;
  #diagnostics: DiagnosticsHook | undefined;

  constructor(config: FsConfig) {
    this.#root = config.root;
    this.#diagnostics = config.diagnostics;
  }

  get parameters(): JsonValue {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path under the root." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description:
            "Replace every occurrence instead of requiring uniqueness. Defaults to false.",
        },
      },
      required: ["path", "old_string", "new_string"],
    };
  }

  async invoke(args: JsonValue): Promise<string> {
    const rel = argStr(args, "path");
    const oldString = argStr(args, "old_string");
    const newString = argStr(args, "new_string");
    const replaceAllRaw = asObject(args).replace_all;
    const replaceAll = typeof replaceAllRaw === "boolean" ? replaceAllRaw : false;

    if (oldString.length === 0) {
      throw new Error("`old_string` must not be empty");
    }
    if (oldString === newString) {
      throw new Error("`old_string` and `new_string` are identical");
    }

    const abs = resolveUnder(this.#root, rel);
    const original = await fs.readFile(abs, "utf8");
    const count = countOccurrences(original, oldString);

    let updated: string;
    let replaced: number;
    if (count === 0) {
      throw new Error("`old_string` not found in file");
    } else if (replaceAll) {
      // split/join does a literal replacement (no `$`-pattern interpolation,
      // unlike String.prototype.replace with a string pattern).
      updated = original.split(oldString).join(newString);
      replaced = count;
    } else if (count === 1) {
      const idx = original.indexOf(oldString);
      updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
      replaced = 1;
    } else {
      throw new Error(
        `\`old_string\` matches ${count} times — pass \`replace_all = true\` or extend the snippet for uniqueness`,
      );
    }

    await fs.writeFile(abs, updated, "utf8");
    return withDiagnostics(`edited ${abs}: replaced ${replaced} occurrence(s)`, this.#diagnostics, [abs]);
  }
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`, matching
 * Rust's `str::matches(...).count()`. `needle` is guaranteed non-empty by the
 * caller, but guard anyway.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}
