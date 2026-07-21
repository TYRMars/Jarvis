// CommentStore backends — per-Requirement discussion threads.
//
// Ported from crates/harness-store/src/{json_file.rs,memory.rs} (the
// `*CommentStore` impls). Where Activity is "what happened", Comment is "what
// people / agents said". Comments are NOT append-only: operators edit + delete.
//
// `listForRequirement` is oldest-first by `created_at` (chat order), soft-capped
// at 500. `create` enforces the depth-1 threading invariant (a reply may only
// point at a top-level comment) and rejects a duplicate id; broadcasts `posted`.
// `update` only mutates `body` + `updated_at`, pinning the immutable fields from
// the existing row; resolves `false` when the id is absent; broadcasts `edited`.
// `delete` cascades a top-level comment's direct replies and broadcasts one
// `deleted` per row removed.
//
// On-disk layout (partitioned by requirement, mirrors Rust):
//   <base>/comments/<encodeId(requirement_id)>/<encodeId(id)>.json
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  Comment,
  CommentEvent,
  CommentStore,
  EventListener,
  Unsubscribe,
} from "@jarvis/project";
import { atomicWrite, encodeId, ensureDir } from "./json-file.ts";

const LIST_CAP = 500;

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
    // Snapshot so an unsubscribe during delivery doesn't perturb the loop, and
    // isolate each listener so a throwing subscriber neither rejects the
    // already-committed write nor starves later listeners.
    for (const fn of [...this.#fns]) {
      try {
        fn(event);
      } catch {
        // Swallow listener faults; the store mutation already succeeded.
      }
    }
  }
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Oldest-first by `created_at`, soft-capped at {@link LIST_CAP}. */
function sortOldestFirstCapped(rows: Comment[]): Comment[] {
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  if (rows.length > LIST_CAP) rows.length = LIST_CAP;
  return rows;
}

/**
 * Pure depth-1 parent validation shared by both backends. Returns an error
 * message string when the parent is missing or is itself a reply, else
 * `undefined`. Mirrors the Rust match in both `create` impls.
 */
function parentError(bucket: readonly Comment[], parentId: string): string | undefined {
  const parent = bucket.find((c) => c.id === parentId);
  if (!parent) return `parent comment \`${parentId}\` not found in requirement`;
  if (parent.parent_id != null) {
    return "comment threading is limited to depth 1 (cannot reply to a reply)";
  }
  return undefined;
}

// ---------- JSON-file backend ----------

export class JsonFileCommentStore implements CommentStore {
  readonly #base: string;
  readonly #listeners = new Listeners<CommentEvent>();

  private constructor(base: string) {
    this.#base = base;
  }

  /** Open or create a store rooted at `base` (the `comments/` subdir is created lazily). */
  static async open(base: string): Promise<JsonFileCommentStore> {
    await ensureDir(base);
    return new JsonFileCommentStore(base);
  }

  #requirementDir(requirementId: string): string {
    return path.join(this.#base, "comments", encodeId(requirementId));
  }

  #pathFor(requirementId: string, id: string): string {
    return path.join(this.#requirementDir(requirementId), `${encodeId(id)}.json`);
  }

  /** Read every comment row in the requirement bucket (unsorted). */
  async #loadBucket(requirementId: string): Promise<Comment[]> {
    const dir = this.#requirementDir(requirementId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: Comment[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      let bytes: string;
      try {
        bytes = await readFile(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      try {
        rows.push(JSON.parse(bytes) as Comment);
      } catch {
        // skip unparseable
      }
    }
    return rows;
  }

  async listForRequirement(requirementId: string): Promise<Comment[]> {
    return sortOldestFirstCapped(await this.#loadBucket(requirementId));
  }

  async create(comment: Comment): Promise<void> {
    if (comment.parent_id != null) {
      const bucket = await this.#loadBucket(comment.requirement_id);
      const err = parentError(bucket, comment.parent_id);
      if (err) throw new Error(err);
    }
    const filePath = this.#pathFor(comment.requirement_id, comment.id);
    // Reject duplicate id deterministically (the FS would happily overwrite,
    // which is wrong for `create`).
    if (await fileExists(filePath)) {
      throw new Error(`comment id \`${comment.id}\` already exists`);
    }
    await ensureDir(this.#requirementDir(comment.requirement_id));
    await atomicWrite(filePath, JSON.stringify(comment, null, 2));
    this.#listeners.emit({ type: "posted", ...comment });
  }

  async update(comment: Comment): Promise<boolean> {
    const filePath = this.#pathFor(comment.requirement_id, comment.id);
    let bytes: string;
    try {
      bytes = await readFile(filePath, "utf8");
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
    const existing = JSON.parse(bytes) as Comment;
    // Only `body` + `updated_at` are caller-mutable; everything else is pinned
    // to the on-disk row.
    const merged: Comment = {
      ...existing,
      body: comment.body,
      updated_at: comment.updated_at,
    };
    await atomicWrite(filePath, JSON.stringify(merged, null, 2));
    this.#listeners.emit({ type: "edited", ...merged });
    return true;
  }

  async delete(requirementId: string, commentId: string): Promise<boolean> {
    const bucket = await this.#loadBucket(requirementId);
    const target = bucket.find((c) => c.id === commentId);
    if (!target) return false;
    const toRemove = [target.id];
    if (target.parent_id == null) {
      for (const c of bucket) {
        if (c.parent_id === commentId) toRemove.push(c.id);
      }
    }
    for (const id of toRemove) {
      try {
        await rm(this.#pathFor(requirementId, id));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      this.#listeners.emit({ type: "deleted", requirement_id: requirementId, comment_id: id });
    }
    return true;
  }

  subscribe(listener: EventListener<CommentEvent>): Unsubscribe {
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

export class MemoryCommentStore implements CommentStore {
  readonly #byRequirement = new Map<string, Comment[]>();
  readonly #listeners = new Listeners<CommentEvent>();

  listForRequirement(requirementId: string): Promise<Comment[]> {
    const rows = (this.#byRequirement.get(requirementId) ?? []).map((c) => ({ ...c }));
    return Promise.resolve(sortOldestFirstCapped(rows));
  }

  create(comment: Comment): Promise<void> {
    const list = this.#byRequirement.get(comment.requirement_id) ?? [];
    if (comment.parent_id != null) {
      const err = parentError(list, comment.parent_id);
      if (err) return Promise.reject(new Error(err));
    }
    if (list.some((c) => c.id === comment.id)) {
      return Promise.reject(new Error(`comment id \`${comment.id}\` already exists`));
    }
    list.push({ ...comment });
    this.#byRequirement.set(comment.requirement_id, list);
    this.#listeners.emit({ type: "posted", ...comment });
    return Promise.resolve();
  }

  update(comment: Comment): Promise<boolean> {
    const list = this.#byRequirement.get(comment.requirement_id);
    const slot = list?.find((c) => c.id === comment.id);
    if (!slot) return Promise.resolve(false);
    // Only `body` + `updated_at` mutate; the rest of the row is untouched.
    slot.body = comment.body;
    slot.updated_at = comment.updated_at;
    this.#listeners.emit({ type: "edited", ...slot });
    return Promise.resolve(true);
  }

  delete(requirementId: string, commentId: string): Promise<boolean> {
    const list = this.#byRequirement.get(requirementId);
    if (!list) return Promise.resolve(false);
    const target = list.find((c) => c.id === commentId);
    if (!target) return Promise.resolve(false);
    const toRemove = new Set([target.id]);
    if (target.parent_id == null) {
      for (const c of list) {
        if (c.parent_id === commentId) toRemove.add(c.id);
      }
    }
    this.#byRequirement.set(
      requirementId,
      list.filter((c) => !toRemove.has(c.id)),
    );
    for (const id of toRemove) {
      this.#listeners.emit({ type: "deleted", requirement_id: requirementId, comment_id: id });
    }
    return Promise.resolve(true);
  }

  subscribe(listener: EventListener<CommentEvent>): Unsubscribe {
    return this.#listeners.subscribe(listener);
  }
}
