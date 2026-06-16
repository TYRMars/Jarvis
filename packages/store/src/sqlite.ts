// SQLite-backed store backends. Ported from harness-store/src/sqlite.rs.
//
// Uses the synchronous `better-sqlite3` driver. Because the trait methods are
// all `Promise`-returning (the async shape from @jarvis/core / @jarvis/project
// / @jarvis/workflow), each method does its synchronous DB work and wraps the
// result in `Promise.resolve` — the `*Sync` driver gives us crash-consistent
// single-statement writes without an await point.
//
// Schema strategy (per the P6 brief, simpler than the normalised Rust schema):
// one table per store family, each row = key column(s) + a JSON `blob` of the
// value + RFC-3339 `created_at`/`updated_at` columns. `migrate()` is idempotent
// (`CREATE TABLE IF NOT EXISTS`). Reads parse the blob; writes upsert it. This
// keeps the value types opaque to the DB while preserving every behaviour the
// JSON-file backend has (list ordering/scoping, soft-delete, event fan-out on
// mutation).
//
// The whole bundle shares ONE `Database` handle (essential for `sqlite::memory:`,
// where each connection is a separate database). `connectAll` opens the handle
// once and hands the same instance to every store.
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";

import type { Conversation } from "@jarvis/core";
import type {
  Activity,
  ActivityEvent,
  ActivityStore,
  Comment,
  CommentEvent,
  CommentStore,
  DocDraft,
  DocEvent,
  DocProject,
  DocStore,
  EventListener,
  Label,
  LabelEvent,
  LabelStore,
  Project,
  ProjectMemory,
  ProjectMemoryStore,
  ProjectStore,
  Requirement,
  RequirementEvent,
  RequirementRun,
  RequirementRunEvent,
  RequirementRunStore,
  RequirementStore,
  TriageState,
  Unsubscribe,
} from "@jarvis/project";
import {
  archiveProject,
  DEFAULT_TRIAGE_STATE,
  docStoreLatestDraft,
  requirementDeletedEvent,
  requirementRunStatusIsTerminal,
  requirementUpsertedEvent,
} from "@jarvis/project";
import type { WorkflowDefinition, WorkflowRun, WorkflowStore } from "@jarvis/workflow";

import {
  ConversationStoreBase,
  type ConversationMetadata,
  type ConversationRecord,
} from "./types.ts";
import { Fanout } from "./event-source.ts";

// ---------- shared DB open + migrate ----------

/**
 * Open (creating the file if missing) a `better-sqlite3` handle for a
 * `sqlite:` URL and run the full idempotent migration. Accepted forms:
 *
 *   sqlite::memory:        → a private, process-lifetime in-memory database
 *   sqlite:<path>          → a file at <path> (relative or absolute)
 *   sqlite://<path>        → ditto (the `//` is stripped)
 *
 * The returned handle is shared by every store in the bundle.
 */
export function openSqlite(url: string): Db {
  const db = new Database(resolveSqlitePath(url));
  // WAL + a busy timeout keep the single shared handle resilient under the
  // synchronous, single-process access pattern the stores assume.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/** Map a `sqlite:` URL to the path/`:memory:` token `better-sqlite3` wants. */
export function resolveSqlitePath(url: string): string {
  if (url === "sqlite::memory:" || url === "sqlite://:memory:") return ":memory:";
  if (url.startsWith("sqlite://")) return url.slice("sqlite://".length);
  if (url.startsWith("sqlite:")) return url.slice("sqlite:".length);
  return url;
}

/** Create every table if absent. Idempotent — safe to call on each open. */
function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      blob          TEXT NOT NULL,
      project_id    TEXT,
      lifecycle     TEXT NOT NULL DEFAULT 'active',
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);

    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL,
      blob       TEXT NOT NULL,
      archived   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

    CREATE TABLE IF NOT EXISTS requirements (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id);

    CREATE TABLE IF NOT EXISTS requirement_runs (
      id             TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      blob           TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_requirement ON requirement_runs(requirement_id);

    CREATE TABLE IF NOT EXISTS activities (
      id             TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      blob           TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_requirement ON activities(requirement_id);

    CREATE TABLE IF NOT EXISTS comments (
      id             TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL,
      parent_id      TEXT,
      blob           TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_requirement ON comments(requirement_id);

    CREATE TABLE IF NOT EXISTS labels (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name       TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_labels_project ON labels(project_id);

    CREATE TABLE IF NOT EXISTS doc_projects (
      id         TEXT PRIMARY KEY,
      workspace  TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_projects_workspace ON doc_projects(workspace);

    CREATE TABLE IF NOT EXISTS doc_drafts (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_drafts_project ON doc_drafts(project_id);

    CREATE TABLE IF NOT EXISTS project_memories (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_memories_project ON project_memories(project_id);

    CREATE TABLE IF NOT EXISTS workflows (
      id         TEXT PRIMARY KEY,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id             TEXT PRIMARY KEY,
      workflow_id    TEXT,
      requirement_id TEXT,
      blob           TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_requirement ON workflow_runs(requirement_id);

    CREATE TABLE IF NOT EXISTS workspace_recent (
      path         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_recent_used ON workspace_recent(last_used_at);

    CREATE TABLE IF NOT EXISTS workspace_bindings (
      conversation_id TEXT PRIMARY KEY,
      path            TEXT NOT NULL
    );
  `);
}

const nowIso = (): string => new Date().toISOString();

// ---------- ConversationStore ----------

interface ConvRow {
  blob: string;
  project_id: string | null;
  lifecycle: string;
  created_at: string;
  updated_at: string;
}

export class SqliteConversationStore extends ConversationStoreBase {
  readonly #db: Db;

  constructor(db: Db) {
    super();
    this.#db = db;
  }

  /** Open a `sqlite:` URL into a standalone conversation store. */
  static open(url: string): SqliteConversationStore {
    return new SqliteConversationStore(openSqlite(url));
  }

  saveEnvelope(id: string, conversation: Conversation, metadata: ConversationMetadata): Promise<void> {
    const now = nowIso();
    const existing = this.#db
      .prepare<[string], { created_at: string }>("SELECT created_at FROM conversations WHERE id = ?")
      .get(id);
    const createdAt = existing?.created_at ?? now;
    this.#db
      .prepare(
        `INSERT INTO conversations (id, blob, project_id, lifecycle, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           blob = excluded.blob,
           project_id = excluded.project_id,
           lifecycle = excluded.lifecycle,
           message_count = excluded.message_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        JSON.stringify(conversation.messages),
        metadata.project_id ?? null,
        metadata.lifecycle,
        conversation.messages.length,
        createdAt,
        now,
      );
    return Promise.resolve();
  }

  loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined> {
    const row = this.#db
      .prepare<[string], ConvRow>(
        "SELECT blob, project_id, lifecycle, created_at, updated_at FROM conversations WHERE id = ?",
      )
      .get(id);
    if (!row) return Promise.resolve(undefined);
    const conv: Conversation = { messages: JSON.parse(row.blob) as Conversation["messages"] };
    const meta: ConversationMetadata = {
      project_id: row.project_id ?? null,
      lifecycle: (row.lifecycle as ConversationMetadata["lifecycle"]) ?? "active",
    };
    return Promise.resolve([conv, meta]);
  }

  list(limit: number): Promise<ConversationRecord[]> {
    const rows = this.#db
      .prepare<[number], ConvRow & { id: string; message_count: number }>(
        `SELECT id, project_id, lifecycle, message_count, created_at, updated_at
         FROM conversations ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(clampLimit(limit));
    return Promise.resolve(
      rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        updated_at: r.updated_at,
        message_count: r.message_count,
        project_id: r.project_id ?? null,
        lifecycle: (r.lifecycle as ConversationRecord["lifecycle"]) ?? "active",
      })),
    );
  }

  delete(id: string): Promise<boolean> {
    const info = this.#db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return Promise.resolve(info.changes > 0);
  }
}

// ---------- ProjectStore (no event fanout) ----------

export class SqliteProjectStore implements ProjectStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteProjectStore {
    return new SqliteProjectStore(openSqlite(url));
  }

  save(project: Project): Promise<void> {
    // Slug-uniqueness: reject a save whose slug is owned by a *different* id.
    const clash = this.#db
      .prepare<[string, string], { id: string }>("SELECT id FROM projects WHERE slug = ? AND id != ?")
      .get(project.slug, project.id);
    if (clash) {
      return Promise.reject(
        new Error(`project slug '${project.slug}' already in use by id=${clash.id}`),
      );
    }
    this.#db
      .prepare(
        `INSERT INTO projects (id, slug, blob, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           blob = excluded.blob,
           archived = excluded.archived,
           updated_at = excluded.updated_at`,
      )
      .run(
        project.id,
        project.slug,
        JSON.stringify(project),
        project.archived ? 1 : 0,
        project.created_at,
        project.updated_at,
      );
    return Promise.resolve();
  }

  load(id: string): Promise<Project | undefined> {
    const row = this.#db.prepare<[string], { blob: string }>("SELECT blob FROM projects WHERE id = ?").get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as Project) : undefined);
  }

  findBySlug(slug: string): Promise<Project | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM projects WHERE slug = ?")
      .get(slug);
    return Promise.resolve(row ? (JSON.parse(row.blob) as Project) : undefined);
  }

  list(includeArchived: boolean, limit: number): Promise<Project[]> {
    const sql = includeArchived
      ? "SELECT blob FROM projects ORDER BY updated_at DESC LIMIT ?"
      : "SELECT blob FROM projects WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?";
    const rows = this.#db.prepare<[number], { blob: string }>(sql).all(clampLimit(limit));
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as Project));
  }

  delete(id: string): Promise<boolean> {
    const info = this.#db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return Promise.resolve(info.changes > 0);
  }

  async archive(id: string): Promise<boolean> {
    const project = await this.load(id);
    if (!project) return false;
    archiveProject(project);
    await this.save(project);
    return true;
  }
}

// ---------- RequirementStore (EventSource) ----------

function effectiveTriage(req: Requirement): TriageState {
  return req.triage_state ?? DEFAULT_TRIAGE_STATE;
}

const REQUIREMENT_LIST_CAP = 500;

export class SqliteRequirementStore implements RequirementStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<RequirementEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteRequirementStore {
    return new SqliteRequirementStore(openSqlite(url));
  }

  subscribe(listener: EventListener<RequirementEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  list(projectId: string): Promise<Requirement[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM requirements WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(projectId, REQUIREMENT_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as Requirement));
  }

  async listByTriageState(projectId: string, triageState: TriageState): Promise<Requirement[]> {
    const rows = await this.list(projectId);
    return rows.filter((r) => effectiveTriage(r) === triageState);
  }

  get(id: string): Promise<Requirement | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM requirements WHERE id = ?")
      .get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as Requirement) : undefined);
  }

  upsert(item: Requirement): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO requirements (id, project_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           blob = excluded.blob,
           updated_at = excluded.updated_at`,
      )
      .run(item.id, item.project_id, JSON.stringify(item), item.created_at, item.updated_at);
    this.#fanout.emit(requirementUpsertedEvent(item));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const existing = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM requirements WHERE id = ?")
      .get(id);
    if (!existing) return Promise.resolve(false);
    const req = JSON.parse(existing.blob) as Requirement;
    const info = this.#db.prepare("DELETE FROM requirements WHERE id = ?").run(id);
    if (info.changes > 0) {
      this.#fanout.emit(requirementDeletedEvent(req.project_id, req.id));
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}

// ---------- RequirementRunStore (EventSource + broadcast) ----------

const RUN_LIST_CAP = 200;

/** Derive the broadcast event for a prior→next run transition (mirrors Rust). */
export function classifyRunEvent(
  prior: RequirementRun | undefined,
  next: RequirementRun,
): RequirementRunEvent | undefined {
  const wasTerminal = prior !== undefined && requirementRunStatusIsTerminal(prior.status);
  const nowTerminal = requirementRunStatusIsTerminal(next.status);
  if (!wasTerminal && nowTerminal) return { type: "finished", ...next };
  if (prior === undefined && !nowTerminal) return { type: "started", ...next };
  return undefined;
}

export class SqliteRequirementRunStore implements RequirementRunStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<RequirementRunEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteRequirementRunStore {
    return new SqliteRequirementRunStore(openSqlite(url));
  }

  subscribe(listener: EventListener<RequirementRunEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  listForRequirement(requirementId: string): Promise<RequirementRun[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM requirement_runs WHERE requirement_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(requirementId, RUN_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as RequirementRun));
  }

  get(id: string): Promise<RequirementRun | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM requirement_runs WHERE id = ?")
      .get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as RequirementRun) : undefined);
  }

  listAll(limit: number): Promise<RequirementRun[]> {
    const rows = this.#db
      .prepare<[number], { blob: string }>(
        "SELECT blob FROM requirement_runs ORDER BY started_at DESC LIMIT ?",
      )
      .all(clampLimit(limit));
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as RequirementRun));
  }

  upsert(run: RequirementRun): Promise<void> {
    const priorRow = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM requirement_runs WHERE id = ?")
      .get(run.id);
    const prior = priorRow ? (JSON.parse(priorRow.blob) as RequirementRun) : undefined;
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO requirement_runs (id, requirement_id, blob, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           requirement_id = excluded.requirement_id,
           blob = excluded.blob,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at`,
      )
      .run(run.id, run.requirement_id, JSON.stringify(run), run.started_at, now, now);
    const event = classifyRunEvent(prior, run);
    if (event !== undefined) this.#fanout.emit(event);
    return Promise.resolve();
  }

  broadcast(event: RequirementRunEvent): void {
    this.#fanout.emit(event);
  }
}

// ---------- ActivityStore (append-only, EventSource) ----------

const ACTIVITY_LIST_CAP = 500;

export class SqliteActivityStore implements ActivityStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<ActivityEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteActivityStore {
    return new SqliteActivityStore(openSqlite(url));
  }

  subscribe(listener: EventListener<ActivityEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  listForRequirement(requirementId: string): Promise<Activity[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM activities WHERE requirement_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(requirementId, ACTIVITY_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as Activity));
  }

  append(activity: Activity): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO activities (id, requirement_id, blob, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           requirement_id = excluded.requirement_id,
           blob = excluded.blob,
           created_at = excluded.created_at`,
      )
      .run(activity.id, activity.requirement_id, JSON.stringify(activity), activity.created_at);
    this.#fanout.emit({ type: "appended", ...activity });
    return Promise.resolve();
  }
}

// ---------- CommentStore (EventSource, depth-1 threading) ----------

const COMMENT_LIST_CAP = 500;

function parentError(bucket: readonly Comment[], parentId: string): string | undefined {
  const parent = bucket.find((c) => c.id === parentId);
  if (!parent) return `parent comment \`${parentId}\` not found in requirement`;
  if (parent.parent_id != null) {
    return "comment threading is limited to depth 1 (cannot reply to a reply)";
  }
  return undefined;
}

export class SqliteCommentStore implements CommentStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<CommentEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteCommentStore {
    return new SqliteCommentStore(openSqlite(url));
  }

  subscribe(listener: EventListener<CommentEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #bucket(requirementId: string): Comment[] {
    const rows = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM comments WHERE requirement_id = ?")
      .all(requirementId);
    return rows.map((r) => JSON.parse(r.blob) as Comment);
  }

  listForRequirement(requirementId: string): Promise<Comment[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM comments WHERE requirement_id = ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(requirementId, COMMENT_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as Comment));
  }

  create(comment: Comment): Promise<void> {
    if (comment.parent_id != null) {
      const err = parentError(this.#bucket(comment.requirement_id), comment.parent_id);
      if (err) return Promise.reject(new Error(err));
    }
    const dup = this.#db
      .prepare<[string], { id: string }>("SELECT id FROM comments WHERE id = ?")
      .get(comment.id);
    if (dup) return Promise.reject(new Error(`comment id \`${comment.id}\` already exists`));
    this.#db
      .prepare(
        `INSERT INTO comments (id, requirement_id, parent_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.id,
        comment.requirement_id,
        comment.parent_id ?? null,
        JSON.stringify(comment),
        comment.created_at,
        comment.updated_at,
      );
    this.#fanout.emit({ type: "posted", ...comment });
    return Promise.resolve();
  }

  update(comment: Comment): Promise<boolean> {
    // Scope the lookup to (id, requirement_id) so a patch carrying the wrong
    // requirement_id resolves to `false` (mirrors Rust + the JSON/memory
    // backends, which key the on-disk path / bucket by requirement_id).
    const row = this.#db
      .prepare<[string, string], { blob: string }>(
        "SELECT blob FROM comments WHERE id = ? AND requirement_id = ?",
      )
      .get(comment.id, comment.requirement_id);
    if (!row) return Promise.resolve(false);
    const existing = JSON.parse(row.blob) as Comment;
    // Only body + updated_at are caller-mutable; pin the rest.
    const merged: Comment = { ...existing, body: comment.body, updated_at: comment.updated_at };
    this.#db
      .prepare("UPDATE comments SET blob = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), merged.updated_at, merged.id);
    this.#fanout.emit({ type: "edited", ...merged });
    return Promise.resolve(true);
  }

  delete(requirementId: string, commentId: string): Promise<boolean> {
    const bucket = this.#bucket(requirementId);
    const target = bucket.find((c) => c.id === commentId);
    if (!target) return Promise.resolve(false);
    const toRemove = [target.id];
    if (target.parent_id == null) {
      for (const c of bucket) if (c.parent_id === commentId) toRemove.push(c.id);
    }
    const del = this.#db.prepare("DELETE FROM comments WHERE id = ?");
    for (const id of toRemove) {
      del.run(id);
      this.#fanout.emit({ type: "deleted", requirement_id: requirementId, comment_id: id });
    }
    return Promise.resolve(true);
  }
}

// ---------- LabelStore (EventSource, per-project name uniqueness) ----------

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class SqliteLabelStore implements LabelStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<LabelEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteLabelStore {
    return new SqliteLabelStore(openSqlite(url));
  }

  subscribe(listener: EventListener<LabelEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  #bucket(projectId: string): Label[] {
    const rows = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM labels WHERE project_id = ?")
      .all(projectId);
    return rows.map((r) => JSON.parse(r.blob) as Label);
  }

  listForProject(projectId: string): Promise<Label[]> {
    const rows = this.#bucket(projectId);
    rows.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return Promise.resolve(rows);
  }

  get(id: string): Promise<Label | undefined> {
    const row = this.#db.prepare<[string], { blob: string }>("SELECT blob FROM labels WHERE id = ?").get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as Label) : undefined);
  }

  create(label: Label): Promise<void> {
    const bucket = this.#bucket(label.project_id);
    if (bucket.some((l) => sameName(l.name, label.name))) {
      return Promise.reject(new Error(`label name \`${label.name}\` already exists in project`));
    }
    if (bucket.some((l) => l.id === label.id)) {
      return Promise.reject(new Error(`label id \`${label.id}\` already exists`));
    }
    this.#db
      .prepare(
        `INSERT INTO labels (id, project_id, name, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(label.id, label.project_id, label.name, JSON.stringify(label), label.created_at, label.updated_at);
    this.#fanout.emit({ type: "created", ...label });
    return Promise.resolve();
  }

  update(label: Label): Promise<boolean> {
    // Scope the lookup to (id, project_id) so a patch carrying the wrong
    // project_id resolves to `false` (mirrors Rust + the JSON/memory backends,
    // which key the on-disk path / bucket by project_id).
    const row = this.#db
      .prepare<[string, string], { blob: string }>(
        "SELECT blob FROM labels WHERE id = ? AND project_id = ?",
      )
      .get(label.id, label.project_id);
    if (!row) return Promise.resolve(false);
    const existing = JSON.parse(row.blob) as Label;
    const bucket = this.#bucket(label.project_id);
    if (bucket.some((l) => l.id !== label.id && sameName(l.name, label.name))) {
      return Promise.reject(new Error(`label name \`${label.name}\` already exists in project`));
    }
    // id / project_id / created_at pinned; name / colour / description / updated_at from the patch.
    const merged: Label = {
      id: existing.id,
      project_id: existing.project_id,
      created_at: existing.created_at,
      name: label.name,
      colour: label.colour,
      updated_at: label.updated_at,
    };
    if (label.description != null) merged.description = label.description;
    this.#db
      .prepare("UPDATE labels SET name = ?, blob = ?, updated_at = ? WHERE id = ?")
      .run(merged.name, JSON.stringify(merged), merged.updated_at, merged.id);
    this.#fanout.emit({ type: "updated", ...merged });
    return Promise.resolve(true);
  }

  delete(projectId: string, labelId: string): Promise<boolean> {
    const info = this.#db
      .prepare("DELETE FROM labels WHERE id = ? AND project_id = ?")
      .run(labelId, projectId);
    if (info.changes === 0) return Promise.resolve(false);
    this.#fanout.emit({ type: "deleted", project_id: projectId, label_id: labelId });
    return Promise.resolve(true);
  }
}

// ---------- DocStore (projects + drafts, shared EventSource) ----------

const DOC_PROJECT_LIST_CAP = 500;

export class SqliteDocStore implements DocStore {
  readonly #db: Db;
  readonly #fanout = new Fanout<DocEvent>();

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteDocStore {
    return new SqliteDocStore(openSqlite(url));
  }

  subscribe(listener: EventListener<DocEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }

  listProjects(workspace: string): Promise<DocProject[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM doc_projects WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(workspace, DOC_PROJECT_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as DocProject));
  }

  getProject(id: string): Promise<DocProject | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM doc_projects WHERE id = ?")
      .get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as DocProject) : undefined);
  }

  upsertProject(project: DocProject): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO doc_projects (id, workspace, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace = excluded.workspace,
           blob = excluded.blob,
           updated_at = excluded.updated_at`,
      )
      .run(project.id, project.workspace, JSON.stringify(project), project.created_at, project.updated_at);
    this.#fanout.emit({ type: "project_upserted", ...project });
    return Promise.resolve();
  }

  deleteProject(id: string): Promise<boolean> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM doc_projects WHERE id = ?")
      .get(id);
    if (!row) return Promise.resolve(false);
    const project = JSON.parse(row.blob) as DocProject;
    this.#db.prepare("DELETE FROM doc_projects WHERE id = ?").run(id);
    // Cascade-delete this project's drafts.
    this.#db.prepare("DELETE FROM doc_drafts WHERE project_id = ?").run(id);
    this.#fanout.emit({ type: "project_deleted", workspace: project.workspace, id: project.id });
    return Promise.resolve(true);
  }

  listDrafts(projectId: string): Promise<DocDraft[]> {
    const rows = this.#db
      .prepare<[string], { blob: string }>(
        "SELECT blob FROM doc_drafts WHERE project_id = ? ORDER BY updated_at DESC",
      )
      .all(projectId);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as DocDraft));
  }

  latestDraft(projectId: string): Promise<DocDraft | undefined> {
    return docStoreLatestDraft(this, projectId);
  }

  upsertDraft(draft: DocDraft): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO doc_drafts (id, project_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           blob = excluded.blob,
           updated_at = excluded.updated_at`,
      )
      .run(draft.id, draft.project_id, JSON.stringify(draft), draft.created_at, draft.updated_at);
    this.#fanout.emit({ type: "draft_upserted", ...draft });
    return Promise.resolve();
  }
}

// ---------- ProjectMemoryStore (no event fanout) ----------

const MEMORY_LIST_CAP = 200;

export class SqliteProjectMemoryStore implements ProjectMemoryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteProjectMemoryStore {
    return new SqliteProjectMemoryStore(openSqlite(url));
  }

  list(projectId: string): Promise<ProjectMemory[]> {
    const rows = this.#db
      .prepare<[string, number], { blob: string }>(
        "SELECT blob FROM project_memories WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(projectId, MEMORY_LIST_CAP);
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as ProjectMemory));
  }

  get(id: string): Promise<ProjectMemory | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM project_memories WHERE id = ?")
      .get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as ProjectMemory) : undefined);
  }

  upsert(memory: ProjectMemory): Promise<void> {
    // Does NOT mutate updated_at — callers own that (matches the JSON backend).
    this.#db
      .prepare(
        `INSERT INTO project_memories (id, project_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           blob = excluded.blob,
           updated_at = excluded.updated_at`,
      )
      .run(memory.id, memory.project_id, JSON.stringify(memory), memory.created_at, memory.updated_at);
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const info = this.#db.prepare("DELETE FROM project_memories WHERE id = ?").run(id);
    return Promise.resolve(info.changes > 0);
  }
}

// ---------- WorkflowStore (definitions + runs, no fanout) ----------

export class SqliteWorkflowStore implements WorkflowStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  static open(url: string): SqliteWorkflowStore {
    return new SqliteWorkflowStore(openSqlite(url));
  }

  // ----- definitions -----

  list(): Promise<WorkflowDefinition[]> {
    const rows = this.#db
      .prepare<[], { blob: string }>("SELECT blob FROM workflows ORDER BY updated_at DESC")
      .all();
    return Promise.resolve(rows.map((r) => JSON.parse(r.blob) as WorkflowDefinition));
  }

  get(id: string): Promise<WorkflowDefinition | undefined> {
    const row = this.#db.prepare<[string], { blob: string }>("SELECT blob FROM workflows WHERE id = ?").get(id);
    return Promise.resolve(row ? (JSON.parse(row.blob) as WorkflowDefinition) : undefined);
  }

  upsert(def: WorkflowDefinition): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO workflows (id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
      )
      .run(def.id, JSON.stringify(def), def.created_at, def.updated_at);
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const info = this.#db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    return Promise.resolve(info.changes > 0);
  }

  // ----- runs -----

  listRuns(
    workflowId: string | undefined,
    requirementId: string | undefined,
  ): Promise<WorkflowRun[]> {
    const rows = this.#db
      .prepare<[], { blob: string }>("SELECT blob FROM workflow_runs ORDER BY started_at DESC")
      .all();
    const out = rows
      .map((r) => JSON.parse(r.blob) as WorkflowRun)
      .filter(
        (r) =>
          (workflowId === undefined || r.workflow_id === workflowId) &&
          (requirementId === undefined || r.requirement_id === requirementId),
      );
    return Promise.resolve(out);
  }

  getRun(runId: string): Promise<WorkflowRun | undefined> {
    const row = this.#db
      .prepare<[string], { blob: string }>("SELECT blob FROM workflow_runs WHERE id = ?")
      .get(runId);
    return Promise.resolve(row ? (JSON.parse(row.blob) as WorkflowRun) : undefined);
  }

  upsertRun(run: WorkflowRun): Promise<void> {
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, requirement_id, blob, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workflow_id = excluded.workflow_id,
           requirement_id = excluded.requirement_id,
           blob = excluded.blob,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        run.id,
        run.workflow_id ?? null,
        run.requirement_id ?? null,
        JSON.stringify(run),
        run.started_at,
        now,
        now,
      );
    return Promise.resolve();
  }
}

// ---------- helpers ----------

/**
 * SQLite's `LIMIT` treats a negative value as "no limit", which is the right
 * behaviour for `listByProject`'s `limit * 4` over-fetch but a foot-gun if a
 * caller passes a genuine negative. We clamp to `-1` (unlimited) only when the
 * caller explicitly asks for it via a non-positive over-fetch; here we simply
 * pass through, since every trait caller passes a sane positive cap.
 */
function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.trunc(limit) : -1;
}
