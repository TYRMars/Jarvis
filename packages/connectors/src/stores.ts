// Connector binding stores — Memory + JSON-file backends for the three
// connector store traits. Ported from
// crates/harness-store/src/connectors_stores.rs.
//
// The JSON-file backend follows the per-row-file pattern of the sibling JSON
// stores (`<dir>/<subdir>/<encodeId(id)>.json`, atomic tmp+rename writes,
// `list` = directory scan), reusing @jarvis/store's atomicWrite / ensureDir /
// encodeId. Rows are sorted by `created_at` ascending to mirror Rust.
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type {
  ConnectorAccount,
  ConnectorAccountStore,
  ProjectBinding,
  ProjectBindingStore,
  RequirementBinding,
  RequirementBindingStore,
} from "./types.ts";

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Ascending comparator over a `created_at` string field (lexicographic). */
function byCreatedAtAsc(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/**
 * Read every `<id>.json` (skipping `.json.tmp`, directories, and unparseable
 * files) directly under `dir`, returning the parsed rows. A missing directory
 * yields an empty list (graceful ENOENT). Mirrors Rust's `read_json_records`.
 */
async function readJsonRecords<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
    let bytes: string;
    try {
      bytes = await readFile(path.join(dir, name), "utf8");
    } catch (e) {
      if (isNotFound(e) || (e as { code?: string }).code === "EISDIR") continue;
      throw e;
    }
    try {
      out.push(JSON.parse(bytes) as T);
    } catch {
      // unparseable row — skip, matching the lenient sibling stores.
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// In-memory backends (tests / ephemeral deployments)
// ---------------------------------------------------------------------

export class MemoryConnectorAccountStore implements ConnectorAccountStore {
  readonly #rows = new Map<string, ConnectorAccount>();

  upsert(account: ConnectorAccount): Promise<void> {
    this.#rows.set(account.id, structuredClone(account));
    return Promise.resolve();
  }

  get(id: string): Promise<ConnectorAccount | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  list(): Promise<ConnectorAccount[]> {
    const rows = [...this.#rows.values()].map((r) => structuredClone(r)).sort(byCreatedAtAsc);
    return Promise.resolve(rows);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}

export class MemoryProjectBindingStore implements ProjectBindingStore {
  readonly #rows = new Map<string, ProjectBinding>();

  upsert(binding: ProjectBinding): Promise<void> {
    this.#rows.set(binding.id, structuredClone(binding));
    return Promise.resolve();
  }

  get(id: string): Promise<ProjectBinding | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  list(projectId?: string): Promise<ProjectBinding[]> {
    const rows = [...this.#rows.values()]
      .filter((b) => projectId === undefined || b.project_id === projectId)
      .map((r) => structuredClone(r))
      .sort(byCreatedAtAsc);
    return Promise.resolve(rows);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}

export class MemoryRequirementBindingStore implements RequirementBindingStore {
  readonly #rows = new Map<string, RequirementBinding>();

  upsert(binding: RequirementBinding): Promise<void> {
    this.#rows.set(binding.id, structuredClone(binding));
    return Promise.resolve();
  }

  get(id: string): Promise<RequirementBinding | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  listForProjectBinding(projectBindingId: string): Promise<RequirementBinding[]> {
    const rows = [...this.#rows.values()]
      .filter((b) => b.project_binding_id === projectBindingId)
      .map((r) => structuredClone(r))
      .sort(byCreatedAtAsc);
    return Promise.resolve(rows);
  }

  findByRemote(
    projectBindingId: string,
    remoteTaskId: string,
  ): Promise<RequirementBinding | undefined> {
    const row = [...this.#rows.values()].find(
      (b) => b.project_binding_id === projectBindingId && b.remote_task_id === remoteTaskId,
    );
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  findByRequirement(requirementId: string): Promise<RequirementBinding | undefined> {
    const row = [...this.#rows.values()].find((b) => b.requirement_id === requirementId);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}

// ---------------------------------------------------------------------
// JSON-file backends (default persistence)
// ---------------------------------------------------------------------

/**
 * Per-row JSON store rooted at `<dir>/<subdir>/`. Shared base for the three
 * connector stores; mirrors Rust's `json_row_store!` macro.
 */
abstract class JsonRowStore<T extends { id: string; created_at: string }> {
  protected readonly dir: string;
  readonly #subdir: string;

  protected constructor(dir: string, subdir: string) {
    this.dir = dir;
    this.#subdir = subdir;
  }

  protected static async ensure(dir: string, subdir: string): Promise<void> {
    await ensureDir(dir);
    await ensureDir(path.join(dir, subdir));
  }

  #rowPath(id: string): string {
    return path.join(this.dir, this.#subdir, `${encodeId(id)}.json`);
  }

  protected async writeRow(row: T): Promise<void> {
    await atomicWrite(this.#rowPath(row.id), JSON.stringify(row, null, 2));
  }

  protected async readRow(id: string): Promise<T | undefined> {
    try {
      const bytes = await readFile(this.#rowPath(id), "utf8");
      return JSON.parse(bytes) as T;
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  protected async deleteRow(id: string): Promise<boolean> {
    try {
      await rm(this.#rowPath(id));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  protected allRows(): Promise<T[]> {
    return readJsonRecords<T>(path.join(this.dir, this.#subdir));
  }
}

export class JsonFileConnectorAccountStore
  extends JsonRowStore<ConnectorAccount>
  implements ConnectorAccountStore
{
  private constructor(dir: string) {
    super(dir, "connector_accounts");
  }

  static async open(dir: string): Promise<JsonFileConnectorAccountStore> {
    await JsonRowStore.ensure(dir, "connector_accounts");
    return new JsonFileConnectorAccountStore(dir);
  }

  upsert(account: ConnectorAccount): Promise<void> {
    return this.writeRow(account);
  }

  get(id: string): Promise<ConnectorAccount | undefined> {
    return this.readRow(id);
  }

  async list(): Promise<ConnectorAccount[]> {
    const rows = await this.allRows();
    rows.sort(byCreatedAtAsc);
    return rows;
  }

  delete(id: string): Promise<boolean> {
    return this.deleteRow(id);
  }
}

export class JsonFileProjectBindingStore
  extends JsonRowStore<ProjectBinding>
  implements ProjectBindingStore
{
  private constructor(dir: string) {
    super(dir, "project_bindings");
  }

  static async open(dir: string): Promise<JsonFileProjectBindingStore> {
    await JsonRowStore.ensure(dir, "project_bindings");
    return new JsonFileProjectBindingStore(dir);
  }

  upsert(binding: ProjectBinding): Promise<void> {
    return this.writeRow(binding);
  }

  get(id: string): Promise<ProjectBinding | undefined> {
    return this.readRow(id);
  }

  async list(projectId?: string): Promise<ProjectBinding[]> {
    let rows = await this.allRows();
    if (projectId !== undefined) rows = rows.filter((b) => b.project_id === projectId);
    rows.sort(byCreatedAtAsc);
    return rows;
  }

  delete(id: string): Promise<boolean> {
    return this.deleteRow(id);
  }
}

export class JsonFileRequirementBindingStore
  extends JsonRowStore<RequirementBinding>
  implements RequirementBindingStore
{
  private constructor(dir: string) {
    super(dir, "requirement_bindings");
  }

  static async open(dir: string): Promise<JsonFileRequirementBindingStore> {
    await JsonRowStore.ensure(dir, "requirement_bindings");
    return new JsonFileRequirementBindingStore(dir);
  }

  upsert(binding: RequirementBinding): Promise<void> {
    return this.writeRow(binding);
  }

  get(id: string): Promise<RequirementBinding | undefined> {
    return this.readRow(id);
  }

  async listForProjectBinding(projectBindingId: string): Promise<RequirementBinding[]> {
    const rows = (await this.allRows()).filter(
      (b) => b.project_binding_id === projectBindingId,
    );
    rows.sort(byCreatedAtAsc);
    return rows;
  }

  async findByRemote(
    projectBindingId: string,
    remoteTaskId: string,
  ): Promise<RequirementBinding | undefined> {
    const rows = await this.allRows();
    return rows.find(
      (b) => b.project_binding_id === projectBindingId && b.remote_task_id === remoteTaskId,
    );
  }

  async findByRequirement(requirementId: string): Promise<RequirementBinding | undefined> {
    const rows = await this.allRows();
    return rows.find((b) => b.requirement_id === requirementId);
  }

  delete(id: string): Promise<boolean> {
    return this.deleteRow(id);
  }
}
