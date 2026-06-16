// JsonFileTodoStore. Ported from harness-store/src/json_file.rs
// (`JsonFileTodoStore`).
//
// One JSON file per TODO, partitioned by workspace under a `todos/`
// subdirectory: `<base>/todos/<encodeId(workspace)>/<encodeId(id)>.json`. The
// workspace key in the path is percent-encoded the same way conversation ids
// are, so a workspace path containing `/`, `:`, etc. is filesystem-safe.
//
// The store is an EventSource<TodoEvent>: `upsert` fans out an `upserted` frame
// after a successful write, `delete` fans out a `deleted` frame ONLY on the
// true path (a no-op delete of an absent id stays silent).
//
// `get` / `delete` take only an id (the row carries its own workspace), so they
// walk every workspace subdir to find the file. `list(workspace)` is a single
// directory read, sorted newest-`updated_at`-first, capped at 500.
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type { TodoEvent, TodoItem } from "./todo.ts";
import { todoDeletedEvent, todoUpsertedEvent } from "./todo.ts";
import type { TodoStore } from "./store.ts";
import { TODO_LIST_CAP } from "./store.ts";
import type { EventListener, Unsubscribe } from "./event-source.ts";
import { Fanout } from "./event-source.ts";

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function isDirError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "EISDIR";
}

/** Read + parse a JSON file; undefined if missing, a directory, or unparseable. */
async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e) || isDirError(e)) return undefined;
    throw e;
  }
  try {
    return JSON.parse(bytes) as T;
  } catch {
    return undefined;
  }
}

/** Newest-first comparator over an RFC-3339 string field (lexicographic). */
function byDescUpdatedAt(a: TodoItem, b: TodoItem): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

export class JsonFileTodoStore implements TodoStore {
  readonly #root: string; // <base>/todos
  readonly #fanout = new Fanout<TodoEvent>();

  private constructor(root: string) {
    this.#root = root;
  }

  /**
   * Open or create a store at `<baseDir>/todos/`. Per-workspace subdirectories
   * are created lazily on first write.
   */
  static async open(baseDir: string): Promise<JsonFileTodoStore> {
    const root = path.join(baseDir, "todos");
    await ensureDir(root);
    return new JsonFileTodoStore(root);
  }

  subscribe(listener: EventListener<TodoEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #workspaceDir(workspace: string): string {
    return path.join(this.#root, encodeId(workspace));
  }

  #pathFor(workspace: string, id: string): string {
    return path.join(this.#workspaceDir(workspace), `${encodeId(id)}.json`);
  }

  /** Walk every workspace subdir to find a TODO by its globally-unique id. */
  async #findById(id: string): Promise<TodoItem | undefined> {
    const target = `${encodeId(id)}.json`;
    let subdirs: string[];
    try {
      const entries = await readdir(this.#root, { withFileTypes: true });
      subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
    for (const sub of subdirs) {
      const row = await readJsonFile<TodoItem>(path.join(this.#root, sub, target));
      if (row !== undefined) return row;
    }
    return undefined;
  }

  async list(workspace: string): Promise<TodoItem[]> {
    const dir = this.#workspaceDir(workspace);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: TodoItem[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const row = await readJsonFile<TodoItem>(path.join(dir, name));
      if (row !== undefined) rows.push(row);
    }
    rows.sort(byDescUpdatedAt);
    return rows.slice(0, TODO_LIST_CAP);
  }

  get(id: string): Promise<TodoItem | undefined> {
    return this.#findById(id);
  }

  async upsert(item: TodoItem): Promise<void> {
    const dir = this.#workspaceDir(item.workspace);
    await ensureDir(dir);
    await atomicWrite(this.#pathFor(item.workspace, item.id), JSON.stringify(item, null, 2));
    this.#fanout.emit(todoUpsertedEvent(item));
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.#findById(id);
    if (existing === undefined) return false;
    let removed: boolean;
    try {
      await rm(this.#pathFor(existing.workspace, existing.id));
      removed = true;
    } catch (e) {
      if (isNotFound(e)) removed = false;
      else throw e;
    }
    if (removed) {
      this.#fanout.emit(todoDeletedEvent(existing.workspace, existing.id));
    }
    return removed;
  }
}
