// ProjectStore backends. Ported from harness-store/src/json_file.rs
// (`JsonFileProjectStore`) + memory.rs (`MemoryProjectStore`).
//
// A `Project` is the kanban board's container. The store enforces ONE
// invariant beyond plain CRUD: slug uniqueness — `save` rejects a project
// whose slug is already owned by a *different* id. `archive` is a soft-delete
// (flips `archived = true`, idempotent); `delete` is a hard remove. `list`
// hides archived rows unless asked, newest-updated first, capped at `limit`.
//
// ProjectStore is NOT an EventSource — Rust's trait carries no broadcast
// channel, so neither backend fans anything out.
//
// Disk layout: `<base>/projects/<encodeId(id)>.json`, one file per project,
// atomic tmp+rename writes, RFC-3339 timestamps in the body.
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Project, ProjectStore } from "@jarvis/project";
import { archiveProject } from "@jarvis/project";
import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";
import { byDescString, isNotFound, readJsonDir, readJsonFile } from "./fs-util.ts";

/** Reject a save whose slug collides with a different existing project. */
function assertSlugFree(existing: readonly Project[], project: Project): void {
  for (const p of existing) {
    if (p.id !== project.id && p.slug === project.slug) {
      throw new Error(`project slug '${project.slug}' already in use by id=${p.id}`);
    }
  }
}

export class JsonFileProjectStore implements ProjectStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Open or create a store at `<baseDir>/projects/` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileProjectStore> {
    const dir = path.join(baseDir, "projects");
    await ensureDir(dir);
    return new JsonFileProjectStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async save(project: Project): Promise<void> {
    const existing = await readJsonDir<Project>(this.#dir);
    assertSlugFree(existing, project);
    await atomicWrite(this.#pathFor(project.id), JSON.stringify(project, null, 2));
  }

  async load(id: string): Promise<Project | undefined> {
    return readJsonFile<Project>(this.#pathFor(id));
  }

  async findBySlug(slug: string): Promise<Project | undefined> {
    const projects = await readJsonDir<Project>(this.#dir);
    return projects.find((p) => p.slug === slug);
  }

  async list(includeArchived: boolean, limit: number): Promise<Project[]> {
    let projects = await readJsonDir<Project>(this.#dir);
    if (!includeArchived) projects = projects.filter((p) => !p.archived);
    projects.sort((a, b) => byDescString(a.updated_at, b.updated_at));
    return projects.slice(0, limit);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(id));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async archive(id: string): Promise<boolean> {
    const project = await this.load(id);
    if (!project) return false;
    archiveProject(project);
    await this.save(project);
    return true;
  }
}

/**
 * In-memory ProjectStore. Backs tests + the server's no-DB fallback. Same
 * slug-uniqueness + archive/delete semantics as the JSON-file backend.
 */
export class MemoryProjectStore implements ProjectStore {
  readonly #rows = new Map<string, Project>();

  // `async` (not bare `Promise.resolve`) so the slug-collision throw surfaces
  // as a rejected Promise — a synchronous throw here would escape `await`.
  async save(project: Project): Promise<void> {
    assertSlugFree([...this.#rows.values()], project);
    // Defensive clone so a caller mutating its copy can't reach into the store.
    this.#rows.set(project.id, structuredClone(project));
  }

  load(id: string): Promise<Project | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : undefined);
  }

  findBySlug(slug: string): Promise<Project | undefined> {
    for (const p of this.#rows.values()) {
      if (p.slug === slug) return Promise.resolve(structuredClone(p));
    }
    return Promise.resolve(undefined);
  }

  list(includeArchived: boolean, limit: number): Promise<Project[]> {
    const rows = [...this.#rows.values()]
      .filter((p) => includeArchived || !p.archived)
      .sort((a, b) => byDescString(a.updated_at, b.updated_at))
      .slice(0, limit)
      .map((p) => structuredClone(p));
    return Promise.resolve(rows);
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }

  archive(id: string): Promise<boolean> {
    const row = this.#rows.get(id);
    if (!row) return Promise.resolve(false);
    archiveProject(row);
    return Promise.resolve(true);
  }
}
