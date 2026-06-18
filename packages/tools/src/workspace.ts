// `workspace.context` — compact workspace overview. Ported from
// crates/harness-tools/src/workspace.rs.
//
// Returns a small JSON blob the model can use as its "first look" at the
// repository it's working inside. Designed to keep token cost tiny: no
// source-file contents, no recursive listing — only what makes the
// difference between "I'm in repo X on branch Y, with these manifests /
// instruction files" and "I have no idea where I am".
//
// Output shape (stable):
//
//   {
//     "root": "/abs/path/to/workspace",
//     "vcs": "git" | "none",
//     "branch": "main",                 // omitted when vcs == "none"
//     "head": "34cd366",                // omitted when no commits / vcs == "none"
//     "dirty": true,                    // omitted when vcs == "none"
//     "instructions": ["AGENTS.md", "CLAUDE.md", "README.md"],
//     "manifest": ["Cargo.toml", "apps/jarvis-web/package.json"],
//     "tools_root_top_level": ["apps", "crates", "docs", "Cargo.toml"]
//   }
//
// Always-on, read-only — no approval gate.
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { JsonValue } from "@jarvis/core";
import type { Tool, ToolCategory } from "@jarvis/core";

const GIT_TIMEOUT_MS = 5_000;
const MAX_TOP_LEVEL_ENTRIES = 64;

/**
 * Filenames recognised as "instruction" docs the model should probably read
 * before doing anything serious. Order is the order returned in the JSON
 * output, so the most agent-specific come first.
 */
const INSTRUCTION_FILES: readonly string[] = [
  "AGENTS.md",
  "JARVIS.md",
  "CLAUDE.md",
  "AGENT.md",
  ".jarvis/JARVIS.md",
  ".jarvis/AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "README",
];

/**
 * Filenames recognised as project manifests. Looked up at the root and inside
 * one level of CONTAINER_DIRS (so monorepos like `apps/jarvis-web/package.json`
 * show up).
 */
const MANIFEST_FILES: readonly string[] = [
  "Cargo.toml",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "mix.exs",
  "Package.swift",
  "pubspec.yaml",
];

/**
 * Top-level directories that conventionally hold per-package children
 * (monorepo layout). Only these get a one-level deeper scan for manifests;
 * anything else is skipped to keep the walk bounded.
 */
const CONTAINER_DIRS: readonly string[] = ["apps", "crates", "packages", "services", "modules", "libs"];

/**
 * Directories we never enter regardless of the layout — they either don't
 * contain real source (`target/`, `dist/`, `node_modules/`) or are noisy
 * enough that listing them costs more than the model gains (`.git/`, `.venv/`).
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "target", "dist", ".venv"]);

/** Cap on total manifest entries returned. */
const MAX_MANIFESTS = 24;

interface LocalInfo {
  rootDisplay: string;
  instructions: string[];
  manifests: string[];
  topLevel: string[];
}

interface GitInfo {
  branch?: string;
  head?: string;
  dirty: boolean;
}

export class WorkspaceContextTool implements Tool {
  readonly name = "workspace.context";
  readonly description =
    "Compact JSON snapshot of the current workspace: root path, VCS state " +
    "(branch / dirty / HEAD when git), agent instruction files (AGENTS.md / " +
    "CLAUDE.md / README.md), package manifests (Cargo.toml / package.json / " +
    "pyproject.toml / go.mod / …), and a shallow top-level directory listing. " +
    "Read-only, no source file contents — call `fs.read` for those.";
  readonly parameters: JsonValue = { type: "object", properties: {} };
  readonly category: ToolCategory = "read";
  readonly cacheable = true;

  readonly #root: string;

  constructor(config: { root: string }) {
    this.#root = config.root;
  }

  async invoke(_args: JsonValue): Promise<string> {
    const local = await gatherLocal(this.#root);
    const git = await gatherGit(this.#root);

    // Match the Rust key-insertion order exactly so callers depending on a
    // stable shape (and the pretty-printed bytes) stay aligned.
    const out: Record<string, JsonValue> = {};
    out.root = local.rootDisplay;
    if (git) {
      out.vcs = "git";
      if (git.branch !== undefined) out.branch = git.branch;
      if (git.head !== undefined) out.head = git.head;
      out.dirty = git.dirty;
    } else {
      out.vcs = "none";
    }
    out.instructions = local.instructions;
    out.manifest = local.manifests;
    out.tools_root_top_level = local.topLevel;

    return JSON.stringify(out, null, 2);
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function gatherLocal(root: string): Promise<LocalInfo> {
  // Canonicalise so the model sees a stable absolute path even if we were
  // started with `--workspace .`. Fall back to the raw path on failure.
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch {
    canonical = path.resolve(root);
  }
  const rootDisplay = canonical;

  // Instructions: simple existence check at the root.
  const instructions: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    if (await isFile(path.join(canonical, name))) {
      instructions.push(name);
    }
  }

  // Manifests: root + one level inside CONTAINER_DIRS.
  const manifests: string[] = [];
  for (const name of MANIFEST_FILES) {
    if (await isFile(path.join(canonical, name))) {
      manifests.push(name);
    }
  }

  outer: for (const container of CONTAINER_DIRS) {
    const cdir = path.join(canonical, container);
    if (!(await isDir(cdir))) continue;
    let entries: string[];
    try {
      entries = await readdir(cdir);
    } catch {
      continue;
    }
    for (const childName of entries.slice(0, MAX_TOP_LEVEL_ENTRIES)) {
      const childPath = path.join(cdir, childName);
      if (!(await isDir(childPath))) continue;
      if (SKIP_DIRS.has(childName) || childName.startsWith(".")) continue;
      for (const m of MANIFEST_FILES) {
        const candidate = path.join(childPath, m);
        if (!(await isFile(candidate))) continue;
        const rel = path.relative(canonical, candidate);
        manifests.push(rel.split(path.sep).join("/"));
        if (manifests.length >= MAX_MANIFESTS) break outer;
        break;
      }
    }
  }

  // Top-level entries (sorted, capped, dotfiles skipped).
  let topLevel: string[] = [];
  try {
    topLevel = (await readdir(canonical)).filter((n) => !n.startsWith("."));
  } catch {
    topLevel = [];
  }
  topLevel.sort();
  topLevel = topLevel.slice(0, MAX_TOP_LEVEL_ENTRIES);

  return { rootDisplay, instructions, manifests, topLevel };
}

async function gatherGit(root: string): Promise<GitInfo | null> {
  // Cheap probe: rev-parse --is-inside-work-tree. Anything other than a
  // trimmed "true" → not a git workspace, skip the rest.
  const inside = await runGitCapture(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.ok !== true || inside.stdout.trim() !== "true") {
    return null;
  }

  let branch: string | undefined;
  const branchRes = await runGitCapture(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchRes.ok) {
    const b = branchRes.stdout.trim();
    if (b.length > 0 && b !== "HEAD") branch = b;
  }

  let head: string | undefined;
  const headRes = await runGitCapture(root, ["rev-parse", "--short", "HEAD"]);
  if (headRes.ok) {
    const h = headRes.stdout.trim();
    if (h.length > 0) head = h;
  }

  const porcelain = await runGitCapture(root, ["status", "--porcelain"]);
  const dirty = porcelain.ok ? porcelain.stdout.trim().length > 0 : false;

  return { branch, head, dirty };
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGitCapture(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (res: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "" });
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish({ ok: false, stdout: "" }));
    child.on("close", (code) => finish({ ok: code === 0, stdout }));
  });
}
