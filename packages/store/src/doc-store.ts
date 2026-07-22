// DocStore backends — JSON-file + in-memory.
//
// Ported from the DocStore halves of crates/harness-store/src/json_file.rs
// (JsonFileDocStore) and memory.rs (MemoryDocStore). One trait covers both
// DocProject and DocDraft because they share a single event fanout: mutations
// on either type broadcast through the same source as `DocEvent`s.
//
// On-disk layout mirrors the Rust backend:
//
//   <base>/docs/projects/<encodeId(id)>.json
//   <base>/docs/drafts/<encodeId(project_id)>/<encodeId(id)>.json
//
// Subdirectories are created lazily on first write. `deleteProject` removes the
// project file and cascade-removes the whole drafts subdir for that project.
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  docStoreLatestDraft,
  type DocDraft,
  type DocEvent,
  type DocProject,
  type DocStore,
  type EventListener,
  type Unsubscribe,
} from "@jarvis/project";
import { atomicWrite, encodeId, encodeIdSegment, ensureDir } from "./json-file.ts";

/** Soft cap on the number of DocProjects returned by `listProjects`. */
const PROJECT_LIST_CAP = 500;

// ---------- synchronous listener fanout ----------

/**
 * In-process event fanout — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener and returns a detach function; `emit`
 * synchronously notifies every current listener. A listener that throws does
 * not abort the others (mirrors broadcast's per-receiver isolation).
 */
class Listeners<E> {
  #listeners = new Set<EventListener<E>>();

  subscribe(listener: EventListener<E>): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: E): void {
    // Snapshot so a listener that subscribes/unsubscribes during delivery
    // doesn't perturb this fan-out pass.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Isolate listener faults; the mutation already succeeded.
      }
    }
  }
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read + parse a JSON file; undefined if missing, a directory, or unparseable. */
async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(filePath, "utf8");
  } catch (e) {
    if (isNotFound(e) || (e as { code?: string }).code === "EISDIR") return undefined;
    throw e;
  }
  try {
    return JSON.parse(bytes) as T;
  } catch {
    return undefined;
  }
}

/** Newest-first by `updated_at` (RFC-3339 strings sort lexicographically). */
function byUpdatedDesc(a: { updated_at: string }, b: { updated_at: string }): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

// ---------- JSON-file backend ----------

export class JsonFileDocStore implements DocStore {
  readonly #base: string;
  readonly #listeners = new Listeners<DocEvent>();

  private constructor(base: string) {
    this.#base = base;
  }

  /**
   * Open or create a store at `<base>/docs/`. The base dir is created
   * recursively; the `projects/` and `drafts/<project>/` subdirs are created
   * lazily on first write (matching the Rust backend).
   */
  static async open(base: string): Promise<JsonFileDocStore> {
    await ensureDir(base);
    return new JsonFileDocStore(base);
  }

  #projectsDir(): string {
    return path.join(this.#base, "docs", "projects");
  }

  #draftsDir(projectId: string): string {
    return path.join(this.#base, "docs", "drafts", encodeIdSegment(projectId));
  }

  #projectPath(id: string): string {
    return path.join(this.#projectsDir(), `${encodeId(id)}.json`);
  }

  #draftPath(projectId: string, id: string): string {
    return path.join(this.#draftsDir(projectId), `${encodeId(id)}.json`);
  }

  subscribe(listener: EventListener<DocEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }

  async listProjects(workspace: string): Promise<DocProject[]> {
    let names: string[];
    try {
      names = await readdir(this.#projectsDir());
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: DocProject[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const item = await readJsonFile<DocProject>(path.join(this.#projectsDir(), name));
      if (item && item.workspace === workspace) rows.push(item);
    }
    rows.sort(byUpdatedDesc);
    return rows.slice(0, PROJECT_LIST_CAP);
  }

  async getProject(id: string): Promise<DocProject | undefined> {
    return await readJsonFile<DocProject>(this.#projectPath(id));
  }

  async upsertProject(project: DocProject): Promise<void> {
    await ensureDir(this.#projectsDir());
    await atomicWrite(this.#projectPath(project.id), JSON.stringify(project, null, 2));
    this.#listeners.emit({ type: "project_upserted", ...project });
  }

  async deleteProject(id: string): Promise<boolean> {
    const project = await this.getProject(id);
    if (!project) return false;
    // Remove the project file, then cascade-remove the drafts subdir.
    await rm(this.#projectPath(id), { force: true });
    await rm(this.#draftsDir(id), { recursive: true, force: true });
    this.#listeners.emit({ type: "project_deleted", workspace: project.workspace, id: project.id });
    return true;
  }

  async listDrafts(projectId: string): Promise<DocDraft[]> {
    let names: string[];
    try {
      names = await readdir(this.#draftsDir(projectId));
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: DocDraft[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const item = await readJsonFile<DocDraft>(path.join(this.#draftsDir(projectId), name));
      if (item) rows.push(item);
    }
    rows.sort(byUpdatedDesc);
    return rows;
  }

  latestDraft(projectId: string): Promise<DocDraft | undefined> {
    // listDrafts is newest-first, so the head is the latest.
    return docStoreLatestDraft(this, projectId);
  }

  async upsertDraft(draft: DocDraft): Promise<void> {
    await ensureDir(this.#draftsDir(draft.project_id));
    await atomicWrite(this.#draftPath(draft.project_id, draft.id), JSON.stringify(draft, null, 2));
    this.#listeners.emit({ type: "draft_upserted", ...draft });
  }
}

// ---------- in-memory backend ----------

/**
 * In-process DocStore. Projects + drafts in two maps; one synchronous fanout
 * shared by every caller. Backs tests and the server's no-DB fallback.
 */
export class MemoryDocStore implements DocStore {
  #projects = new Map<string, DocProject>();
  #drafts = new Map<string, DocDraft>();
  readonly #listeners = new Listeners<DocEvent>();

  subscribe(listener: EventListener<DocEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }

  listProjects(workspace: string): Promise<DocProject[]> {
    const rows = [...this.#projects.values()].filter((p) => p.workspace === workspace);
    rows.sort(byUpdatedDesc);
    return Promise.resolve(rows.slice(0, PROJECT_LIST_CAP).map((p) => ({ ...p })));
  }

  getProject(id: string): Promise<DocProject | undefined> {
    const p = this.#projects.get(id);
    return Promise.resolve(p ? { ...p } : undefined);
  }

  upsertProject(project: DocProject): Promise<void> {
    this.#projects.set(project.id, { ...project });
    this.#listeners.emit({ type: "project_upserted", ...project });
    return Promise.resolve();
  }

  deleteProject(id: string): Promise<boolean> {
    const project = this.#projects.get(id);
    if (!project) return Promise.resolve(false);
    this.#projects.delete(id);
    // Cascade-delete this project's drafts.
    for (const [draftId, draft] of this.#drafts) {
      if (draft.project_id === id) this.#drafts.delete(draftId);
    }
    this.#listeners.emit({ type: "project_deleted", workspace: project.workspace, id: project.id });
    return Promise.resolve(true);
  }

  listDrafts(projectId: string): Promise<DocDraft[]> {
    const rows = [...this.#drafts.values()].filter((d) => d.project_id === projectId);
    rows.sort(byUpdatedDesc);
    return Promise.resolve(rows.map((d) => ({ ...d })));
  }

  latestDraft(projectId: string): Promise<DocDraft | undefined> {
    return docStoreLatestDraft(this, projectId);
  }

  upsertDraft(draft: DocDraft): Promise<void> {
    this.#drafts.set(draft.id, { ...draft });
    this.#listeners.emit({ type: "draft_upserted", ...draft });
    return Promise.resolve();
  }
}
