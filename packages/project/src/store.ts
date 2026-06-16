// Persistence traits for the project domain.
//
// Ported from crates/harness-project/src/store.rs. 8 stores, each scoped to
// a different row family. In Rust these are `#[async_trait]` traits with
// async methods + a `tokio::sync::broadcast` fanout. In the Node port:
//
// - Async methods become `Promise`-returning interface methods.
// - The Rust `subscribe() -> broadcast::Receiver<E>` fanout has no
//   tokio-broadcast equivalent. We model it as a simple typed
//   event-source: `subscribe(listener)` registers a callback and returns an
//   `Unsubscribe` function. Each successful mutation fans out to every
//   registered listener (the mirror of "broadcast on a channel"). Backends
//   in @jarvis/store implement these; this package owns only the surface.
//
// Concrete implementations live in @jarvis/store; this file is types only.
import type { Activity, ActivityEvent } from "./activity.ts";
import type { Comment, CommentEvent } from "./comment.ts";
import type { DocDraft, DocEvent, DocProject } from "./doc.ts";
import type { Label, LabelEvent } from "./label.ts";
import type { Project } from "./project.ts";
import type { ProjectMemory } from "./project-memory.ts";
import type { Requirement, RequirementEvent } from "./requirement.ts";
import type { RequirementRun, RequirementRunEvent } from "./requirement-run.ts";

/** Removes a previously-registered listener. Idempotent. */
export type Unsubscribe = () => void;

/** A listener for events of type `E`. */
export type EventListener<E> = (event: E) => void;

/**
 * Typed event-source — the Node stand-in for `tokio::sync::broadcast`.
 * `subscribe` registers a listener (mirrors Rust's `subscribe()` returning a
 * fresh receiver) and returns a function that detaches it. Unlike the Rust
 * receiver, listeners cannot lag — delivery is synchronous fan-out — so the
 * "refetch on RecvError::Lagged" advice from the Rust docs is moot here.
 */
export interface EventSource<E> {
  subscribe(listener: EventListener<E>): Unsubscribe;
}

/**
 * Persistence operations on {@link Project} rows. One row per project; slug
 * is unique. `delete` (hard) and `archive` (soft) are distinct.
 */
export interface ProjectStore {
  /** Insert or overwrite a project. The store rejects duplicate slugs. */
  save(project: Project): Promise<void>;
  /** Load by primary id (UUID). Resolves `undefined` if absent. */
  load(id: string): Promise<Project | undefined>;
  /** Look up by slug. Resolves `undefined` if absent. */
  findBySlug(slug: string): Promise<Project | undefined>;
  /**
   * List projects, newest-updated first. When `includeArchived` is false,
   * soft-deleted projects are skipped.
   */
  list(includeArchived: boolean, limit: number): Promise<Project[]>;
  /** Hard-delete a project row. Resolves `true` if a row was removed. */
  delete(id: string): Promise<boolean>;
  /**
   * Soft-delete: flip `archived = true`. Resolves `true` if a row was found
   * and updated. Idempotent — archiving an already-archived project still
   * resolves `true`.
   */
  archive(id: string): Promise<boolean>;
}

/**
 * Persistence operations on per-project {@link Requirement}s — the kanban
 * backlog under each Project. There is intentionally no soft-delete; deletes
 * are hard.
 */
export interface RequirementStore extends EventSource<RequirementEvent> {
  /**
   * Return up to ~500 requirements for `projectId`, sorted by `updated_at`
   * descending.
   */
  list(projectId: string): Promise<Requirement[]>;
  /** Look up by id (globally unique). Resolves `undefined` if absent. */
  get(id: string): Promise<Requirement | undefined>;
  /**
   * Insert or overwrite. Implementations must broadcast a `RequirementEvent`
   * `{ type: "upserted", ...item }` after a successful write.
   */
  upsert(item: Requirement): Promise<void>;
  /**
   * Delete by id. Resolves `true` if a row was removed; `false` if already
   * absent (idempotent). Implementations must broadcast
   * `{ type: "deleted", project_id, id }` only on the `true` path.
   */
  delete(id: string): Promise<boolean>;
}

/**
 * Persistence operations on per-requirement {@link RequirementRun}s — one
 * row per execution attempt. `upsert` is the only mutating verb; it must
 * broadcast a `RequirementRunEvent` derived from the transition:
 *
 * - absent → present, non-terminal status ⇒ `started`
 * - present → terminal status ⇒ `finished`
 * - otherwise no event
 *
 * `verified` events are emitted explicitly by the caller via {@link broadcast}.
 * There is intentionally no `delete` — runs are append-only history.
 */
export interface RequirementRunStore extends EventSource<RequirementRunEvent> {
  /**
   * Return up to ~200 runs for `requirementId`, sorted by `started_at`
   * descending (newest first).
   */
  listForRequirement(requirementId: string): Promise<RequirementRun[]>;
  /** Look up by id (globally unique). Resolves `undefined` if absent. */
  get(id: string): Promise<RequirementRun | undefined>;
  /**
   * Return up to `limit` runs across all requirements, sorted by
   * `started_at` descending. Used by the doctor / diagnostics endpoints.
   * Default-impl-equivalent backends may resolve an empty list.
   */
  listAll(limit: number): Promise<RequirementRun[]>;
  /**
   * Insert or overwrite a run row. Implementations must broadcast a
   * `RequirementRunEvent` reflecting the transition, per the rules above.
   */
  upsert(run: RequirementRun): Promise<void>;
  /**
   * Send an event into the fan-out without writing to disk. Used by callers
   * (the verification gate handler) that fan out a `verified` frame
   * separately from the upsert that wrote the verification result.
   */
  broadcast(event: RequirementRunEvent): void;
}

/** Append-only {@link Activity} audit log scoped to a Requirement. */
export interface ActivityStore extends EventSource<ActivityEvent> {
  /**
   * Return up to ~500 activities for `requirementId`, sorted by `created_at`
   * descending (newest first).
   */
  listForRequirement(requirementId: string): Promise<Activity[]>;
  /**
   * Append a single activity row. Implementations must broadcast
   * `{ type: "appended", ...activity }` after a successful write.
   */
  append(activity: Activity): Promise<void>;
}

/**
 * Persistence operations on {@link Comment} rows. Scoped to a parent
 * Requirement. Unlike ActivityStore, comments are NOT append-only.
 * Implementations enforce: (1) `create` rejects parent_ids that don't exist
 * or are themselves replies (depth > 1); (2) `update` only mutates body +
 * updated_at; (3) `delete` cascades a top-level comment's direct replies.
 */
export interface CommentStore extends EventSource<CommentEvent> {
  /**
   * Return up to ~500 comments for `requirementId`, sorted by `created_at`
   * ascending (oldest-first; chat order).
   */
  listForRequirement(requirementId: string): Promise<Comment[]>;
  /**
   * Insert a fresh comment. Rejects (rejected Promise) when `parent_id` is
   * set but doesn't reference an existing top-level comment in the same
   * requirement, or when the parent itself is a reply. Broadcasts `posted`.
   */
  create(comment: Comment): Promise<void>;
  /**
   * Replace an existing comment's body + updated_at. Resolves `false` if `id`
   * doesn't exist. Broadcasts `edited`.
   */
  update(comment: Comment): Promise<boolean>;
  /**
   * Hard-delete `commentId`. A top-level comment also removes its direct
   * replies. Resolves `false` if the id wasn't found. Broadcasts one
   * `deleted` per row removed.
   */
  delete(requirementId: string, commentId: string): Promise<boolean>;
}

/**
 * Persistence operations on {@link Label} rows. Scoped to a Project.
 * Uniqueness is enforced per project, case-insensitively, on create/update.
 * Deletion does NOT cascade into `Requirement.label_ids`.
 */
export interface LabelStore extends EventSource<LabelEvent> {
  /** Every label scoped to `projectId`, sorted by `name` case-insensitively. */
  listForProject(projectId: string): Promise<Label[]>;
  /** Lookup by id. Resolves `undefined` when not found in any project. */
  get(id: string): Promise<Label | undefined>;
  /**
   * Insert a fresh label. Rejects when another label in the same project
   * already has the same name (case-insensitive). Broadcasts `created`.
   */
  create(label: Label): Promise<void>;
  /**
   * Replace name / colour / description / updated_at. Resolves `false` if
   * `id` doesn't exist. Broadcasts `updated`.
   */
  update(label: Label): Promise<boolean>;
  /**
   * Hard-delete `labelId`. Resolves `false` if the id wasn't found.
   * Broadcasts `deleted`.
   */
  delete(projectId: string, labelId: string): Promise<boolean>;
}

/**
 * Persistence operations on {@link DocProject} + {@link DocDraft} rows. One
 * trait covers both halves of the doc workspace because they share a fanout
 * — mutations on either type broadcast through the same source as DocEvents.
 */
export interface DocStore extends EventSource<DocEvent> {
  listProjects(workspace: string): Promise<DocProject[]>;
  getProject(id: string): Promise<DocProject | undefined>;
  upsertProject(project: DocProject): Promise<void>;
  /**
   * Hard-delete a project and every draft attached to it. Resolves `true` if
   * the project existed.
   */
  deleteProject(id: string): Promise<boolean>;
  listDrafts(projectId: string): Promise<DocDraft[]>;
  /**
   * Convenience for v0 UIs: the most-recent draft by `updated_at`. The Rust
   * default impl scans `listDrafts` and picks the head; backends may
   * override with a DB-side `ORDER BY updated_at DESC LIMIT 1`.
   */
  latestDraft(projectId: string): Promise<DocDraft | undefined>;
  upsertDraft(draft: DocDraft): Promise<void>;
}

/**
 * Default implementation of {@link DocStore.latestDraft}: scan `listDrafts`
 * and return the head. Backends that don't override may delegate to this.
 * (The Rust trait carries this as a default method body; in TS it lives as a
 * standalone helper since interfaces can't carry implementations.)
 */
export async function docStoreLatestDraft(
  store: Pick<DocStore, "listDrafts">,
  projectId: string,
): Promise<DocDraft | undefined> {
  const rows = await store.listDrafts(projectId);
  return rows[0];
}

/**
 * Persistence operations on {@link ProjectMemory} rows. Project-scoped. No
 * broadcast channel — memories don't drive UI in real time; clients re-list.
 */
export interface ProjectMemoryStore {
  /** Return memories for `projectId`, newest-first by `updated_at`. */
  list(projectId: string): Promise<ProjectMemory[]>;
  /** Look up by id. Resolves `undefined` if absent. */
  get(id: string): Promise<ProjectMemory | undefined>;
  /**
   * Insert or overwrite. The store does NOT mutate `updated_at`; callers (or
   * {@link touchProjectMemory}) own that.
   */
  upsert(memory: ProjectMemory): Promise<void>;
  /** Hard-delete by id. Resolves `true` if a row was removed. */
  delete(id: string): Promise<boolean>;
}
