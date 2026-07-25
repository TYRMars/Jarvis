// File-backed PermissionStore — the three-scope merge behind `/v1/permissions`
// and the chat WebSocket's RuleApprover.
//
// Ported from the Rust `JsonFilePermissionStore` (harness-store). Three scopes,
// two of them on disk:
//
//   session   in-memory      cleared on restart
//   project   <workspace>/.jarvis/permissions.json   committed to git
//   user      <config>/jarvis/permissions.json       per-machine, 0600
//
// Merge rules (mirrors the proposal's "Priority: user > project > session"):
//   * `default_mode` — the highest scope that pins one wins (user, then
//     project, then the session default the composition root seeded).
//   * rules — concatenated user-first, so a user-scope entry is evaluated
//     before a project one inside the same bucket.
//
// Each scope's file is read on every snapshot rather than cached: the files
// are tiny, an approval already sits behind an LLM round-trip, and re-reading
// means an operator editing `permissions.json` by hand (or a `git pull`
// bringing new project rules) takes effect without a restart.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  emptyTable,
  type Decision,
  type PermissionMode,
  type PermissionRule,
  type PermissionStore,
  type PermissionTable,
  type Scope,
  type ScopedRule,
  OUT_OF_BOUNDS,
  parsePermissionMode,
} from "./permissions-routes.ts";

/** One scope's on-disk shape. `scope` is implied by which file it came from. */
interface PermissionFile {
  default_mode?: string;
  deny?: PermissionRule[];
  ask?: PermissionRule[];
  allow?: PermissionRule[];
}

const BUCKETS: readonly Decision[] = ["deny", "ask", "allow"];

export interface FilePermissionStoreOptions {
  /** `<workspace>/.jarvis/permissions.json`; omit to disable the project scope. */
  projectPath?: string;
  /** `<config>/jarvis/permissions.json`; omit to disable the user scope. */
  userPath?: string;
  /** Mode used when neither file pins one (`JARVIS_PERMISSION_MODE`). */
  defaultMode?: PermissionMode;
}

export class FilePermissionStore implements PermissionStore {
  readonly #projectPath: string | undefined;
  readonly #userPath: string | undefined;
  #sessionMode: PermissionMode | undefined;
  #session: Record<Decision, ScopedRule[]> = { deny: [], ask: [], allow: [] };

  constructor(opts: FilePermissionStoreOptions = {}) {
    this.#projectPath = opts.projectPath;
    this.#userPath = opts.userPath;
    this.#sessionMode = opts.defaultMode;
  }

  async snapshot(): Promise<PermissionTable> {
    const user = await this.#read(this.#userPath);
    const project = await this.#read(this.#projectPath);
    const table = emptyTable();
    table.default_mode =
      parseMode(user?.default_mode) ?? parseMode(project?.default_mode) ?? this.#sessionMode ?? "ask";
    for (const bucket of BUCKETS) {
      table[bucket] = [
        ...scoped(user?.[bucket], "user"),
        ...scoped(project?.[bucket], "project"),
        ...this.#session[bucket].map(cloneScoped),
      ];
    }
    return table;
  }

  async appendRule(scope: Scope, bucket: Decision, rule: PermissionRule): Promise<void> {
    if (scope === "session") {
      this.#session[bucket].push(toScoped(rule, "session"));
      return;
    }
    const target = this.#pathFor(scope);
    const file = (await this.#read(target)) ?? {};
    file[bucket] = [...(file[bucket] ?? []), stripScope(rule)];
    await this.#write(target, file, scope);
  }

  /**
   * `index` addresses the MERGED bucket (what `GET /v1/permissions` returned
   * and the UI listed), and `scope` says which scope that row belongs to —
   * so deleting row N removes exactly the rule the operator clicked, not the
   * Nth rule of some other scope. Mirrors MemoryPermissionStore.
   */
  async deleteRule(scope: Scope, bucket: Decision, index: number): Promise<void> {
    const merged = (await this.snapshot())[bucket];
    const row = merged[index];
    if (!row) throw new Error(`rule index ${index} ${OUT_OF_BOUNDS} for ${bucket} bucket`);
    if (row.scope !== scope) {
      throw new Error(`rule index ${index} ${OUT_OF_BOUNDS} for ${bucket} bucket in scope ${scope}`);
    }
    if (scope === "session") {
      const local = this.#session[bucket].findIndex((r) => sameRule(r, row));
      if (local < 0) throw new Error(`rule index ${index} ${OUT_OF_BOUNDS} for ${bucket} bucket`);
      this.#session[bucket].splice(local, 1);
      return;
    }
    const target = this.#pathFor(scope);
    const file = (await this.#read(target)) ?? {};
    const rules = file[bucket] ?? [];
    const local = rules.findIndex((r) => sameRule(toScoped(r, scope), row));
    if (local < 0) throw new Error(`rule index ${index} ${OUT_OF_BOUNDS} for ${bucket} bucket`);
    rules.splice(local, 1);
    file[bucket] = rules;
    await this.#write(target, file, scope);
  }

  async setDefaultMode(scope: Scope, mode: PermissionMode): Promise<void> {
    if (scope === "session") {
      this.#sessionMode = mode;
      return;
    }
    const target = this.#pathFor(scope);
    const file = (await this.#read(target)) ?? {};
    file.default_mode = mode;
    await this.#write(target, file, scope);
  }

  // -------------------------------------------------------------------------

  #pathFor(scope: Scope): string {
    const target = scope === "user" ? this.#userPath : this.#projectPath;
    if (!target) throw new Error(`${scope} scope is not configured (no path)`);
    return target;
  }

  /** Parse one scope's file. Missing/!JSON/!object → undefined (never throws). */
  async #read(target: string | undefined): Promise<PermissionFile | undefined> {
    if (!target) return undefined;
    try {
      const body = await readFile(target, "utf8");
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return parsed as PermissionFile;
    } catch {
      return undefined;
    }
  }

  /** Atomic tmp+rename. The user file is 0600 (machine-local, not committed). */
  async #write(target: string, file: PermissionFile, scope: Scope): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const mode = scope === "user" ? 0o600 : 0o644;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(tmp, target);
  }
}

function parseMode(v: string | undefined): PermissionMode | undefined {
  return typeof v === "string" ? parsePermissionMode(v) : undefined;
}

function toScoped(rule: PermissionRule, scope: Scope): ScopedRule {
  return rule.matchers ? { scope, tool: rule.tool, matchers: { ...rule.matchers } } : { scope, tool: rule.tool };
}

function stripScope(rule: PermissionRule): PermissionRule {
  return rule.matchers ? { tool: rule.tool, matchers: { ...rule.matchers } } : { tool: rule.tool };
}

function cloneScoped(sr: ScopedRule): ScopedRule {
  return sr.matchers ? { scope: sr.scope, tool: sr.tool, matchers: { ...sr.matchers } } : { scope: sr.scope, tool: sr.tool };
}

function scoped(rules: PermissionRule[] | undefined, scope: Scope): ScopedRule[] {
  return Array.isArray(rules)
    ? rules.filter((r) => r !== null && typeof r === "object" && typeof r.tool === "string").map((r) => toScoped(r, scope))
    : [];
}

/** Structural identity — rules carry no id, so match on tool + matchers. */
function sameRule(a: ScopedRule, b: ScopedRule): boolean {
  return a.tool === b.tool && JSON.stringify(a.matchers ?? {}) === JSON.stringify(b.matchers ?? {});
}
