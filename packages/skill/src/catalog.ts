// Disk-scanning skill catalog.
//
// Ported from crates/harness-skill/src/catalog.rs.
//
// Walks one or more "skill roots" (e.g. `~/.config/jarvis/skills`,
// `<workspace>/.jarvis/skills`). Each subdirectory of a root is a skill:
// reading `<dir>/SKILL.md` produces one {@link SkillEntry}. Project-scope
// entries shadow user-scope entries with the same `name`; merge order is the
// order roots are passed to {@link SkillCatalog.load}.
//
// The catalog is an in-memory index keyed by `name`; iteration is sorted by
// `name` so the API list / Settings UI is deterministic (Rust uses a
// `BTreeMap`, which we mirror with an explicit sort over a `Map`).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseSkill, type SkillManifest } from "./manifest.ts";

const SKILL_FILE = "SKILL.md";

/**
 * Where a skill came from. Drives display labels and the
 * "project-shadows-user" precedence in {@link SkillCatalog.load}. Rust
 * `SkillSource`, `#[serde(rename_all = "kebab-case")]` — single-word variants
 * stay lowercase on the wire.
 *
 * - `bundled`   — shipped with the binary; lowest precedence.
 * - `user`      — `~/.config/jarvis/skills/...`.
 * - `workspace` — `<workspace>/.jarvis/skills/...`.
 * - `plugin`    — installed from a plugin manifest.
 */
export type SkillSource = "bundled" | "user" | "workspace" | "plugin";

/** One skill in the catalog: parsed manifest + body + provenance. */
export interface SkillEntry {
  manifest: SkillManifest;
  body: string;
  /**
   * Path to the source `SKILL.md`. Useful for the UI's "open in editor"
   * affordance. Bundled entries carry a synthetic `<bundled>/…` path.
   */
  path: string;
  source: SkillSource;
}

/** The skill's name — its catalog key. */
export function skillEntryName(entry: SkillEntry): string {
  return entry.manifest.name;
}

/**
 * In-memory catalog. Lookup by `name`; iteration ({@link SkillCatalog.entries})
 * is sorted by `name` so the API list / Settings UI is deterministic.
 *
 * Construction is async because scanning the disk is async: use the static
 * {@link SkillCatalog.load} (or {@link SkillCatalog.empty} for a bare one).
 */
export class SkillCatalog {
  readonly #byName = new Map<string, SkillEntry>();

  /** A fresh, empty catalog. */
  static empty(): SkillCatalog {
    return new SkillCatalog();
  }

  /**
   * Scan the given (root, source) pairs in order; later entries with the same
   * `name` win (project shadows user). Missing roots are silent; unreadable
   * roots and unparseable skills are skipped.
   */
  static async load(roots: Iterable<readonly [string, SkillSource]>): Promise<SkillCatalog> {
    const cat = new SkillCatalog();
    for (const [root, source] of roots) {
      await cat.mergeDisk(root, source);
    }
    return cat;
  }

  /**
   * Scan one filesystem root and merge results into this catalog. Later calls
   * overwrite earlier entries with the same `name`, so caller order encodes
   * precedence (bundled → user → workspace → plugin).
   */
  async mergeDisk(root: string, source: SkillSource): Promise<void> {
    for (const entry of await scanRoot(root, source)) {
      this.#byName.set(entry.manifest.name, entry);
    }
  }

  /** Number of skills in the catalog. */
  get size(): number {
    return this.#byName.size;
  }

  /** True when the catalog holds no skills. */
  isEmpty(): boolean {
    return this.#byName.size === 0;
  }

  /** Look up a skill by `name`. `undefined` when absent. */
  get(name: string): SkillEntry | undefined {
    return this.#byName.get(name);
  }

  /**
   * All entries, deterministically ordered by name (mirrors Rust's
   * `BTreeMap::values`). Returns a fresh array, not a live view.
   */
  entries(): SkillEntry[] {
    return [...this.#byName.values()].sort((a, b) =>
      a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0,
    );
  }

  /**
   * Insert / replace an entry programmatically — used by the plugin manager
   * when it wires installed skills in, and by tests.
   */
  insert(entry: SkillEntry): void {
    this.#byName.set(entry.manifest.name, entry);
  }

  /** Remove a skill by name. Returns `true` if it was present. */
  remove(name: string): boolean {
    return this.#byName.delete(name);
  }

  /**
   * Merge skills from an in-memory map of `name -> SKILL.md text` as
   * {@link SkillSource} `"bundled"`. Each text is parsed; failures are
   * skipped. Bundled entries are the lowest-precedence layer — they NEVER
   * overwrite an existing entry. Call this *before* the disk roots so
   * subsequent {@link mergeDisk} calls can shadow them.
   *
   * (The Rust crate embeds `assets/defaults/<name>/SKILL.md` at compile time
   * via `include_dir!`; in Node the caller supplies the texts — e.g. read off
   * disk in the composition root — so this stays env- and bundler-agnostic.)
   */
  mergeBundled(texts: Iterable<readonly [string, string]>): void {
    for (const [pathLabel, text] of texts) {
      let parsed;
      try {
        parsed = parseSkill(text);
      } catch {
        continue; // bundled SKILL.md failed to parse → skip
      }
      const key = parsed.manifest.name;
      if (this.#byName.has(key)) continue; // never overwrite — lowest precedence
      this.#byName.set(key, {
        manifest: parsed.manifest,
        body: parsed.body,
        path: `<bundled>/${pathLabel}`,
        source: "bundled",
      });
    }
  }
}

/** Read every `<dir>/SKILL.md` under `root`, returning the parsed entries. */
async function scanRoot(root: string, source: SkillSource): Promise<SkillEntry[]> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (e) {
    // Not-found is the usual case for an unconfigured user → silent. Other
    // errors (e.g. permission) are swallowed too here; the Rust impl logs a
    // warn but this package keeps no logger dependency.
    if (isNotFound(e)) return [];
    return [];
  }
  const out: SkillEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const skillMd = path.join(root, dirent.name, SKILL_FILE);
    let text: string;
    try {
      text = await readFile(skillMd, "utf8");
    } catch {
      // No SKILL.md in this subdir (or unreadable) → silently skip.
      continue;
    }
    try {
      const { manifest, body } = parseSkill(text);
      out.push({ manifest, body, path: skillMd, source });
    } catch {
      // Bad frontmatter → skip (Rust warns + skips).
    }
  }
  return out;
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}
