// LabelStore backends — project-scoped tags for kanban Requirement rows.
//
// Ported from crates/harness-store/src/{json_file.rs,memory.rs} (the
// `*LabelStore` impls). Labels are project-scoped entities referenced by id
// from `Requirement.label_ids`. Name uniqueness is enforced per project,
// case-insensitively, on every mutation.
//
// `listForProject` returns labels sorted by name case-insensitively (Rust
// `sort_by_key(|l| l.name.to_lowercase())`). `get` walks every project bucket
// (the REST layer almost always knows the project, so a by-id fetch is rare).
// `create` rejects a same-name (case-insensitive) sibling and a duplicate id;
// broadcasts `created`. `update` checks uniqueness skipping itself, pins
// id / project_id / created_at from the on-disk row, mutates the rest; resolves
// `false` when absent; broadcasts `updated`. `delete` broadcasts `deleted` only
// on the row-removed path.
//
// On-disk layout (partitioned by project, mirrors Rust):
//   <base>/labels/<encodeId(project_id)>/<encodeId(id)>.json
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  EventListener,
  Label,
  LabelEvent,
  LabelStore,
  Unsubscribe,
} from "@jarvis/project";
import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";

// ---------- shared listener fan-out ----------

class Listeners<E> {
  #fns: EventListener<E>[] = [];

  subscribe(listener: EventListener<E>): Unsubscribe {
    this.#fns.push(listener);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.#fns.indexOf(listener);
      if (i !== -1) this.#fns.splice(i, 1);
    };
  }

  emit(event: E): void {
    // Isolate each listener so a throwing subscriber can't reject the
    // already-committed write or starve listeners registered after it.
    for (const fn of [...this.#fns]) {
      try {
        fn(event);
      } catch {
        // swallow: the mutation already succeeded.
      }
    }
  }
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Case-insensitive name equality (matches Rust `eq_ignore_ascii_case`). */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Sort by lowercased name (matches Rust `sort_by_key(|l| l.name.to_lowercase())`). */
function sortByName(rows: Label[]): Label[] {
  rows.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return rows;
}

// ---------- JSON-file backend ----------

export class JsonFileLabelStore implements LabelStore {
  readonly #base: string;
  readonly #listeners = new Listeners<LabelEvent>();

  private constructor(base: string) {
    this.#base = base;
  }

  /** Open or create a store rooted at `base` (the `labels/` subdir is created lazily). */
  static async open(base: string): Promise<JsonFileLabelStore> {
    await ensureDir(base);
    return new JsonFileLabelStore(base);
  }

  #labelsRoot(): string {
    return path.join(this.#base, "labels");
  }

  #projectDir(projectId: string): string {
    return path.join(this.#labelsRoot(), encodeId(projectId));
  }

  #pathFor(projectId: string, id: string): string {
    return path.join(this.#projectDir(projectId), `${encodeId(id)}.json`);
  }

  /** Read every label row in the project bucket (unsorted). */
  async #loadBucket(projectId: string): Promise<Label[]> {
    const dir = this.#projectDir(projectId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: Label[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      let bytes: string;
      try {
        bytes = await readFile(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        rows.push(JSON.parse(bytes) as Label);
      } catch {
        // skip unparseable
      }
    }
    return rows;
  }

  async listForProject(projectId: string): Promise<Label[]> {
    return sortByName(await this.#loadBucket(projectId));
  }

  async get(id: string): Promise<Label | undefined> {
    // Project is unknown up front → walk every project bucket. Acceptable
    // because labels are rarely fetched by id alone.
    let entries: string[];
    try {
      entries = await readdir(this.#labelsRoot());
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
    const target = `${encodeId(id)}.json`;
    for (const entry of entries) {
      const candidate = path.join(this.#labelsRoot(), entry, target);
      let bytes: string;
      try {
        bytes = await readFile(candidate, "utf8");
      } catch (e) {
        // ENOENT (no such label in this bucket) or EISDIR/ENOTDIR (entry is a
        // file, not a project dir) → skip; everything else bubbles.
        const code = (e as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") continue;
        throw e;
      }
      try {
        return JSON.parse(bytes) as Label;
      } catch {
        // unparseable → keep scanning
      }
    }
    return undefined;
  }

  async create(label: Label): Promise<void> {
    const bucket = await this.#loadBucket(label.project_id);
    if (bucket.some((l) => sameName(l.name, label.name))) {
      throw new Error(`label name \`${label.name}\` already exists in project`);
    }
    const filePath = this.#pathFor(label.project_id, label.id);
    if (await fileExists(filePath)) {
      throw new Error(`label id \`${label.id}\` already exists`);
    }
    await ensureDir(this.#projectDir(label.project_id));
    await atomicWrite(filePath, JSON.stringify(label, null, 2));
    this.#listeners.emit({ type: "created", ...label });
  }

  async update(label: Label): Promise<boolean> {
    const filePath = this.#pathFor(label.project_id, label.id);
    let bytes: string;
    try {
      bytes = await readFile(filePath, "utf8");
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
    const existing = JSON.parse(bytes) as Label;
    // Uniqueness check skipping ourselves.
    const bucket = await this.#loadBucket(label.project_id);
    if (bucket.some((l) => l.id !== label.id && sameName(l.name, label.name))) {
      throw new Error(`label name \`${label.name}\` already exists in project`);
    }
    // id / project_id / created_at pinned to on-disk; name / colour /
    // description / updated_at come from the patch.
    const merged: Label = {
      id: existing.id,
      project_id: existing.project_id,
      created_at: existing.created_at,
      name: label.name,
      colour: label.colour,
      updated_at: label.updated_at,
    };
    if (label.description != null) merged.description = label.description;
    await atomicWrite(filePath, JSON.stringify(merged, null, 2));
    this.#listeners.emit({ type: "updated", ...merged });
    return true;
  }

  async delete(projectId: string, labelId: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(projectId, labelId));
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
    this.#listeners.emit({ type: "deleted", project_id: projectId, label_id: labelId });
    return true;
  }

  subscribe(listener: EventListener<LabelEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

// ---------- in-memory backend ----------

export class MemoryLabelStore implements LabelStore {
  readonly #byProject = new Map<string, Label[]>();
  readonly #listeners = new Listeners<LabelEvent>();

  listForProject(projectId: string): Promise<Label[]> {
    const rows = (this.#byProject.get(projectId) ?? []).map((l) => ({ ...l }));
    return Promise.resolve(sortByName(rows));
  }

  get(id: string): Promise<Label | undefined> {
    for (const bucket of this.#byProject.values()) {
      const found = bucket.find((l) => l.id === id);
      if (found) return Promise.resolve({ ...found });
    }
    return Promise.resolve(undefined);
  }

  create(label: Label): Promise<void> {
    const bucket = this.#byProject.get(label.project_id) ?? [];
    if (bucket.some((l) => sameName(l.name, label.name))) {
      return Promise.reject(new Error(`label name \`${label.name}\` already exists in project`));
    }
    if (bucket.some((l) => l.id === label.id)) {
      return Promise.reject(new Error(`label id \`${label.id}\` already exists`));
    }
    bucket.push({ ...label });
    this.#byProject.set(label.project_id, bucket);
    this.#listeners.emit({ type: "created", ...label });
    return Promise.resolve();
  }

  update(label: Label): Promise<boolean> {
    const bucket = this.#byProject.get(label.project_id);
    if (!bucket) return Promise.resolve(false);
    if (bucket.some((l) => l.id !== label.id && sameName(l.name, label.name))) {
      return Promise.reject(new Error(`label name \`${label.name}\` already exists in project`));
    }
    const slot = bucket.find((l) => l.id === label.id);
    if (!slot) return Promise.resolve(false);
    slot.name = label.name;
    slot.colour = label.colour;
    if (label.description != null) slot.description = label.description;
    else delete slot.description;
    slot.updated_at = label.updated_at;
    this.#listeners.emit({ type: "updated", ...slot });
    return Promise.resolve(true);
  }

  delete(projectId: string, labelId: string): Promise<boolean> {
    const bucket = this.#byProject.get(projectId);
    if (!bucket) return Promise.resolve(false);
    const before = bucket.length;
    const next = bucket.filter((l) => l.id !== labelId);
    if (next.length === before) return Promise.resolve(false);
    this.#byProject.set(projectId, next);
    this.#listeners.emit({ type: "deleted", project_id: projectId, label_id: labelId });
    return Promise.resolve(true);
  }

  subscribe(listener: EventListener<LabelEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}
