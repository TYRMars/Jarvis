// Per-run / per-unit git worktree helper.
//
// Ported from crates/harness-server/src/worktree.rs.
//
// When the workspace is a git repo and the worktree mode is not `off`, the
// scheduler mints a fresh worktree under `<worktree_root>/<id>` so a run can
// mutate files / commit / install deps without trashing the user's main
// checkout. The path is stamped onto the run; verification commands route their
// cwd through it.
//
// Modes (mirrors `JARVIS_WORKTREE_MODE`):
//   - "off"      — no worktree minting; runs share the main checkout.
//   - "per_run"  — one worktree per RequirementRun (`<root>/<run_id>`), torn
//                  down when the run is deleted.
//   - "per_unit" — one worktree per requirement, reused across runs.
//
// Auto mode upgrades `off` → `per_run` (see `effectiveAutoMode`) so the
// scheduler never mutates the main checkout.
//
// ## Why shell out to `git`?
//
// We already do this for git.status / git.diff etc. in `@jarvis/tools`. Adding
// a libgit2-style dependency just for `git worktree add` is heavy for the value.
// The downside is parsing `git worktree list --porcelain` for the orphan
// detector — manageable.
//
// ## Safety
//
// - `createWorktree` refuses if the main checkout is dirty (`requireClean`,
//   default true). Set `JARVIS_WORKTREE_ALLOW_DIRTY=1` (handled in the caller)
//   to flip it. Refusing to create a worktree off a dirty checkout matches the
//   proposal's "create blocks the run" rule.
// - `removeWorktree` only ever deletes paths inside `worktreeRoot`; an absolute
//   path outside that scope is rejected. This stops a malicious / buggy run from
//   passing `/Users/me` and having `git worktree remove --force` wipe it.
//
// Subprocesses use node:child_process execFile (NOT a shell), with `git` as the
// program and a fixed argv. No string interpolation reaches a shell.
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Default worktree root, relative to the repo. Mirrors `JARVIS_WORKTREE_ROOT`. */
export const DEFAULT_WORKTREE_ROOT = ".jarvis/worktrees";

/**
 * Mode for the worktree subsystem. Mirrors `JARVIS_WORKTREE_MODE`. Defaults to
 * `"off"` to preserve historical behaviour (runs share the main checkout).
 */
export type WorktreeMode = "off" | "per_run" | "per_unit";

/**
 * Parse the env-var wire form. Returns `undefined` for unknown values so the
 * binary's startup never fails on `JARVIS_WORKTREE_MODE=garbage` — the operator
 * gets a warning from the caller instead. Empty / missing maps to `"off"`.
 */
export function worktreeModeFromWire(s: string): WorktreeMode | undefined {
  switch (s.trim()) {
    case "":
    case "off":
      return "off";
    case "per_run":
      return "per_run";
    case "per_unit":
      return "per_unit";
    default:
      return undefined;
  }
}

/**
 * Auto mode upgrades `off` → `per_run` so the scheduler never mutates the main
 * checkout. Any explicit mode is passed through unchanged.
 */
export function effectiveAutoMode(mode: WorktreeMode): WorktreeMode {
  return mode === "off" ? "per_run" : mode;
}

/**
 * Outcome of a `git worktree add` attempt. `kind: "created"` carries the
 * absolute worktree path; `kind: "refused"` carries a human-readable reason
 * (used by the caller to log + continue without a worktree, not as a hard
 * error).
 */
export type WorktreeOutcome =
  | { kind: "created"; path: string }
  | { kind: "refused"; reason: string };

function created(path: string): WorktreeOutcome {
  return { kind: "created", path };
}

function refused(reason: string): WorktreeOutcome {
  return { kind: "refused", reason };
}

/** Result of a finished git subprocess: exit code (or null on signal) + buffers. */
interface GitResult {
  code: number | null;
  spawnError?: Error;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Spawn `git -C <repo> <args...>` with stdin closed and no shell. Resolves with
 * the captured output; never rejects — a failure to spawn (e.g. git not on
 * PATH) is reported via `spawnError` so callers can fold it into a `refused`.
 */
function runGit(repo: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repo, ...args],
      { timeout: timeoutMs, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout as unknown as Buffer;
        const errBuf = stderr as unknown as Buffer;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          // Spawn failure (ENOENT etc.) surfaces `code` as a string.
          if (typeof e.code === "string") {
            resolve({ code: null, spawnError: new Error(e.message), stdout: out, stderr: errBuf });
            return;
          }
          resolve({
            code: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: errBuf,
          });
          return;
        }
        resolve({ code: 0, stdout: out, stderr: errBuf });
      },
    );
  });
}

/** Cheap probe: is `path` inside a git repo? */
export async function isGitRepo(path: string): Promise<boolean> {
  const r = await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.toString("utf8").trim() === "true";
}

/**
 * `true` when `git status --porcelain` is empty (no staged, unstaged, or
 * untracked changes). Used as the safety gate for `createWorktree` — minting a
 * worktree off a dirty main checkout would silently bring those uncommitted
 * edits into the new tree, which is surprising.
 */
export async function isCleanCheckout(path: string): Promise<boolean> {
  const r = await runGit(path, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.length === 0;
}

/**
 * Mint a worktree at `<worktreeRoot>/<runId>` from `repo`'s HEAD (detached).
 *
 * - Creates `worktreeRoot` if it doesn't exist.
 * - Refuses if `repo` isn't a git repo, or if `requireClean` is set and the
 *   checkout is dirty.
 * - Refuses if a worktree already exists at the target path — the caller can
 *   either reuse or pick a new id.
 *
 * Returns the absolute path on success; the caller stamps it onto the run.
 */
export async function createWorktree(
  repo: string,
  worktreeRoot: string,
  runId: string,
  requireClean: boolean,
): Promise<WorktreeOutcome> {
  if (!(await isGitRepo(repo))) {
    return refused(`workspace \`${repo}\` is not a git repo`);
  }
  if (requireClean && !(await isCleanCheckout(repo))) {
    return refused(
      `workspace \`${repo}\` has uncommitted changes; commit/stash or set ` +
        `JARVIS_WORKTREE_ALLOW_DIRTY=1 to override`,
    );
  }
  try {
    await mkdir(worktreeRoot, { recursive: true });
  } catch (e) {
    return refused(`failed to create worktree root \`${worktreeRoot}\`: ${errMsg(e)}`);
  }
  const target = join(worktreeRoot, runId);
  if (existsSync(target)) {
    return refused(`worktree path already exists: \`${target}\``);
  }
  const r = await runGit(repo, ["worktree", "add", "--detach", target]);
  if (r.spawnError) {
    return refused(`git worktree add: spawn failed: ${r.spawnError.message}`);
  }
  if (r.code === 0) {
    return created(target);
  }
  return refused(`git worktree add failed: ${r.stderr.toString("utf8").trim()}`);
}

/**
 * Mint a worktree at `target` checked out to `branch`.
 *
 * Differs from `createWorktree` in three ways:
 *  1. The caller picks the absolute target path (not `<root>/<runId>`), so the
 *     HTTP layer can derive a human-readable folder name from the branch.
 *  2. The new tree is checked out to `branch`, not detached at HEAD — matches
 *     the user's "use this branch" intent.
 *  3. The clean check is opt-out (`requireClean=false` lets the caller bypass
 *     it; the auto-loop scheduler should keep its safety gate by passing
 *     `true`, but an interactive workspace switch may pass `false`).
 *
 * The parent of `target` is created if missing. Refuses if `target` already
 * exists, or if `repo` isn't a git repo. The branch must already exist locally.
 */
export async function createWorktreeForBranch(
  repo: string,
  target: string,
  branch: string,
  requireClean: boolean,
): Promise<WorktreeOutcome> {
  if (!(await isGitRepo(repo))) {
    return refused(`workspace \`${repo}\` is not a git repo`);
  }
  if (requireClean && !(await isCleanCheckout(repo))) {
    return refused(`workspace \`${repo}\` has uncommitted changes`);
  }
  const parent = dirname(target);
  try {
    await mkdir(parent, { recursive: true });
  } catch (e) {
    return refused(`failed to create worktree parent \`${parent}\`: ${errMsg(e)}`);
  }
  if (existsSync(target)) {
    return refused(`worktree path already exists: \`${target}\``);
  }
  const r = await runGit(repo, ["worktree", "add", target, branch]);
  if (r.spawnError) {
    return refused(`git worktree add: spawn failed: ${r.spawnError.message}`);
  }
  if (r.code === 0) {
    return created(target);
  }
  return refused(`git worktree add failed: ${r.stderr.toString("utf8").trim()}`);
}

/**
 * Remove a worktree at `path`. Only paths *inside* `worktreeRoot` are permitted
 * — anything else is an error. Forces removal (`--force`) so a worktree that
 * has accumulated build artifacts / untracked files can still be cleaned up.
 *
 * Resolves on success; rejects with an `Error` describing the refusal / git
 * failure (mirrors the Rust `Result<(), String>`).
 */
export async function removeWorktree(
  repo: string,
  worktreeRoot: string,
  path: string,
): Promise<void> {
  let canonRoot: string;
  try {
    canonRoot = await realpath(worktreeRoot);
  } catch (e) {
    throw new Error(`worktree root canonicalize: ${errMsg(e)}`);
  }
  let canonTarget: string;
  try {
    canonTarget = await realpath(path);
  } catch (e) {
    throw new Error(`worktree path canonicalize: ${errMsg(e)}`);
  }
  if (!isInside(canonTarget, canonRoot)) {
    throw new Error(`refused: worktree \`${canonTarget}\` is outside root \`${canonRoot}\``);
  }
  const r = await runGit(repo, ["worktree", "remove", "--force", canonTarget]);
  if (r.spawnError) {
    throw new Error(`git worktree remove: spawn: ${r.spawnError.message}`);
  }
  if (r.code !== 0) {
    throw new Error(`git worktree remove failed: ${r.stderr.toString("utf8").trim()}`);
  }
}

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the worktree's working directory. */
  path: string;
  /** Checked-out HEAD sha, if any (absent for a bare entry). */
  head?: string;
  /** Branch ref (e.g. `refs/heads/main`), if not detached. */
  branch?: string;
  /** `true` when git reports the entry's working tree is missing on disk. */
  prunable: boolean;
  /** `true` for the repo's main worktree (`bare` or first entry). */
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain` into structured entries. Records are
 * separated by a blank line; each record is a set of `key value` (or bare key)
 * lines. The main worktree is the first record.
 */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await runGit(repo, ["worktree", "list", "--porcelain"]);
  if (r.spawnError) {
    throw new Error(`git worktree list: spawn: ${r.spawnError.message}`);
  }
  if (r.code !== 0) {
    throw new Error(`git worktree list failed: ${r.stderr.toString("utf8").trim()}`);
  }
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> & { prunable?: boolean; bare?: boolean } = {};
  let isFirst = true;

  const flush = () => {
    if (cur.path !== undefined) {
      entries.push({
        path: cur.path,
        head: cur.head,
        branch: cur.branch,
        prunable: cur.prunable ?? false,
        bare: cur.bare ?? isFirst,
      });
      isFirst = false;
    }
    cur = {};
  };

  for (const raw of r.stdout.toString("utf8").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    switch (key) {
      case "worktree":
        // A new record always begins with `worktree <path>`.
        flush();
        cur.path = val;
        break;
      case "HEAD":
        cur.head = val;
        break;
      case "branch":
        cur.branch = val;
        break;
      case "bare":
        cur.bare = true;
        break;
      case "prunable":
        cur.prunable = true;
        break;
      case "detached":
        // No branch; nothing to record beyond the absent `branch` line.
        break;
      default:
        break;
    }
  }
  flush();
  return entries;
}

/** A worktree found under `worktreeRoot` that git considers stale/missing. */
export interface OrphanWorktree {
  path: string;
  /** Why it's an orphan: git marked it prunable (working dir gone). */
  reason: "prunable";
}

/**
 * Detect orphaned worktrees: entries git lists as `prunable` (their working
 * directory has been deleted from disk) that live under `worktreeRoot`. The
 * main checkout is never reported. Read-only — pairs with `pruneWorktrees`.
 */
export async function detectOrphans(
  repo: string,
  worktreeRoot: string,
): Promise<OrphanWorktree[]> {
  let canonRoot: string;
  try {
    canonRoot = await realpath(worktreeRoot);
  } catch {
    // Root doesn't exist → nothing was ever minted → no orphans.
    return [];
  }
  const entries = await listWorktrees(repo);
  const orphans: OrphanWorktree[] = [];
  for (const e of entries) {
    if (e.bare) continue;
    if (!e.prunable) continue;
    // `git worktree list` reports absolute paths; compare against the canonical
    // root. A prunable entry's working dir is gone, so we can't realpath it —
    // do a lexical containment check on the reported path.
    if (isInside(e.path, canonRoot)) {
      orphans.push({ path: e.path, reason: "prunable" });
    }
  }
  return orphans;
}

/**
 * Prune stale worktree administrative entries via `git worktree prune`. This is
 * git's own GC for worktrees whose working directory has been removed — it
 * cleans up `.git/worktrees/<id>` bookkeeping. Returns the number of orphans
 * git reported as prunable *before* the prune (best-effort count from a dry
 * run), then runs the real prune. Mirrors the Phase-5b orphan cleanup helper.
 */
export async function pruneWorktrees(repo: string, worktreeRoot: string): Promise<number> {
  const orphans = await detectOrphans(repo, worktreeRoot);
  const r = await runGit(repo, ["worktree", "prune"]);
  if (r.spawnError) {
    throw new Error(`git worktree prune: spawn: ${r.spawnError.message}`);
  }
  if (r.code !== 0) {
    throw new Error(`git worktree prune failed: ${r.stderr.toString("utf8").trim()}`);
  }
  return orphans.length;
}

/**
 * Lexical containment: is `child` equal to or nested under `parent`? Both should
 * be absolute / canonical paths. Guards against the `/foo` vs `/foobar` prefix
 * trap by comparing on a path-separator boundary.
 */
function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
