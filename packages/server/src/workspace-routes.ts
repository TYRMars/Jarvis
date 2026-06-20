// Read-only workspace inspection endpoints. Ported (the read-only subset) from
// three Rust modules:
//
//   - crates/harness-server/src/workspace_files.rs  → GET /v1/workspace/list
//                                                       GET /v1/workspace/read
//   - crates/harness-server/src/workspace_find.rs   → GET /v1/workspace/find
//   - crates/harness-server/src/workspace_diff.rs   → GET /v1/workspace/diff
//                                                       GET /v1/workspace/diff/file
//
// All five are read-only: filesystem listing/reading and `git -C <root> ...`
// invocations. No write, no approval gate. Every git call shells out via
// node:child_process execFile (NOT a shell — fixed argv, no interpolation),
// mirroring the worktree.ts discipline already in this package.
//
// Sandboxing: each request resolves a workspace root from `?root=<abs>`
// (per-request override) falling back to AppState.workspaceRoot. The override
// must be absolute, NUL/newline/CR-free, and resolve to an existing directory;
// anything else → 400. When BOTH the override and the pinned root are absent →
// 503 (matching the Rust `resolve_workspace`). Relative `dir`/`path` params are
// rejected if they are absolute or contain `..` (the same policy the `fs.*`
// agent tools enforce via `resolve_under`). Branch names are validated against
// shell/flag-injection before reaching git.
//
// DEFERRED (intentionally not ported here):
//   - POST /v1/workspace/commit, GET /v1/workspace/pr/preview, POST /v1/workspace/pr
//     — these mutate the repo / touch the network (`git add`/`commit`/`push`,
//       `gh pr create`). They live in workspace_diff.rs alongside the read-only
//       diff endpoints but are out of scope for this read-only port. See the
//       module footer note.
//   - WS /v1/workspace/terminal (PTY) — needs a pseudo-terminal subsystem not on
//       AppState; deferred.
//   - The persisted /v1/workspaces recent-workspace registry (WorkspaceStore) —
//       no store on AppState yet. `find` therefore relies only on the on-disk
//       walk; once a WorkspaceStore lands it would augment the candidate list.
import { execFile } from "node:child_process";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppState } from "./state.ts";

// ---------------------------------------------------------------------------
// Tunables (mirror the Rust consts)
// ---------------------------------------------------------------------------

/** Hard cap on a single file read (workspace_files.rs MAX_READ_BYTES). */
const MAX_READ_BYTES = 1024 * 1024;
/** Leading-window size for the NUL-byte binary sniff (BINARY_SNIFF_BYTES). */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Cap on entries returned by one directory listing (MAX_ENTRIES_PER_DIR). */
const MAX_ENTRIES_PER_DIR = 2000;

/** `find` walker depth bound (workspace_find.rs MAX_DEPTH). */
const FIND_MAX_DEPTH = 2;
/** `find` result-list cap (MAX_RESULTS). */
const FIND_MAX_RESULTS = 10;
/** `find` global wall-clock budget in ms (GLOBAL_BUDGET = 1.5s). */
const FIND_GLOBAL_BUDGET_MS = 1500;
/** Names skipped mid-walk (huge or system/app-private) (SKIP_NAMES). */
const FIND_SKIP_NAMES = new Set<string>([
  "node_modules",
  "target",
  "build",
  "dist",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Applications",
]);

/** Default base branch for diffs (workspace_diff.rs DEFAULT_BASE). */
const DEFAULT_BASE = "main";
/** Hard cap on a single per-file diff (MAX_FILE_DIFF_BYTES). */
const MAX_FILE_DIFF_BYTES = 1024 * 1024;
/** Wall-clock cap on a read-only git invocation in ms (GIT_TIMEOUT = 20s). */
const GIT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function badRequest(reply: FastifyReply, msg: string): FastifyReply {
  return reply.code(400).send({ error: msg });
}

function serverError(reply: FastifyReply, msg: string): FastifyReply {
  return reply.code(500).send({ error: msg });
}

// ---------------------------------------------------------------------------
// Workspace-root resolution + sandbox validators
// ---------------------------------------------------------------------------

/** Discriminated result from `resolveWorkspace`. */
type ResolveResult = { ok: true; root: string } | { ok: false };

/**
 * Resolve the workspace root for one request. A `?root=<abs>` override wins over
 * `AppState.workspaceRoot`; it must be absolute, NUL/newline/CR-free, and
 * `realpath` to an existing directory (anything else → 400, already sent). When
 * both the override and the pinned root are absent → 503 (already sent). On
 * success returns the canonical root. Mirrors Rust `resolve_workspace`.
 */
async function resolveWorkspace(
  state: AppState,
  reply: FastifyReply,
  overrideRoot: string | undefined,
): Promise<ResolveResult> {
  if (overrideRoot !== undefined) {
    const trimmed = overrideRoot.trim();
    if (trimmed === "") {
      badRequest(reply, "`root` must not be empty");
      return { ok: false };
    }
    if (/[\0\n\r]/.test(trimmed)) {
      badRequest(reply, "`root` contains forbidden characters");
      return { ok: false };
    }
    if (!isAbsolute(trimmed)) {
      badRequest(reply, "`root` must be an absolute path");
      return { ok: false };
    }
    let canonical: string;
    try {
      canonical = await realpath(trimmed);
    } catch (e) {
      badRequest(reply, `\`root\` does not resolve: ${errMsg(e)}`);
      return { ok: false };
    }
    let isDir = false;
    try {
      isDir = (await stat(canonical)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      badRequest(reply, "`root` is not a directory");
      return { ok: false };
    }
    return { ok: true, root: canonical };
  }
  if (state.workspaceRoot) {
    return { ok: true, root: state.workspaceRoot };
  }
  reply.code(503).send({ error: "workspace root not configured" });
  return { ok: false };
}

/**
 * Reject path traversal / absolute paths the same way the `fs.*` tools do.
 * Empty input is allowed here (means "the root itself"); the caller decides
 * whether empty is meaningful. Mirrors Rust `safe_relative`.
 */
function safeRelative(rel: string): { ok: true; value: string } | { ok: false; error: string } {
  if (rel.startsWith("/")) {
    return { ok: false, error: "path must be relative to the workspace root" };
  }
  if (/[\0\n]/.test(rel)) {
    return { ok: false, error: "path contains forbidden characters" };
  }
  // Component scan: reject `..` and any absolute/root component. Splitting on
  // both separators keeps the check honest on Windows-style inputs too.
  for (const comp of rel.split(/[/\\]/)) {
    if (comp === "..") {
      return { ok: false, error: "path must not contain `..`" };
    }
  }
  if (isAbsolute(rel)) {
    return { ok: false, error: "absolute path components are not allowed" };
  }
  return { ok: true, value: rel };
}

/**
 * Validate a git path argument (workspace_diff.rs `safe_relative_path`). Unlike
 * `safeRelative` this one rejects empty input and a leading `-` (so the path
 * can't be mistaken for a flag), since git would consume it positionally.
 */
function safeRelativePath(path: string): { ok: true; value: string } | { ok: false; error: string } {
  if (path === "") return { ok: false, error: "path must not be empty" };
  if (path.startsWith("/")) return { ok: false, error: "path must be relative to the workspace root" };
  if (path.startsWith("-")) return { ok: false, error: "path must not start with `-`" };
  if (/[\0\n]/.test(path)) return { ok: false, error: "path contains forbidden characters" };
  for (const comp of path.split("/")) {
    if (comp === "..") return { ok: false, error: "path must not contain `..`" };
  }
  return { ok: true, value: path };
}

/**
 * Reject anything that could break out of `git -C <root> ...`. Mirrors Rust
 * `safe_branch`.
 */
function safeBranch(name: string): { ok: true; value: string } | { ok: false; error: string } {
  if (name === "") return { ok: false, error: "branch name must not be empty" };
  if (name.startsWith("-")) return { ok: false, error: "branch name must not start with `-`" };
  if (/[\0\n \t;&|`$]/.test(name)) {
    return { ok: false, error: "branch name contains forbidden characters" };
  }
  return { ok: true, value: name };
}

// ---------------------------------------------------------------------------
// git subprocess (execFile, no shell)
// ---------------------------------------------------------------------------

/**
 * Run `git -C <root> <args...>` with stdin closed and no shell. Resolves with
 * the captured stdout on a clean exit; rejects with the trimmed stderr (or a
 * timeout / spawn message) otherwise — mirroring Rust `run_git`'s
 * `Result<String, String>`. `kill_on_drop` is approximated by execFile's
 * `timeout`, which sends SIGTERM after the budget.
 */
function runGit(root: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { timeout: timeoutMs, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout as unknown as Buffer;
        const errBuf = stderr as unknown as Buffer;
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.killed || e.signal === "SIGTERM") {
            reject(new Error(`git timed out after ${timeoutMs}ms`));
            return;
          }
          // Spawn failure (ENOENT etc.) surfaces `code` as a string.
          if (typeof e.code === "string") {
            reject(new Error(`spawn git: ${e.message}`));
            return;
          }
          const stderrStr = errBuf.toString("utf8");
          reject(new Error(stderrStr.trim() === "" ? `git exited with status ${e.code ?? "?"}` : stderrStr));
          return;
        }
        resolve(out.toString("utf8"));
      },
    );
  });
}

/** `run_git(...).ok()` — resolve to the stdout or undefined, never throws. */
async function runGitOk(root: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(root, args);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort: does the requested base ref resolve to a commit? Lets fresh repos
 * / detached HEAD degrade gracefully instead of 500ing. Mirrors `base_exists`.
 */
async function baseExists(root: string, base: string): Promise<boolean> {
  return (await runGitOk(root, ["rev-parse", "--verify", `${base}^{commit}`])) !== undefined;
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/list
// ---------------------------------------------------------------------------

interface Entry {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  size?: number;
  mtime?: string;
}

async function handleList(state: AppState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const q = req.query as { root?: string; dir?: string };
  const resolved = await resolveWorkspace(state, reply, q.root);
  if (!resolved.ok) return reply;
  const root = resolved.root;

  const dirRel = q.dir ?? "";
  const safe = safeRelative(dirRel);
  if (!safe.ok) return badRequest(reply, safe.error);

  const target = safe.value === "" ? root : join(root, safe.value);

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (e) {
    return serverError(reply, `read_dir(${target}): ${errMsg(e)}`);
  }

  const entries: Entry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES_PER_DIR) {
      truncated = true;
      break;
    }
    const name = dirent.name;
    // Hide `.git` only at the root so the user doesn't waste clicks on it.
    if (safe.value === "" && name === ".git") continue;

    // Classify without following symlinks: a Dirent already reflects
    // symlink_metadata (readdir does not follow). Stat the entry for
    // size/mtime; on failure skip it (matches the Rust `continue`).
    let kind: Entry["kind"];
    if (dirent.isSymbolicLink()) kind = "symlink";
    else if (dirent.isDirectory()) kind = "dir";
    else if (dirent.isFile()) kind = "file";
    else kind = "other";

    let size: number | undefined;
    let mtime: string | undefined;
    try {
      // Rust uses `next.metadata()` here, which follows the entry; size is
      // reported only for plain files, mtime for everything stat succeeds on.
      const meta = await stat(join(target, name));
      size = kind === "file" ? meta.size : undefined;
      mtime = meta.mtime.toISOString();
    } catch {
      // Could not stat (broken symlink etc.) — Rust `continue`s past these.
      continue;
    }
    entries.push({ name, kind, size, mtime });
  }

  // Sort: directories first, then case-insensitive alphabetical.
  entries.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const parent = safe.value === "" ? null : parentRel(safe.value);

  return reply.send({
    root,
    dir: safe.value,
    parent,
    entries,
    truncated,
  });
}

/** Posix-style parent of a relative dir, or "" when it has none. */
function parentRel(rel: string): string | null {
  const idx = rel.replace(/\/+$/, "").lastIndexOf("/");
  if (idx < 0) return "";
  return rel.slice(0, idx);
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/read
// ---------------------------------------------------------------------------

async function handleRead(state: AppState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const q = req.query as { root?: string; path?: string };
  const resolved = await resolveWorkspace(state, reply, q.root);
  if (!resolved.ok) return reply;
  const root = resolved.root;

  const rawPath = q.path ?? "";
  const safe = safeRelative(rawPath);
  if (!safe.ok) return badRequest(reply, safe.error);
  if (safe.value === "") return badRequest(reply, "path must not be empty");

  const target = join(root, safe.value);

  let meta: import("node:fs").Stats;
  try {
    meta = await stat(target);
  } catch (e) {
    return serverError(reply, `stat(${target}): ${errMsg(e)}`);
  }
  if (meta.isDirectory()) {
    return badRequest(reply, "path is a directory; use /v1/workspace/list");
  }
  const size = meta.size;

  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (e) {
    return serverError(reply, `read(${target}): ${errMsg(e)}`);
  }

  const sniffEnd = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  const binary = bytes.subarray(0, sniffEnd).includes(0);
  if (binary) {
    return reply.send({ path: safe.value, size, binary: true, truncated: false, content: "" });
  }

  const truncated = bytes.length > MAX_READ_BYTES;
  const slice = truncated ? bytes.subarray(0, MAX_READ_BYTES) : bytes;
  let content = slice.toString("utf8");
  if (truncated) {
    content += "\n[... truncated; file larger than read cap ...]\n";
  }
  return reply.send({ path: safe.value, size, binary: false, truncated, content });
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/find
// ---------------------------------------------------------------------------

async function handleFind(_state: AppState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const q = req.query as { name?: string };
  const needle = (q.name ?? "").trim();
  if (needle === "") return badRequest(reply, "name parameter is required");
  // Defence in depth: showDirectoryPicker() yields a basename only.
  if (needle.includes("/") || needle.includes("\\") || needle === "." || needle === "..") {
    return badRequest(reply, "name must be a basename, not a path");
  }

  const home = homedir();
  if (!home) {
    // Without a home dir we can't build any search roots — empty, not 500.
    return reply.send({ candidates: [] });
  }

  // NOTE: the persisted recent-workspace registry augmentation (Rust step 2) is
  // deferred — no WorkspaceStore on AppState. We return only the on-disk walk.
  const candidates = await resolveCandidates(home, needle);
  return reply.send({ candidates });
}

/** Search roots under $HOME, priority order (workspace_find.rs `search_roots`). */
function searchRoots(home: string): string[] {
  return [
    "Documents/GitHub",
    "Documents/Code",
    "code",
    "Code",
    "Projects",
    "projects",
    "dev",
    "Desktop",
    "work",
  ].map((seg) => join(home, seg));
}

/**
 * Walk every search root under $HOME and collect dirs whose basename equals
 * `needle`. A shared wall-clock budget runs across all roots. Mirrors
 * `resolve_candidates` + `walk`. Async (node has no cheap sync recursive walk),
 * but the budget keeps it bounded.
 */
async function resolveCandidates(home: string, needle: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + FIND_GLOBAL_BUDGET_MS;
  for (const root of searchRoots(home)) {
    if (Date.now() > deadline) break;
    let isDir = false;
    try {
      isDir = (await stat(root)).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    await walk(root, needle, 0, out, seen, deadline);
    if (out.length >= FIND_MAX_RESULTS) break;
  }
  return out;
}

async function walk(
  dir: string,
  needle: string,
  depth: number,
  out: string[],
  seen: Set<string>,
  deadline: number,
): Promise<void> {
  if (out.length >= FIND_MAX_RESULTS || depth > FIND_MAX_DEPTH) return;
  if (Date.now() > deadline) return;
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= FIND_MAX_RESULTS) return;
    if (Date.now() > deadline) return;
    const name = dirent.name;
    if (name.startsWith(".")) continue; // .git / .cache / .Trash …
    if (FIND_SKIP_NAMES.has(name)) continue;
    const full = join(dir, name);
    // `is_dir()` follows symlinks (we want ~/code -> /Volumes/SSD/code) — stat,
    // not the dirent's lstat-based flags.
    let isDir = false;
    try {
      isDir = (await stat(full)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (name === needle) {
      const canonical = await canonicalPath(full);
      if (canonical !== undefined && !seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
    await walk(full, needle, depth + 1, out, seen, deadline);
  }
}

/** Canonicalise a path; undefined when it doesn't resolve (broken symlink). */
async function canonicalPath(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/diff
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string;
  status: string;
  added: number;
  removed: number;
  old_path?: string;
}

async function handleDiff(state: AppState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const q = req.query as { base?: string; root?: string };
  const resolved = await resolveWorkspace(state, reply, q.root);
  if (!resolved.ok) return reply;
  const root = resolved.root;

  const baseCheck = safeBranch(q.base ?? DEFAULT_BASE);
  if (!baseCheck.ok) return badRequest(reply, baseCheck.error);
  const base = baseCheck.value;

  const branch = filterBranch(await runGitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const head = filterNonEmpty(await runGitOk(root, ["rev-parse", "--short", "HEAD"]));

  if (!(await baseExists(root, base))) {
    return reply.send({
      branch,
      base,
      base_exists: false,
      head,
      ahead: 0,
      behind: 0,
      stat: { added: 0, removed: 0, files: 0 },
      files: [],
      uncommitted: await uncommittedSummary(root),
    });
  }

  const lr = await runGitOk(root, ["rev-list", "--left-right", "--count", `${base}...HEAD`]);
  const [ahead, behind] = lr !== undefined ? parseLeftRight(lr) : [0, 0];

  const numstatRaw = await runGitOk(root, ["diff", "--numstat", `${base}...HEAD`]);
  if (numstatRaw === undefined) {
    return serverError(reply, `git diff --numstat ${base}...HEAD failed`);
  }
  const files = parseNumstat(numstatRaw);
  const nameStatus = (await runGitOk(root, ["diff", "--name-status", `${base}...HEAD`])) ?? "";
  applyNameStatus(files, nameStatus);

  return reply.send({
    branch,
    base,
    base_exists: true,
    head,
    ahead,
    behind,
    stat: aggregateStat(files),
    files,
    uncommitted: await uncommittedSummary(root),
  });
}

function filterBranch(raw: string | undefined): string | null {
  const s = raw?.trim() ?? "";
  return s !== "" && s !== "HEAD" ? s : null;
}
function filterNonEmpty(raw: string | undefined): string | null {
  const s = raw?.trim() ?? "";
  return s !== "" ? s : null;
}

/** `<left-only>\t<right-only>` = behind \t ahead → returns [ahead, behind]. */
function parseLeftRight(s: string): [number, number] {
  const parts = s.split(/\s+/).filter((x) => x !== "");
  const behind = Number.parseInt(parts[0] ?? "0", 10);
  const ahead = Number.parseInt(parts[1] ?? "0", 10);
  return [Number.isFinite(ahead) ? ahead : 0, Number.isFinite(behind) ? behind : 0];
}

function parseNumstat(raw: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    // splitn(3, '\t')
    const tab1 = line.indexOf("\t");
    if (tab1 < 0) continue;
    const tab2 = line.indexOf("\t", tab1 + 1);
    const addedRaw = line.slice(0, tab1);
    const removedRaw = tab2 < 0 ? line.slice(tab1 + 1) : line.slice(tab1 + 1, tab2);
    const pathRaw = (tab2 < 0 ? "" : line.slice(tab2 + 1)).trim();
    if (pathRaw === "") continue;
    const added = addedRaw === "-" ? 0 : toU64(addedRaw);
    const removed = removedRaw === "-" ? 0 : toU64(removedRaw);
    out.push({ path: normaliseRenamedPath(pathRaw), status: "M", added, removed });
  }
  return out;
}

function toU64(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** `dir/{old => new}` → `dir/new`; plain `old => new` → `new`. */
function normaliseRenamedPath(raw: string): string {
  const open = raw.indexOf("{");
  const close = raw.indexOf("}");
  if (open >= 0 && close >= 0 && open < close) {
    const arrow = raw.slice(open, close).indexOf(" => ");
    if (arrow >= 0) {
      const prefix = raw.slice(0, open);
      const newPart = raw.slice(open + arrow + 4, close);
      const suffix = raw.slice(close + 1);
      return `${prefix}${newPart}${suffix}`;
    }
  }
  const arrow = raw.indexOf(" => ");
  if (arrow >= 0) return raw.slice(arrow + 4);
  return raw;
}

function applyNameStatus(files: FileEntry[], nameStatus: string): void {
  const byPath = new Map<string, { status: string; old?: string }>();
  for (const line of nameStatus.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    if (rawStatus === "") continue;
    const kind = rawStatus.charAt(0) || "?";
    if (kind === "R" || kind === "C") {
      const old = (parts[1] ?? "").trim();
      const next = (parts[2] ?? "").trim();
      if (next !== "") byPath.set(next, { status: kind, old });
    } else {
      const p = (parts[1] ?? "").trim();
      if (p !== "") byPath.set(p, { status: kind });
    }
  }
  for (const f of files) {
    const hit = byPath.get(f.path);
    if (hit) {
      f.status = hit.status;
      if (hit.old !== undefined) f.old_path = hit.old;
    }
  }
}

function aggregateStat(files: FileEntry[]): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed, files: files.length };
}

/**
 * Working-tree diff summary (HEAD vs unstaged+staged) plus a per-file list and
 * untracked entries (status `?`). Mirrors `uncommitted_summary`.
 */
async function uncommittedSummary(root: string): Promise<{
  added: number;
  removed: number;
  files: number;
  entries: FileEntry[];
}> {
  const byPath = new Map<string, FileEntry>();

  const numstat = await runGitOk(root, ["diff", "--numstat", "HEAD"]);
  if (numstat !== undefined) {
    for (const entry of parseNumstat(numstat)) byPath.set(entry.path, entry);
  }
  const nameStatus = await runGitOk(root, ["diff", "--name-status", "HEAD"]);
  if (nameStatus !== undefined) {
    const tmp = [...byPath.values()];
    applyNameStatus(tmp, nameStatus);
    for (const entry of tmp) byPath.set(entry.path, entry);
  }

  const untracked = await runGitOk(root, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked !== undefined) {
    for (const line of untracked.split("\n")) {
      const path = line.trim();
      if (path === "" || byPath.has(path)) continue;
      let added = 0;
      try {
        const text = await readFile(join(root, path), "utf8");
        added = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      } catch {
        added = 0; // unreadable / binary
      }
      byPath.set(path, { path, status: "?", added, removed: 0 });
    }
  }

  const files = [...byPath.values()];
  files.sort((a, b) => {
    const aw = a.added + a.removed;
    const bw = b.added + b.removed;
    if (bw !== aw) return bw - aw;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  return { added, removed, files: files.length, entries: files };
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/diff/file
// ---------------------------------------------------------------------------

/** Mirror Rust `truthy`: bare/“1”/“yes”/“on”/anything is true; falsy set false. */
function truthy(s: string | undefined): boolean {
  if (s === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(s.trim().toLowerCase());
}

async function handleDiffFile(state: AppState, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const q = req.query as { base?: string; path?: string; root?: string; uncommitted?: string };
  const resolved = await resolveWorkspace(state, reply, q.root);
  if (!resolved.ok) return reply;
  const root = resolved.root;

  const baseCheck = safeBranch(q.base ?? DEFAULT_BASE);
  if (!baseCheck.ok) return badRequest(reply, baseCheck.error);
  const base = baseCheck.value;

  const pathCheck = safeRelativePath(q.path ?? "");
  if (!pathCheck.ok) return badRequest(reply, pathCheck.error);
  const path = pathCheck.value;

  let diff: string;
  if (truthy(q.uncommitted)) {
    // Working-tree delta. `git diff HEAD -- <path>` first; fall back to
    // `--no-index /dev/null <path>` for untracked/fresh files (exits 1 on a
    // diff → Err in our wrapper, so we tolerate that as an empty fallback).
    const primary = await runGitOk(root, ["diff", "HEAD", "--", path]);
    if (primary !== undefined && primary.trim() !== "") {
      diff = primary;
    } else {
      diff = (await runGitOk(root, ["diff", "--no-index", "--", "/dev/null", path])) ?? "";
    }
  } else {
    const committed = await runGitOk(root, ["diff", `${base}...HEAD`, "--", path]);
    if (committed === undefined) {
      return serverError(reply, `git diff ${base}...HEAD -- ${path} failed`);
    }
    diff = committed;
  }

  if (Buffer.byteLength(diff, "utf8") > MAX_FILE_DIFF_BYTES) {
    // Truncate at a line boundary so the diff renderer doesn't choke on a
    // half-hunk. Byte-accurate slice via Buffer to mirror the Rust byte cap.
    const buf = Buffer.from(diff, "utf8").subarray(0, MAX_FILE_DIFF_BYTES);
    let cut = buf.lastIndexOf(0x0a); // last '\n'
    if (cut < 0) cut = buf.length;
    diff = buf.subarray(0, cut).toString("utf8");
    diff += "\n[... diff truncated; open the file directly to see the rest ...]\n";
  }

  return reply.send({ base, path, diff });
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the read-only workspace inspection routes. Every handler resolves a
 * workspace root (override or pinned); when neither is present it 503s. The
 * mutating commit / PR endpoints and the terminal PTY are intentionally NOT
 * registered here (see module header).
 */
/**
 * Live git snapshot of a workspace root: VCS kind + branch/HEAD/dirty. Mirrors
 * Rust `workspace_snapshot`. Non-git roots return `{ root, vcs: "none" }`.
 */
async function gitSnapshot(
  root: string,
): Promise<{ root: string; vcs: "git" | "none"; branch?: string | null; head?: string | null; dirty?: boolean }> {
  const inside = (await runGitOk(root, ["rev-parse", "--is-inside-work-tree"]))?.trim();
  if (inside !== "true") return { root, vcs: "none" };
  const branch = filterBranch(await runGitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const head = filterNonEmpty(await runGitOk(root, ["rev-parse", "--short", "HEAD"]));
  const porcelain = await runGitOk(root, ["status", "--porcelain"]);
  const dirty = porcelain !== undefined && porcelain.trim() !== "";
  return { root, vcs: "git", branch, head, dirty };
}

/** `GET /v1/workspace` — live git state of the pinned workspace root. */
async function handleWorkspace(
  state: AppState,
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const resolved = await resolveWorkspace(state, reply, undefined);
  if (!resolved.ok) return reply;
  return reply.send(await gitSnapshot(resolved.root));
}

/** `GET /v1/workspace/probe?path=<abs>` — inspect a candidate folder. */
async function handleWorkspaceProbe(
  state: AppState,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const q = (req.query ?? {}) as { path?: string };
  if (q.path === undefined || q.path.trim() === "") return badRequest(reply, "`path` is required");
  const resolved = await resolveWorkspace(state, reply, q.path);
  if (!resolved.ok) return reply;
  return reply.send(await gitSnapshot(resolved.root));
}

export function registerWorkspaceRoutes(app: FastifyInstance, state: AppState): void {
  app.get("/v1/workspace", (req, reply) => handleWorkspace(state, req, reply));
  app.get("/v1/workspace/probe", (req, reply) => handleWorkspaceProbe(state, req, reply));
  app.get("/v1/workspace/list", (req, reply) => handleList(state, req, reply));
  app.get("/v1/workspace/read", (req, reply) => handleRead(state, req, reply));
  app.get("/v1/workspace/find", (req, reply) => handleFind(state, req, reply));
  app.get("/v1/workspace/diff", (req, reply) => handleDiff(state, req, reply));
  app.get("/v1/workspace/diff/file", (req, reply) => handleDiffFile(state, req, reply));
}
