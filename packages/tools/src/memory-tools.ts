// `memory.*` agent-maintained MARKDOWN memory tools. Ported from
// crates/harness-tools/src/memory.rs (+ memory_include.rs / memory_include_tools.rs).
//
// The model writes durable notes ("user prefers Rust + tokio", "the auth flow
// rejects empty user-agent strings", etc.) into one of two scopes:
//
//   - workspace scope — facts specific to the current project. Stored under
//     `<workspaceRoot>/.jarvis/memory/`. Checking the directory into git gives
//     the team shared recall of the codebase's quirks.
//   - user scope — facts that follow the operator across projects. Stored under
//     `<userRoot>/.jarvis/memory/`. User scope is DISABLED when `userRoot` is
//     absent — writes to user scope then error cleanly and the combined list
//     silently omits the user section.
//
// Each scope has its own `MEMORY.md` index plus one `<slug>.md` per topic. Slug
// collisions across scopes are allowed — the two trees are independent.
// `memory.read` defaults to workspace and falls back to user when the slug
// isn't found in workspace; an explicit `scope` argument disambiguates.
//
// The include-directive surface (`memory.include_add/include_list/
// include_remove/include_refresh`) splices referenced memory trees into a
// composed view by writing `<!-- jarvis-include: ... -->` lines at the top of a
// scope's MEMORY.md. Includes are strictly CONSUMED at system-prompt-injection
// time, never written to. Git includes clone into a local cache dir.
//
// Result of every tool is a STRING. List/read return raw markdown / body text
// (matching the Rust); the include tools return JSON (JSON.stringify, matching
// the Rust `json!{...}.to_string()`).
//
// DEFERRED from the Rust port:
//   - memory_sync.rs   — git sync of the agent's OWN memory tree (the
//     `memory.{sync,sync_status,sync_setup}` tools). Not ported.
//   - memory_icloud.rs — iCloud lazy-stub materialization (`ensure_materialised`
//     before reads). On macOS+iCloud the Rust pulls `.MEMORY.md.icloud` stubs
//     down first; here reads hit the filesystem directly (a no-op off iCloud).
//
// Rust harness-core helpers with no Node equivalent are dropped (matching the
// doc.* / todo.* ports): `summary_for_audit` (audit-row hint) and
// `note_working_file_relative_to` / `active_workspace_or` (task-local workspace
// channel). The roots are fixed at construction; no per-call workspace
// override.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { JsonValue, Tool, ToolCategory, ToolRegistry } from "@jarvis/core";

// ---------- caps / layout constants ----------------------------------------

/** Per-entry body cap. Generous for a memory note, small enough that one bad
 * write can't blow up the system-prompt injection budget. */
export const MAX_ENTRY_BYTES = 32 * 1024;
/** Index file (MEMORY.md) cap. The whole index is injected into the system
 * prompt at conversation start — 25 KiB matches `load_instructions`. */
export const MAX_INDEX_BYTES = 25 * 1024;
/** Hard cap on index lines so a runaway `memory.write` loop can't fill
 * MEMORY.md with thousands of one-line entries. */
export const MAX_INDEX_LINES = 200;

/** Subdirectory under the workspace / user root where memory lives. Same name
 * in both scopes so a glance at `tree` reveals the layout consistently. */
export const MEMORY_DIR = ".jarvis/memory";
const INDEX_FILE = "MEMORY.md";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Protocols git is permitted to use when cloning an include URL. Passed as
 * leading `-c protocol.*.allow` config flags (a default-deny whitelist) so
 * git's `ext::` / `fd::` transports — which execute arbitrary commands — can
 * never fire from attacker-controlled memory content.
 *
 * The Rust exports `GIT_ALLOW_PROTOCOL=https:ssh:git:file` into the child env;
 * the env-free convention here forbids reading/mutating `process.env`, so we
 * use the documented config-key equivalent: `protocol.allow=never` plus a
 * per-transport `protocol.<name>.allow=always` for each allowed scheme. This is
 * exactly equivalent to the env-var whitelist (verified: `ext::` is rejected,
 * `https`/`ssh`/`git`/`file` and plain local paths still clone).
 */
const GIT_ALLOWED_PROTOCOLS = ["https", "ssh", "git", "file"] as const;

/** Leading `git` args that pin the allowed-protocol whitelist. */
function gitProtocolGuardArgs(): string[] {
  const args = ["-c", "protocol.allow=never"];
  for (const proto of GIT_ALLOWED_PROTOCOLS) {
    args.push("-c", `protocol.${proto}.allow=always`);
  }
  return args;
}

// ---------- scope -----------------------------------------------------------

/** Identifies which scope a memory operation targets. */
export type MemoryScope = "workspace" | "user";

/**
 * Tool-construction config: both scope roots. `userRoot` is the parent of
 * `.jarvis/memory/` (usually the user's home directory); omitting it disables
 * user scope — write attempts to user scope error cleanly, and the combined
 * list silently omits the user index.
 */
export interface MemoryToolsConfig {
  workspaceRoot: string;
  userRoot?: string;
}

/** Internal resolved-roots holder mirroring the Rust `MemoryRoots`. */
interface MemoryRoots {
  workspaceRoot: string;
  userRoot?: string;
}

/**
 * Resolve a scope to its absolute parent path. Throws (user-facing) when the
 * requested scope isn't configured. Mirrors `MemoryRoots::root_for`.
 */
function rootFor(roots: MemoryRoots, scope: MemoryScope): string {
  if (scope === "workspace") {
    return roots.workspaceRoot;
  }
  if (roots.userRoot === undefined) {
    throw new Error("user-scope memory is not configured");
  }
  return roots.userRoot;
}

function parseScopeArg(s: string): MemoryScope {
  if (s === "workspace" || s === "user") {
    return s;
  }
  throw new Error(`unknown scope \`${s}\` — use \`workspace\` or \`user\``);
}

// ---------- path helpers ----------------------------------------------------

/** Absolute index path under `root`. */
export function indexPath(root: string): string {
  return path.join(root, MEMORY_DIR, INDEX_FILE);
}

/** Absolute body path for `slug` under `root`. Does not validate the slug —
 * callers must `validateSlug` first. */
function entryPath(root: string, slug: string): string {
  return path.join(root, MEMORY_DIR, `${slug}.md`);
}

/**
 * Reject anything that isn't safe to use as a filename / index anchor. The slug
 * becomes part of the on-disk path and the markdown link — disallowing path
 * separators, dot-prefixes, and the reserved `MEMORY` token keeps the layout
 * coherent. Throws on rejection.
 */
export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new Error("slug must not be empty");
  }
  if (slug.length > 64) {
    throw new Error("slug must be 64 chars or fewer");
  }
  if (slug.toLowerCase() === "memory") {
    throw new Error("slug `memory` is reserved (clashes with MEMORY.md)");
  }
  if (slug.startsWith(".")) {
    throw new Error("slug must not start with `.`");
  }
  for (const c of slug) {
    const ok = /[A-Za-z0-9]/.test(c) || c === "-" || c === "_" || c === ".";
    if (!ok) {
      throw new Error(`slug contains invalid char \`${c}\` (allowed: A-Za-z0-9._-)`);
    }
  }
}

const NOT_FOUND = "ENOENT";

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === NOT_FOUND;
}

/**
 * Read the index file (`MEMORY.md`), returning `undefined` when it hasn't been
 * created yet so the empty-state path is `undefined` rather than throwing.
 *
 * (The Rust additionally materializes iCloud lazy stubs first via
 * `memory_icloud::ensure_materialised`; that path is DEFERRED here.)
 */
export async function readIndex(root: string): Promise<string | undefined> {
  const p = indexPath(root);
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    if (isNotFound(e)) {
      return undefined;
    }
    throw new Error(`read ${p}: ${String(e)}`);
  }
}

/**
 * Append-or-update one entry's line in MEMORY.md. The line shape is
 * `- [<summary>](<slug>.md)` — a normal markdown list link. Duplicate slugs
 * replace the existing line in place so re-writing the same topic doesn't bloat
 * the index.
 *
 * The slug needle is anchored to the *end* of the line (`endsWith`), not matched
 * anywhere in it (`includes`). Every line this tool writes ends with its own
 * `](<slug>.md)` because the summary is interpolated strictly before that
 * suffix, so a crafted summary such as `x](other.md)` (producing
 * `- [x](other.md)](self.md)`) can no longer forge another slug's needle and
 * corrupt the wrong index line.
 */
function mergeIndexLine(existing: string | undefined, slug: string, summary: string): string {
  const newLine = `- [${summary}](${slug}.md)`;
  const needle = `](${slug}.md)`;
  const lines = existing !== undefined ? splitLines(existing) : [];
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line.endsWith(needle)) {
      out.push(newLine);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) {
    out.push(newLine);
  }
  // Drop empty leading/trailing lines for stable byte output.
  while (out.length > 0 && out[0] === "") {
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out.join("\n") + "\n";
}

/**
 * Remove the matching index line for `slug`. Returns the modified body and
 * whether a line was removed (i.e. the slug had an entry). Anchored with
 * `endsWith` (see `mergeIndexLine`) so a forged summary cannot make another
 * slug's line match this needle.
 */
function removeIndexLine(existing: string, slug: string): { body: string; removed: boolean } {
  const needle = `](${slug}.md)`;
  const all = splitLines(existing);
  const kept = all.filter((line) => !line.endsWith(needle));
  const removed = kept.length < all.length;
  let joined = kept.join("\n");
  if (joined.length > 0 && !joined.endsWith("\n")) {
    joined += "\n";
  }
  return { body: joined, removed };
}

/** Split into lines the way Rust's `str::lines()` does: drop a single trailing
 * newline, never yield a phantom empty final element. */
function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const withoutTrailing = s.endsWith("\n") ? s.slice(0, -1) : s;
  return withoutTrailing.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Count non-empty lines, mirroring `lines().filter(|l| !l.trim().is_empty())`. */
function countNonEmptyLines(s: string): number {
  return splitLines(s).filter((l) => l.trim() !== "").length;
}

/** Atomic write: temp file in the same directory + rename. Avoids torn writes
 * if the agent dies mid-write. */
async function atomicWrite(p: string, contents: string): Promise<void> {
  const parent = path.dirname(p);
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (e) {
    throw new Error(`mkdir ${parent}: ${String(e)}`);
  }
  // Rust uses `path.with_extension("tmp")` — replaces the final extension.
  const tmp = withExtensionTmp(p);
  try {
    await fs.writeFile(tmp, contents);
  } catch (e) {
    throw new Error(`write ${tmp}: ${String(e)}`);
  }
  try {
    await fs.rename(tmp, p);
  } catch (e) {
    throw new Error(`rename ${p}: ${String(e)}`);
  }
}

/** Replace the final extension of `p` with `.tmp` (mirrors Rust
 * `Path::with_extension("tmp")`): `MEMORY.md` → `MEMORY.tmp`. */
function withExtensionTmp(p: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const ext = path.extname(base);
  const stem = ext === "" ? base : base.slice(0, -ext.length);
  return path.join(dir, `${stem}.tmp`);
}

// ---------- arg helpers -----------------------------------------------------

function asObject(args: JsonValue): { [k: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as { [k: string]: JsonValue };
  }
  return {};
}

function asString(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ===========================================================================
// memory.list / memory.read / memory.write / memory.delete
// ===========================================================================

/**
 * Render the combined list output for `memory.list`. Pure render helper so the
 * system-prompt injection path (which doesn't go through tool dispatch) can
 * call it directly. Mirrors the Rust `render_combined_list`.
 */
export async function renderCombinedList(
  roots: MemoryRoots,
  only?: MemoryScope,
): Promise<string> {
  let out = "";
  const scopes: MemoryScope[] =
    only === "workspace" ? ["workspace"] : only === "user" ? ["user"] : ["workspace", "user"];
  for (const scope of scopes) {
    let root: string;
    try {
      root = rootFor(roots, scope);
    } catch {
      continue;
    }
    const header =
      scope === "workspace"
        ? "## project memory (workspace scope)"
        : "## user memory (cross-workspace)";
    if (out !== "") {
      out += "\n\n";
    }
    out += header;
    out += "\n";
    const body = await readIndex(root).catch(() => undefined);
    if (body !== undefined && body.trim() !== "") {
      out += body.replace(/\s+$/, "");
    } else {
      out += "(no entries yet)";
    }
  }
  return out === "" ? "(no memory entries yet)" : out;
}

export class MemoryListTool implements Tool {
  readonly name = "memory.list";
  readonly category: ToolCategory = "read";
  readonly description =
    "List the agent's memory indices. With no arguments, returns a combined " +
    "view of both scopes (workspace + user, each under its own heading). Pass " +
    '`scope: "workspace"` or `scope: "user"` to get just one. Use ' +
    "`memory.read(slug, scope?)` to fetch a specific entry's body. Empty scopes " +
    "show a placeholder so callers can distinguish 'not yet written' from 'not " +
    "configured'.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Optional — restrict to one scope. Omit to see both.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const scopeRaw = asString(obj["scope"]);
    const scope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : undefined;
    return renderCombinedList(this.#roots, scope);
  }
}

export class MemoryReadTool implements Tool {
  readonly name = "memory.read";
  readonly category: ToolCategory = "read";
  readonly description =
    "Read a single memory entry by its slug. By default searches workspace " +
    "scope first then falls back to user scope. Pass `scope` to pin a specific " +
    "tree (useful when both scopes have the same slug).";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: {
        type: "string",
        description: "Topic slug — must match `[A-Za-z0-9._-]{1,64}`.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Optional — pin to a scope. Omit for workspace-then-user fallback.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const slug = asString(obj["slug"]);
    if (slug === undefined) {
      throw new Error("missing `slug` argument");
    }
    validateSlug(slug);
    const scopeRaw = asString(obj["scope"]);
    const scope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : undefined;
    const order: MemoryScope[] = scope !== undefined ? [scope] : ["workspace", "user"];
    for (const s of order) {
      let root: string;
      try {
        root = rootFor(this.#roots, s);
      } catch {
        continue;
      }
      const p = entryPath(root, slug);
      try {
        return await fs.readFile(p, "utf8");
      } catch (e) {
        if (isNotFound(e)) {
          continue;
        }
        throw new Error(`read ${p}: ${String(e)}`);
      }
    }
    throw new Error(`no memory entry for slug \`${slug}\` in ${order.length} scope(s)`);
  }
}

export class MemoryWriteTool implements Tool {
  readonly name = "memory.write";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Persist a memory entry. Writes `<scope_root>/.jarvis/memory/<slug>.md` " +
    "with `content` and upserts a `- [<summary>](<slug>.md)` line in MEMORY.md " +
    "so the system prompt picks it up on the next conversation. Re-writing an " +
    "existing slug in the same scope replaces both the body and the index line. " +
    'Scope guidance: `scope: "workspace"` (default) — project-specific facts ' +
    "(architecture decisions, recurring gotchas, conventions this codebase " +
    "enforces); shared with anyone who has access to the repo. " +
    '`scope: "user"` — operator-personal facts (preferences, language/style ' +
    "choices, cross-project habits); follows the user across workspaces. Use " +
    "sparingly — write the kind of fact you'd want to remember across sessions, " +
    "not transient working state.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["slug", "summary", "content"],
    properties: {
      slug: {
        type: "string",
        description: "Stable topic slug — must match `[A-Za-z0-9._-]{1,64}`.",
      },
      summary: {
        type: "string",
        description: "One-line index summary (under ~120 chars).",
      },
      content: {
        type: "string",
        description: "Full body in markdown. Up to 32 KiB.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Where to persist. Defaults to `workspace`.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const slug = asString(obj["slug"]);
    if (slug === undefined) {
      throw new Error("missing `slug` argument");
    }
    const summaryRaw = asString(obj["summary"]);
    if (summaryRaw === undefined) {
      throw new Error("missing `summary` argument");
    }
    const summary = summaryRaw.trim();
    const content = asString(obj["content"]);
    if (content === undefined) {
      throw new Error("missing `content` argument");
    }
    validateSlug(slug);
    if (summary === "") {
      throw new Error("`summary` must not be empty");
    }
    if (summary.includes("\n")) {
      throw new Error("`summary` must be a single line");
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_ENTRY_BYTES) {
      throw new Error(
        `content too large: ${contentBytes} bytes > ${MAX_ENTRY_BYTES} (MAX_ENTRY_BYTES)`,
      );
    }
    const scopeRaw = asString(obj["scope"]);
    const scope: MemoryScope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : "workspace";

    const root = rootFor(this.#roots, scope);
    const entry = entryPath(root, slug);
    await atomicWrite(entry, content);

    const existingIndex = await readIndex(root);
    const newIndex = mergeIndexLine(existingIndex, slug, summary);
    const lineCount = splitLines(newIndex).length;
    if (lineCount > MAX_INDEX_LINES) {
      throw new Error(
        `memory index would exceed ${MAX_INDEX_LINES} lines — delete some entries first`,
      );
    }
    if (Buffer.byteLength(newIndex, "utf8") > MAX_INDEX_BYTES) {
      throw new Error(
        `memory index would exceed ${MAX_INDEX_BYTES} bytes — delete some entries first`,
      );
    }
    await atomicWrite(indexPath(root), newIndex);

    return (
      `wrote ${scope} memory \`${slug}\` (${contentBytes} bytes); ` +
      `index now has ${lineCount} entries`
    );
  }
}

export class MemoryDeleteTool implements Tool {
  readonly name = "memory.delete";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Remove a memory entry. Deletes `<slug>.md` and strips its line from " +
    "MEMORY.md inside the chosen scope (default `workspace`). Returns the number " +
    "of remaining entries in that scope.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["slug"],
    properties: {
      slug: {
        type: "string",
        description: "Slug to forget — must match `[A-Za-z0-9._-]{1,64}`.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Scope to delete from. Defaults to `workspace`.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const slug = asString(obj["slug"]);
    if (slug === undefined) {
      throw new Error("missing `slug` argument");
    }
    validateSlug(slug);
    const scopeRaw = asString(obj["scope"]);
    const scope: MemoryScope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : "workspace";
    const root = rootFor(this.#roots, scope);
    const entry = entryPath(root, slug);
    try {
      await fs.rm(entry);
    } catch (e) {
      if (isNotFound(e)) {
        throw new Error(`no memory entry for slug \`${slug}\` in ${scope} scope`);
      }
      throw new Error(`delete ${entry}: ${String(e)}`);
    }

    const existingIndex = (await readIndex(root)) ?? "";
    const { body: newIndex } = removeIndexLine(existingIndex, slug);
    const index = indexPath(root);
    if (newIndex.trim() === "") {
      // Drop the index file entirely so an empty memory looks empty rather than
      // `MEMORY.md` of zero bytes.
      await fs.rm(index).catch(() => undefined);
    } else {
      await atomicWrite(index, newIndex);
    }
    const remaining = countNonEmptyLines(newIndex);
    return `deleted ${scope} memory \`${slug}\`; ${remaining} entries remain in scope`;
  }
}

// ===========================================================================
// Include directives — parsing / file mutation / resolution
// ===========================================================================

/**
 * One parsed `<!-- jarvis-include: ... -->` line. Stays closer to the wire
 * format than to the on-disk path so the caller can dedup / display the
 * original directive verbatim. Mirrors the Rust `IncludeDirective` enum
 * (erasableSyntaxOnly forbids TS enums — a discriminated union instead).
 */
export type IncludeDirective =
  | { kind: "local_path"; path: string }
  | { kind: "git_url"; url: string; branch?: string };

/** Canonical wire form for round-tripping into MEMORY.md. */
export function directiveAsWire(d: IncludeDirective): string {
  if (d.kind === "local_path") {
    return d.path;
  }
  return d.branch !== undefined ? `git+${d.url}#${d.branch}` : `git+${d.url}`;
}

/** A short, human-readable label for the `=== included from <label> ===`
 * header (kept for parity / consumers; not used by the tools directly). */
export function directiveLabel(d: IncludeDirective): string {
  if (d.kind === "local_path") {
    return d.path;
  }
  return d.branch !== undefined ? `git:${d.url} (${d.branch})` : `git:${d.url}`;
}

function directivesEqual(a: IncludeDirective, b: IncludeDirective): boolean {
  if (a.kind === "local_path" && b.kind === "local_path") {
    return a.path === b.path;
  }
  if (a.kind === "git_url" && b.kind === "git_url") {
    return a.url === b.url && a.branch === b.branch;
  }
  return false;
}

/**
 * Reject git URLs that could lead to command execution or option smuggling
 * before they ever reach `git clone`. Throws on rejection. Mirrors the Rust
 * `validate_git_url`.
 */
export function validateGitUrl(url: string): void {
  const u = url.trim();
  if (u === "") {
    throw new Error("git include URL is empty");
  }
  if (u.startsWith("-")) {
    throw new Error(`git include URL must not start with '-': ${u}`);
  }
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) {
      throw new Error("git include URL contains control characters");
    }
  }
  // Detect git's remote-helper transport syntax `<transport>::<addr>`
  // (e.g. `ext::sh -c id`, `fd::17/foo`). The transport name sits at the very
  // start, contains no '/', and is followed by `::`. A real scheme uses `://`
  // so `https://…` and an IPv6 literal `ssh://[::1]/r` never match (their text
  // before the first `::` contains a '/').
  const p = u.indexOf("::");
  if (p !== -1) {
    const prefix = u.slice(0, p);
    const looksLikeTransport =
      prefix !== "" &&
      !prefix.includes("/") &&
      [...prefix].every((c) => /[A-Za-z0-9]/.test(c) || c === "+" || c === "." || c === "-");
    if (looksLikeTransport) {
      throw new Error(
        `git include URL uses a remote-helper transport (command execution risk): ${u}`,
      );
    }
  }
}

/**
 * Try to parse one target string (whatever sits after `<!-- jarvis-include: `
 * and before ` -->`). Returns `undefined` for empty / dangerous targets.
 */
export function parseIncludeTarget(s: string): IncludeDirective | undefined {
  const trimmed = s.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.startsWith("git+")) {
    const rest = trimmed.slice("git+".length);
    // rsplit_once('#'): split on the LAST '#'. A branch must be non-empty, the
    // url part non-empty, and (per `looks_like_path`, always false) accepted.
    const hashIdx = rest.lastIndexOf("#");
    let url: string;
    let branch: string | undefined;
    if (hashIdx > 0 && hashIdx < rest.length - 1) {
      url = rest.slice(0, hashIdx);
      branch = rest.slice(hashIdx + 1);
    } else {
      url = rest;
      branch = undefined;
    }
    // Reject command-executing transports (ext::/fd::) and option-smuggling
    // URLs at parse time so a malicious directive never reaches clone.
    try {
      validateGitUrl(url);
    } catch {
      return undefined;
    }
    return branch !== undefined ? { kind: "git_url", url, branch } : { kind: "git_url", url };
  }
  return { kind: "local_path", path: trimmed };
}

/**
 * Parse all `<!-- jarvis-include: ... -->` directives from a MEMORY.md text.
 * Empty / malformed directives are silently skipped. Duplicates are kept
 * (caller dedups if desired).
 */
export function parseIncludeDirectives(text: string): IncludeDirective[] {
  const out: IncludeDirective[] = [];
  for (const line of splitLines(text)) {
    const t = line.trim();
    if (t.startsWith("<!-- jarvis-include:")) {
      const rest = t.slice("<!-- jarvis-include:".length);
      if (!rest.endsWith("-->")) {
        continue;
      }
      const inner = rest.slice(0, -"-->".length).trim();
      const d = parseIncludeTarget(inner);
      if (d !== undefined) {
        out.push(d);
      }
    }
  }
  return out;
}

/**
 * Insert (or skip if already present) an include directive at the top of
 * `text`, returning the new file body. Directives go above any non-directive
 * content so they're findable at a glance. Mirrors the Rust `add_include_line`.
 */
export function addIncludeLine(text: string, directive: IncludeDirective): string {
  const line = `<!-- jarvis-include: ${directiveAsWire(directive)} -->`;
  const existing = parseIncludeDirectives(text);
  if (existing.some((d) => directivesEqual(d, directive))) {
    return text;
  }
  const directivesBlock: string[] = [];
  const restLines: string[] = [];
  let hitNonDirective = false;
  for (const l of splitLines(text)) {
    const t = l.trim();
    if (
      !hitNonDirective &&
      (t === "" || (t.startsWith("<!-- jarvis-include:") && t.endsWith("-->")))
    ) {
      if (t.startsWith("<!-- jarvis-include:")) {
        directivesBlock.push(l);
      }
      // empty line at the top is just absorbed
      continue;
    }
    hitNonDirective = true;
    restLines.push(l);
  }
  let out = "";
  for (const d of directivesBlock) {
    out += d + "\n";
  }
  out += line + "\n";
  if (restLines.length > 0) {
    out += "\n";
    out += restLines.join("\n");
    if (text.endsWith("\n") && !out.endsWith("\n")) {
      out += "\n";
    }
  }
  return out;
}

/** Remove the directive whose wire form matches `targetWire`. No-op when not
 * found; returns the modified body. Mirrors the Rust `remove_include_line`. */
export function removeIncludeLine(text: string, targetWire: string): string {
  const needle = `<!-- jarvis-include: ${targetWire} -->`;
  const outLines: string[] = [];
  let removed = false;
  for (const line of splitLines(text)) {
    if (!removed && line.trim() === needle) {
      removed = true;
      continue;
    }
    outLines.push(line);
  }
  let joined = outLines.join("\n");
  if (text.endsWith("\n") && !joined.endsWith("\n")) {
    joined += "\n";
  }
  return joined;
}

/**
 * Expand a leading `~` against the home directory (`os.homedir()`). `~/foo` →
 * `<HOME>/foo`; everything else returned unchanged. The Rust reads `$HOME`
 * directly; we use `os.homedir()` (env-free per convention).
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice("~/".length));
  }
  return p;
}

/** Deterministic per-include cache slug. Branch is folded in so `repo.git` and
 * `repo.git#feature` get separate caches. The Rust uses BLAKE3[..16]; here we
 * use SHA-256 hex truncated to 16 — only stability + branch-awareness matter,
 * never cross-language reproducibility. */
function directiveSlug(url: string, branch?: string): string {
  const h = createHash("sha256");
  h.update(url, "utf8");
  if (branch !== undefined) {
    h.update(Buffer.from([0]));
    h.update(branch, "utf8");
  }
  return h.digest("hex").slice(0, 16);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Inspect `candidate` and return whichever path contains a `MEMORY.md`:
 *   1. `candidate/MEMORY.md` (include points directly at a memory dir)
 *   2. `candidate/.jarvis/memory/MEMORY.md` (include points at a workspace root)
 * Throws with a clear message when neither exists. Mirrors `normalise_memory_dir`.
 */
async function normaliseMemoryDir(candidate: string): Promise<string> {
  if (!(await pathExists(candidate))) {
    throw new Error(`include path not found: ${candidate}`);
  }
  const direct = path.join(candidate, "MEMORY.md");
  if (await isFile(direct)) {
    return candidate;
  }
  const nestedDir = path.join(candidate, MEMORY_DIR);
  const nested = path.join(nestedDir, "MEMORY.md");
  if (await isFile(nested)) {
    return nestedDir;
  }
  throw new Error(
    `include \`${candidate}\` has no MEMORY.md (looked at the directory itself ` +
      `and at .jarvis/memory/ underneath)`,
  );
}

/** Run `git` with the given args; resolve `{ ok, stdout, stderr }`. Rejects on
 * spawn failure / timeout. Prepends the `protocol.*.allow` whitelist guard so
 * command-executing transports can never fire even if a bad URL slipped past
 * validation. The child inherits the parent environment (no `env` override —
 * the env-free convention forbids reading `process.env`). */
function runGit(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...gitProtocolGuardArgs(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("git timed out"));
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`spawn git: ${String(e)}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function gitClone(url: string, branch: string | undefined, dest: string): Promise<void> {
  // Defence in depth: parseIncludeTarget already rejects dangerous URLs, but
  // re-validate so any future caller of gitClone is covered too.
  validateGitUrl(url);
  const args: string[] = ["clone", "--depth", "1"];
  if (branch !== undefined) {
    args.push("--branch", branch);
  }
  // `--` ensures the URL is never parsed as an option.
  args.push("--", url, dest);
  const { ok, stderr } = await runGit(args);
  if (!ok) {
    throw new Error(`git clone failed: ${stderr.trim()}`);
  }
}

/**
 * Resolve an {@link IncludeDirective} into a concrete on-disk path pointing at
 * a memory tree. `cacheRoot` is the directory under which git includes are
 * cached; local includes ignore it. Throws (user-facing) when the target can't
 * be resolved. Mirrors the Rust `resolve_include`.
 */
export async function resolveInclude(
  directive: IncludeDirective,
  cacheRoot: string,
): Promise<string> {
  if (directive.kind === "local_path") {
    return normaliseMemoryDir(expandTilde(directive.path));
  }
  const slug = directiveSlug(directive.url, directive.branch);
  const cacheDir = path.join(cacheRoot, slug);
  if (!(await pathExists(cacheDir))) {
    try {
      await fs.mkdir(cacheRoot, { recursive: true });
    } catch (e) {
      throw new Error(`mkdir ${cacheRoot}: ${String(e)}`);
    }
    await gitClone(directive.url, directive.branch, cacheDir);
  }
  return normaliseMemoryDir(cacheDir);
}

/**
 * Refresh a cached git include: removes the cache dir and re-clones. Used by
 * the explicit `memory.include_refresh` tool; never called automatically.
 * Throws for local-path includes. Mirrors the Rust `refresh_git_cache`.
 */
export async function refreshGitCache(
  directive: IncludeDirective,
  cacheRoot: string,
): Promise<string> {
  if (directive.kind === "local_path") {
    throw new Error("refresh only applies to git+ includes");
  }
  const slug = directiveSlug(directive.url, directive.branch);
  const cacheDir = path.join(cacheRoot, slug);
  if (await pathExists(cacheDir)) {
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`rm ${cacheDir}: ${String(e)}`);
    }
  }
  try {
    await fs.mkdir(cacheRoot, { recursive: true });
  } catch (e) {
    throw new Error(`mkdir ${cacheRoot}: ${String(e)}`);
  }
  await gitClone(directive.url, directive.branch, cacheDir);
  return normaliseMemoryDir(cacheDir);
}

// ---------- include-tool shared helpers ------------------------------------

/**
 * Best-effort include-cache root. The Rust reads `$HOME` (falling back to a
 * tempdir); per the env-free convention we derive it from the configured
 * `userRoot` when present (`<userRoot>/.jarvis/include-cache`), otherwise fall
 * back to a tempdir under `os.tmpdir()`.
 */
function includeCacheRoot(roots: MemoryRoots): string {
  if (roots.userRoot !== undefined) {
    return path.join(roots.userRoot, ".jarvis/include-cache");
  }
  return path.join(os.tmpdir(), "jarvis-include-cache");
}

async function readOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

// ===========================================================================
// memory.include_add / include_list / include_remove / include_refresh
// ===========================================================================

export class MemoryIncludeAddTool implements Tool {
  readonly name = "memory.include_add";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Add an include directive to the scope's MEMORY.md so the system prompt " +
    "also pulls in another memory tree at conversation start. `target` is " +
    "either a filesystem path (absolute or `~/...`) or a `git+<url>[#branch]` " +
    "URL. Git URLs trigger an immediate clone into the local cache so the agent " +
    "learns about auth / URL typos here rather than on next restart.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: {
        type: "string",
        description: "`/abs/path/memory` or `~/path/memory` or `git+https://...[#branch]`",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Which scope's MEMORY.md to modify. Defaults to `workspace`.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const target = asString(obj["target"]);
    if (target === undefined) {
      throw new Error("missing `target` argument");
    }
    const directive = parseIncludeTarget(target);
    if (directive === undefined) {
      throw new Error(`invalid include target \`${target}\``);
    }
    const scopeRaw = asString(obj["scope"]);
    const scope: MemoryScope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : "workspace";
    const root = rootFor(this.#roots, scope);
    const index = indexPath(root);
    const existing = await readOrEmpty(index);
    // Eager validate the directive: for git URLs this triggers the clone; for
    // local paths it confirms the dir + memory layout. We fail BEFORE writing
    // the directive so a broken target doesn't get baked into MEMORY.md.
    const cache = includeCacheRoot(this.#roots);
    await resolveInclude(directive, cache);
    const next = addIncludeLine(existing, directive);
    await atomicWrite(index, next);
    return JSON.stringify({
      ok: true,
      added: directiveAsWire(directive),
      scope,
      memory_md: index,
    });
  }
}

export class MemoryIncludeListTool implements Tool {
  readonly name = "memory.include_list";
  readonly category: ToolCategory = "read";
  readonly description =
    "Return the include directives declared at the top of the scope's MEMORY.md " +
    "plus their resolution status. Each entry reports `target`, `kind` " +
    "(`local_path` | `git_url`), and `resolves` (bool with `error` when false). " +
    "No mutations.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Defaults to `workspace`.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const scopeRaw = asString(obj["scope"]);
    const scope: MemoryScope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : "workspace";
    const root = rootFor(this.#roots, scope);
    const index = indexPath(root);
    const body = await readOrEmpty(index);
    const cache = includeCacheRoot(this.#roots);
    const directives = parseIncludeDirectives(body);
    const items: JsonValue[] = [];
    for (const d of directives) {
      const kind = d.kind === "local_path" ? "local_path" : "git_url";
      try {
        const p = await resolveInclude(d, cache);
        items.push({ target: directiveAsWire(d), kind, resolves: true, path: p });
      } catch (e) {
        items.push({
          target: directiveAsWire(d),
          kind,
          resolves: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return JSON.stringify({ scope, memory_md: index, items });
  }
}

export class MemoryIncludeRemoveTool implements Tool {
  readonly name = "memory.include_remove";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Remove an include directive from the scope's MEMORY.md. `target` is the " +
    "same string used when adding the include (use `memory.include_list` first " +
    "to read the exact form).";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: { type: "string" },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const target = asString(obj["target"]);
    if (target === undefined) {
      throw new Error("missing `target` argument");
    }
    const scopeRaw = asString(obj["scope"]);
    const scope: MemoryScope = scopeRaw !== undefined ? parseScopeArg(scopeRaw) : "workspace";
    const root = rootFor(this.#roots, scope);
    const index = indexPath(root);
    const existing = await readOrEmpty(index);
    const next = removeIncludeLine(existing, target);
    await atomicWrite(index, next);
    return JSON.stringify({ ok: true, removed: target, scope });
  }
}

export class MemoryIncludeRefreshTool implements Tool {
  readonly name = "memory.include_refresh";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Wipe and re-clone the local cache for a `git+...` include. No-op for " +
    "local-path includes (they always read from the source). Use this when a " +
    "team member pushed a new memory entry and you want to pick it up without " +
    "restarting.";
  readonly parameters: JsonValue = {
    type: "object",
    additionalProperties: false,
    required: ["target"],
    properties: {
      target: {
        type: "string",
        description: "The `git+<url>[#branch]` string to refresh.",
      },
    },
  };

  readonly #roots: MemoryRoots;

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const target = asString(obj["target"]);
    if (target === undefined) {
      throw new Error("missing `target` argument");
    }
    const directive = parseIncludeTarget(target);
    if (directive === undefined) {
      throw new Error(`invalid include target \`${target}\``);
    }
    const cache = includeCacheRoot(this.#roots);
    const resolved = await refreshGitCache(directive, cache);
    return JSON.stringify({ ok: true, target: directiveAsWire(directive), cache_path: resolved });
  }
}

// ===========================================================================
// registration helper
// ===========================================================================

/**
 * Construct and register the `memory.*` markdown-memory tool family into
 * `registry`: `memory.{list,read,write,delete}` plus the include-directive
 * tools `memory.{include_add,include_list,include_remove,include_refresh}`.
 *
 * The mutating tools (`write` / `delete` / `include_add` / `include_remove` /
 * `include_refresh`) are approval-gated; `list` / `read` / `include_list` are
 * read-only.
 */
export function registerMemoryTools(registry: ToolRegistry, config: MemoryToolsConfig): void {
  const roots: MemoryRoots = config.userRoot !== undefined
    ? { workspaceRoot: config.workspaceRoot, userRoot: config.userRoot }
    : { workspaceRoot: config.workspaceRoot };
  registry.register(new MemoryListTool(roots));
  registry.register(new MemoryReadTool(roots));
  registry.register(new MemoryWriteTool(roots));
  registry.register(new MemoryDeleteTool(roots));
  registry.register(new MemoryIncludeAddTool(roots));
  registry.register(new MemoryIncludeListTool(roots));
  registry.register(new MemoryIncludeRemoveTool(roots));
  registry.register(new MemoryIncludeRefreshTool(roots));
}
