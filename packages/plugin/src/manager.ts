// Install / uninstall + ledger for plugins.
//
// Ported from crates/harness-plugin/src/manager.rs.
//
// Owns a `<plugins-root>` directory on disk. Each installed plugin lives under
// `<plugins-root>/<name>/`; an `installed.json` ledger at the root tracks
// install metadata so we can list / uninstall without re-parsing every
// manifest.
//
// `installFromPath` / `uninstall` are `async` because they delegate to the MCP
// manager (which spawns child processes) and to filesystem I/O. Mutating
// operations are serialised through an internal promise chain — the JS analogue
// of Rust's `tokio::Mutex` over the in-memory ledger.
import { cp, lstat, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { McpClientConfig } from "@jarvis/mcp";
import { SkillCatalog, type SkillEntry, parseSkill } from "@jarvis/skill";
import { atomicWrite, ensureDir } from "@jarvis/store";

import { parsePluginManifest, type PluginManifest } from "./manifest.ts";

const LEDGER_FILE = "installed.json";

/**
 * Minimal slice of the runtime MCP manager (Rust `harness_mcp::McpManager`)
 * the {@link PluginManager} depends on. Declared structurally — `@jarvis/mcp`
 * ships the `McpClient` / `connectAllMcp` building blocks but not a runtime
 * manager type yet, so the plugin manager binds to this seam. The server's
 * concrete manager satisfies it; tests inject a fake.
 */
export interface McpManagerLike {
  /** Add (connect + register) one MCP server. Returns the registered tool names. */
  add(config: McpClientConfig): Promise<string[]>;
  /** Remove a server by prefix. Returns whether one was present. */
  remove(prefix: string): Promise<boolean>;
  /** Look up a server by prefix; `undefined` when absent. */
  get(prefix: string): Promise<unknown | undefined>;
}

/** Error kinds out of the plugin manager. Mirrors Rust's `PluginManagerError`. */
export type PluginManagerErrorKind =
  | "already_installed"
  | "not_installed"
  | "conflict"
  | "manifest"
  | "io"
  | "skill"
  | "mcp";

/** Thrown by {@link PluginManager}. `kind` mirrors the Rust variant. */
export class PluginManagerError extends Error {
  readonly kind: PluginManagerErrorKind;
  /** For `conflict`: the kind of thing that clashed (`"skill"` / `"mcp prefix"`). */
  readonly conflictKind?: string;

  constructor(kind: PluginManagerErrorKind, message: string, conflictKind?: string) {
    super(message);
    this.name = "PluginManagerError";
    this.kind = kind;
    if (conflictKind !== undefined) this.conflictKind = conflictKind;
  }

  static alreadyInstalled(name: string): PluginManagerError {
    return new PluginManagerError("already_installed", `plugin \`${name}\` is already installed`);
  }
  static notInstalled(name: string): PluginManagerError {
    return new PluginManagerError("not_installed", `plugin \`${name}\` is not installed`);
  }
  static conflict(conflictKind: string, name: string): PluginManagerError {
    return new PluginManagerError(
      "conflict",
      `conflict: ${conflictKind} \`${name}\` is already registered (likely from a built-in or another plugin)`,
      conflictKind,
    );
  }
  static io(message: string): PluginManagerError {
    return new PluginManagerError("io", `io: ${message}`);
  }
  static skill(message: string): PluginManagerError {
    return new PluginManagerError("skill", `skill: ${message}`);
  }
  static mcp(message: string): PluginManagerError {
    return new PluginManagerError("mcp", `mcp: ${message}`);
  }
}

/**
 * What the manager records per installed plugin. Persisted to `installed.json`
 * so a fresh process can re-attach to running plugins without re-parsing their
 * manifests. Serde shape: `skill_names` / `mcp_prefixes` default to `[]`.
 */
export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  /** Absolute path to the installed copy (`<plugins-root>/<name>/`). */
  install_dir: string;
  /** Where the plugin was installed from. `"path"` today; `"git"` reserved. */
  source_kind: string;
  source_value: string;
  /** RFC-3339 install timestamp. */
  installed_at: string;
  /** Skill names the plugin contributed, so uninstall can pull them precisely. */
  skill_names: string[];
  /** MCP prefixes the plugin owns, so uninstall can drop them. */
  mcp_prefixes: string[];
}

/**
 * Result handed back after a successful install. Includes the persisted ledger
 * entry plus a flat list of what the install actually added.
 */
export interface PluginInstallReport {
  plugin: InstalledPlugin;
  added_skills: string[];
  added_mcp: string[];
}

/**
 * Manager handle. Built once via {@link PluginManager.open}; shared across the
 * HTTP router. Construction is async because it loads the ledger off disk
 * (mirrors the project-store `static async open(baseDir)` convention).
 */
export class PluginManager {
  readonly #root: string;
  readonly #skills: SkillCatalog;
  readonly #mcp: McpManagerLike;
  /** In-memory install ledger keyed by plugin name. */
  readonly #ledger: Map<string, InstalledPlugin>;
  /** Serialises mutating operations (install / uninstall) — Rust's tokio::Mutex. */
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(
    root: string,
    skills: SkillCatalog,
    mcp: McpManagerLike,
    ledger: Map<string, InstalledPlugin>,
  ) {
    this.#root = root;
    this.#skills = skills;
    this.#mcp = mcp;
    this.#ledger = ledger;
  }

  /**
   * Build a manager pointed at `root`. Creates the directory, then loads the
   * ledger if present (absent / empty file = empty ledger).
   */
  static async open(
    root: string,
    skills: SkillCatalog,
    mcp: McpManagerLike,
  ): Promise<PluginManager> {
    await ensureDir(root).catch(() => {});
    const ledger = await readLedger(root);
    return new PluginManager(root, skills, mcp, ledger);
  }

  /** The plugins-root directory this manager owns. */
  get root(): string {
    return this.#root;
  }

  /** Snapshot of the install ledger, sorted by name. */
  async list(): Promise<InstalledPlugin[]> {
    return this.#runExclusive(() => {
      const out = [...this.#ledger.values()].map(cloneEntry);
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    });
  }

  /** Look one up by name. */
  async get(name: string): Promise<InstalledPlugin | undefined> {
    return this.#runExclusive(() => {
      const entry = this.#ledger.get(name);
      return entry ? cloneEntry(entry) : undefined;
    });
  }

  /**
   * Install from a local path. The directory must contain a `plugin.json` at
   * its root.
   *
   * Steps (rolled back on any failure):
   * 1. Parse manifest, validate identity, ensure not already installed.
   * 2. Validate every shipped skill (path resolves, parses).
   * 3. Conflict-check skill names + MCP prefixes against the live state.
   * 4. Copy `<source>` → `<root>/<name>`.
   * 5. Insert skills into the catalog with `source: "plugin"`.
   * 6. Add MCP servers to the manager.
   * 7. Append entry to ledger and flush to disk.
   */
  async installFromPath(source: string): Promise<PluginInstallReport> {
    return this.#runExclusive(() => this.#installFromPathInner(source));
  }

  async #installFromPathInner(source: string): Promise<PluginInstallReport> {
    const manifestPath = path.join(source, "plugin.json");
    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (e) {
      throw PluginManagerError.io(`read ${manifestPath}: ${errText(e)}`);
    }
    const manifest = parsePluginManifest(text);
    const name = manifest.name;

    if (this.#ledger.has(name)) {
      throw PluginManagerError.alreadyInstalled(name);
    }

    // Pre-flight skill validation (parse every SKILL.md before we copy
    // anything). Each entry is held with `source: "plugin"`; insertion happens
    // after the copy. We track each skill's relative path so we can re-point it
    // at the installed copy.
    const staged: Array<{ entry: SkillEntry; rel: string }> = [];
    for (const rel of manifest.skills) {
      const abs = resolveContainedSkill(source, rel);
      const skillMd = (await isDir(abs)) ? path.join(abs, "SKILL.md") : abs;
      let raw: string;
      try {
        raw = await readFile(skillMd, "utf8");
      } catch (e) {
        throw PluginManagerError.io(`read ${skillMd}: ${errText(e)}`);
      }
      let parsed;
      try {
        parsed = parseSkill(raw);
      } catch (e) {
        throw PluginManagerError.skill(`${skillMd}: ${errText(e)}`);
      }
      staged.push({
        entry: { manifest: parsed.manifest, body: parsed.body, path: skillMd, source: "plugin" },
        rel: path.relative(source, skillMd),
      });
    }

    // Skill conflict check.
    for (const s of staged) {
      if (this.#skills.get(s.entry.manifest.name) !== undefined) {
        throw PluginManagerError.conflict("skill", s.entry.manifest.name);
      }
    }

    // MCP conflict check (defer the actual add until after the copy).
    for (const prefix of Object.keys(manifest.mcp_servers)) {
      if ((await this.#mcp.get(prefix)) !== undefined) {
        throw PluginManagerError.conflict("mcp prefix", prefix);
      }
    }

    // Copy plugin tree to <root>/<name>/.
    const installDir = path.join(this.#root, name);
    try {
      await rm(installDir, { recursive: true, force: true });
    } catch (e) {
      throw PluginManagerError.io(`rm stale ${installDir}: ${errText(e)}`);
    }
    try {
      // Rust's copy_tree copies only dirs + regular files, skipping symlinks
      // entirely so dangling / out-of-plugin links never land in the install
      // dir. `cp` with dereference:false copies a symlink AS a symlink, so we
      // filter symlinks out via lstat to match that behaviour. (The root dir
      // and every regular file/dir pass the filter.)
      await cp(source, installDir, {
        recursive: true,
        dereference: false,
        filter: async (src) => {
          const meta = await lstat(src);
          return !meta.isSymbolicLink();
        },
      });
    } catch (e) {
      throw PluginManagerError.io(`copy ${source} -> ${installDir}: ${errText(e)}`);
    }

    // Register skills (re-pointing each path at the installed copy).
    const addedSkillNames: string[] = [];
    for (const s of staged) {
      const installed: SkillEntry = {
        ...s.entry,
        path: path.join(installDir, s.rel),
      };
      addedSkillNames.push(installed.manifest.name);
      this.#skills.insert(installed);
    }

    // Add MCP servers. If any add fails, roll back everything added so far.
    const addedMcp: string[] = [];
    for (const [prefix, cfg] of Object.entries(manifest.mcp_servers)) {
      // Force prefix to match map key (also done in parser, but defensive).
      const cloned: McpClientConfig = { ...cfg, prefix };
      try {
        await this.#mcp.add(cloned);
      } catch (e) {
        await this.#rollbackPartial(addedSkillNames, addedMcp, installDir);
        throw PluginManagerError.mcp(errText(e));
      }
      addedMcp.push(prefix);
    }

    const entry: InstalledPlugin = {
      name,
      version: manifest.version,
      description: manifest.description,
      install_dir: installDir,
      source_kind: "path",
      source_value: source,
      installed_at: new Date().toISOString(),
      skill_names: [...addedSkillNames],
      mcp_prefixes: [...addedMcp],
    };

    this.#ledger.set(name, entry);
    // Ledger write failure is non-fatal — live registrations stay in place.
    await writeLedger(this.#root, this.#ledger).catch(() => {});

    return {
      plugin: cloneEntry(entry),
      added_skills: [...addedSkillNames],
      added_mcp: [...addedMcp],
    };
  }

  /**
   * Uninstall a plugin by name. Pulls every skill / MCP server it owns, then
   * deletes the install dir. MCP servers are removed *first* so no in-flight
   * tool call resolves a tool whose backing client we're about to kill.
   */
  async uninstall(name: string): Promise<void> {
    return this.#runExclusive(async () => {
      const entry = this.#ledger.get(name);
      if (entry === undefined) {
        throw PluginManagerError.notInstalled(name);
      }
      this.#ledger.delete(name);

      for (const prefix of entry.mcp_prefixes) {
        // Best-effort: a failed remove is logged-and-ignored in Rust.
        await this.#mcp.remove(prefix).catch(() => {});
      }
      for (const s of entry.skill_names) {
        this.#skills.remove(s);
      }
      await rm(entry.install_dir, { recursive: true, force: true }).catch(() => {});
      await writeLedger(this.#root, this.#ledger).catch(() => {});
    });
  }

  /**
   * Re-attach to plugins recorded in the ledger. Called once at startup; for
   * each entry, parse its manifest and re-register its skills + MCP servers
   * without copying anything (the install dir already exists). Per-plugin
   * failures are swallowed so the rest still come up.
   */
  async reattachInstalled(): Promise<void> {
    return this.#runExclusive(async () => {
      const entries = [...this.#ledger.values()];
      for (const entry of entries) {
        await this.#reattachOne(entry).catch(() => {});
      }
    });
  }

  async #reattachOne(entry: InstalledPlugin): Promise<void> {
    const manifestPath = path.join(entry.install_dir, "plugin.json");
    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (e) {
      throw PluginManagerError.io(errText(e));
    }
    const manifest: PluginManifest = parsePluginManifest(text);

    // Skills: re-load each one and insert.
    for (const rel of manifest.skills) {
      const abs = resolveContainedSkill(entry.install_dir, rel);
      const skillMd = (await isDir(abs)) ? path.join(abs, "SKILL.md") : abs;
      const raw = await readFile(skillMd, "utf8");
      const parsed = parseSkill(raw);
      this.#skills.insert({
        manifest: parsed.manifest,
        body: parsed.body,
        path: skillMd,
        source: "plugin",
      });
    }

    // MCP: re-add each server. Failures are swallowed so the rest come up.
    for (const [prefix, cfg] of Object.entries(manifest.mcp_servers)) {
      const cloned: McpClientConfig = { ...cfg, prefix };
      await this.#mcp.add(cloned).catch(() => {});
    }
  }

  async #rollbackPartial(
    skillNames: string[],
    mcpPrefixes: string[],
    installDir: string,
  ): Promise<void> {
    for (const s of skillNames) {
      this.#skills.remove(s);
    }
    for (const prefix of mcpPrefixes) {
      await this.#mcp.remove(prefix).catch(() => {});
    }
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Serialise an operation behind the internal chain so install / uninstall
   * never interleave (the JS analogue of holding the tokio Mutex). The chain
   * never rejects — each op's own promise carries success/failure to its caller.
   */
  #runExclusive<T>(op: () => T | Promise<T>): Promise<T> {
    const run = this.#chain.then(() => op());
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------- ledger persistence ----------

async function readLedger(root: string): Promise<Map<string, InstalledPlugin>> {
  const filePath = path.join(root, LEDGER_FILE);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e)) return new Map();
    throw PluginManagerError.io(errText(e));
  }
  if (text.trim().length === 0) return new Map();
  let entries: InstalledPlugin[];
  try {
    entries = JSON.parse(text) as InstalledPlugin[];
  } catch (e) {
    throw PluginManagerError.io(`parse ${filePath}: ${errText(e)}`);
  }
  const map = new Map<string, InstalledPlugin>();
  for (const e of entries) {
    // Serde `#[serde(default)]` on the two Vec fields — tolerate absent arrays.
    map.set(e.name, {
      ...e,
      skill_names: e.skill_names ?? [],
      mcp_prefixes: e.mcp_prefixes ?? [],
    });
  }
  return map;
}

async function writeLedger(root: string, ledger: Map<string, InstalledPlugin>): Promise<void> {
  const filePath = path.join(root, LEDGER_FILE);
  // BTreeMap::values → name-sorted; mirror that for a stable on-disk shape.
  const entries = [...ledger.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const text = JSON.stringify(entries, null, 2);
  // Reuse @jarvis/store's atomic tmp+rename writer (matches Rust's write_ledger).
  await atomicWrite(filePath, text);
}

// ---------- small helpers ----------

function cloneEntry(e: InstalledPlugin): InstalledPlugin {
  return structuredClone(e);
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Resolve a manifest `skills` entry against the plugin directory, rejecting any
 * path that escapes it. A malicious/typo'd `plugin.json` could otherwise use
 * `../../etc/secret` or an absolute path to read arbitrary host files and inject
 * their contents into the agent's system prompt as a "skill". See issue #219.
 */
function resolveContainedSkill(base: string, rel: string): string {
  const abs = path.resolve(base, rel);
  const within = path.relative(base, abs);
  if (within === ".." || within.startsWith(".." + path.sep) || path.isAbsolute(within)) {
    throw PluginManagerError.skill(`skill path escapes plugin directory: ${rel}`);
  }
  return abs;
}
