// WorkspaceStore backends. Ported from crates/harness-store/src/workspace.rs
// (the concrete file-backed `WorkspaceStore` struct + `WorkspaceEntry`).
//
// The persisted workspaces registry is the chat-header "Recent folders"
// dropdown plus a convo↔workspace map. Two collections share one logical
// store:
//
//   - `recent: WorkspaceEntry[]`         — paths the user has opened, newest
//                                          first (drives the dropdown).
//   - `by_conversation: Map<id, path>`   — which workspace each persisted
//                                          conversation began in, restored on
//                                          Resume so a session re-attaches to
//                                          its folder.
//
// Rust ships ONLY a file-backed struct (no trait). The Node port factors the
// public surface into a `WorkspaceStore` interface and provides three backends
// — JSON-file, in-memory, and SQLite — for parity with the other store
// families. Unlike the per-row stores, the JSON-file backend keeps the WHOLE
// registry in one `workspaces.json` (rewritten atomically on every mutation),
// matching the Rust layout.
//
// Note on `touch`: the Rust struct canonicalises the path against the real
// filesystem and rejects non-directories. That filesystem coupling is a
// composition-root concern (the binary canonicalises before calling), so the
// store keeps `touch(path, name?)` pure — a plain upsert+bump by path string —
// which lets the memory + SQLite backends work without touching disk.
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Database as Db } from "better-sqlite3";

import { atomicWrite, ensureDir } from "./json-file.ts";
import { readJsonFile } from "./fs-util.ts";
import { openSqlite } from "./sqlite.ts";

/**
 * One entry in the recent-workspaces list. `name` is the folder basename so
 * the dropdown can show "Jarvis" instead of the full path; `last_used_at` is an
 * RFC-3339 timestamp and the list is sorted newest-first.
 */
export interface WorkspaceEntry {
  path: string;
  name: string;
  /** RFC-3339 timestamp; newest entries sort first. */
  last_used_at: string;
}

/**
 * Persisted workspaces registry. Public surface mirrors the Rust struct:
 * `listRecent` (newest-first), `touch` (upsert + bump to front), `forget`
 * (drop a recent path), `get` (look one up), plus the convo↔workspace binding
 * map (`bind` / `unbind` / `lookup`).
 *
 * All methods are `Promise`-returning to match the other store families even
 * though the in-memory backend resolves synchronously.
 */
export interface WorkspaceStore {
  /** Snapshot of the recent list, newest-first. */
  listRecent(): Promise<WorkspaceEntry[]>;
  /**
   * Move `path` to the front of the recent list (inserting if new) and bump
   * its `last_used_at`. `name` defaults to the path basename. Returns the
   * stored path string.
   */
  touch(path: string, name?: string): Promise<string>;
  /** Drop `path` from the recent list. Idempotent. */
  forget(path: string): Promise<void>;
  /** Look up a single recent entry by exact path, if present. */
  get(path: string): Promise<WorkspaceEntry | undefined>;
  /** Bind a persisted conversation to a workspace path. */
  bind(conversationId: string, path: string): Promise<void>;
  /** Forget a conversation's binding. No-op if absent. */
  unbind(conversationId: string): Promise<void>;
  /** Look up a conversation's bound workspace path, if any. */
  lookup(conversationId: string): Promise<string | undefined>;
}

/**
 * Default cap on how many recent paths we keep (mirrors Rust's `MAX_RECENT`).
 * Anything pruned past this drops from the dropdown but stays usable via free
 * input — recent is convenience, not authority.
 */
export const MAX_RECENT = 24;

const nowIso = (): string => new Date().toISOString();

/** Derive the dropdown label from a path (its basename), falling back to the path. */
function basename(p: string): string {
  const b = path.basename(p);
  return b === "" ? p : b;
}

/**
 * Apply a `touch` to a recent list in place: drop any existing entry for the
 * same path, unshift a fresh one, and cap the length. Shared by every backend
 * so the ordering/dedupe/cap semantics are identical.
 */
function applyTouch(recent: WorkspaceEntry[], p: string, name: string | undefined): WorkspaceEntry[] {
  const filtered = recent.filter((e) => e.path !== p);
  filtered.unshift({ path: p, name: name ?? basename(p), last_used_at: nowIso() });
  return filtered.slice(0, MAX_RECENT);
}

// ---------- shared on-disk shape ----------

interface WorkspacesFile {
  recent: WorkspaceEntry[];
  /** Plain object so it serialises as the same JSON map Rust's BTreeMap emits. */
  by_conversation: Record<string, string>;
}

function emptyFile(): WorkspacesFile {
  return { recent: [], by_conversation: {} };
}

// ---------- JSON-file backend ----------

/**
 * File-backed registry. The whole `WorkspacesFile` lives in one
 * `<base>/workspaces.json`, rewritten atomically (tmp + rename) on every
 * mutation — the same single-file pattern as the Rust struct.
 */
export class JsonFileWorkspaceStore implements WorkspaceStore {
  readonly #path: string;
  #state: WorkspacesFile;

  private constructor(filePath: string, state: WorkspacesFile) {
    this.#path = filePath;
    this.#state = state;
  }

  /**
   * Open or create the registry at `<base>/workspaces/workspaces.json`. A
   * missing or unparseable file yields an empty registry (the Rust `open`
   * semantics).
   *
   * The registry lives in its own `workspaces/` subdir — like every other
   * domain store (`projects/`, `workflows/`, …) — so it never lands among the
   * conversation store's flat `<id>.json` rows in `<base>`, where
   * `JsonFileConversationStore.list` would parse it as a conversation and 500
   * for the lifetime of the data dir (#469). A registry written by an older
   * build to the flat `<base>/workspaces.json` is migrated in on first open.
   */
  static async open(base: string): Promise<JsonFileWorkspaceStore> {
    const dir = path.join(base, "workspaces");
    await ensureDir(dir);
    const filePath = path.join(dir, "workspaces.json");
    let loaded = await readJsonFile<Partial<WorkspacesFile>>(filePath);
    const legacyPath = path.join(base, "workspaces.json");
    let migrated = false;
    if (!loaded) {
      const legacy = await readJsonFile<Partial<WorkspacesFile>>(legacyPath);
      if (legacy) {
        loaded = legacy;
        migrated = true;
      }
    }
    const state: WorkspacesFile = {
      recent: loaded?.recent ?? [],
      by_conversation: loaded?.by_conversation ?? {},
    };
    const store = new JsonFileWorkspaceStore(filePath, state);
    if (migrated) {
      // Persist to the new subdir path FIRST, then drop the colliding flat
      // file — so a crash mid-migration never loses the registry (#469).
      await store.#flush();
      await rm(legacyPath).catch(() => {});
    }
    return store;
  }

  async #flush(): Promise<void> {
    await atomicWrite(this.#path, JSON.stringify(this.#state, null, 2));
  }

  listRecent(): Promise<WorkspaceEntry[]> {
    return Promise.resolve(this.#state.recent.map((e) => ({ ...e })));
  }

  async touch(p: string, name?: string): Promise<string> {
    this.#state.recent = applyTouch(this.#state.recent, p, name);
    await this.#flush();
    return p;
  }

  async forget(p: string): Promise<void> {
    this.#state.recent = this.#state.recent.filter((e) => e.path !== p);
    await this.#flush();
  }

  get(p: string): Promise<WorkspaceEntry | undefined> {
    const e = this.#state.recent.find((x) => x.path === p);
    return Promise.resolve(e ? { ...e } : undefined);
  }

  async bind(conversationId: string, p: string): Promise<void> {
    this.#state.by_conversation[conversationId] = p;
    await this.#flush();
  }

  async unbind(conversationId: string): Promise<void> {
    delete this.#state.by_conversation[conversationId];
    await this.#flush();
  }

  lookup(conversationId: string): Promise<string | undefined> {
    return Promise.resolve(this.#state.by_conversation[conversationId]);
  }
}

// ---------- in-memory backend ----------

/**
 * In-process registry. Backs tests + the server's no-DB fallback. Same
 * ordering / dedupe / cap + binding-map semantics as the JSON-file backend.
 */
export class MemoryWorkspaceStore implements WorkspaceStore {
  #recent: WorkspaceEntry[] = [];
  readonly #byConversation = new Map<string, string>();

  listRecent(): Promise<WorkspaceEntry[]> {
    return Promise.resolve(this.#recent.map((e) => ({ ...e })));
  }

  touch(p: string, name?: string): Promise<string> {
    this.#recent = applyTouch(this.#recent, p, name);
    return Promise.resolve(p);
  }

  forget(p: string): Promise<void> {
    this.#recent = this.#recent.filter((e) => e.path !== p);
    return Promise.resolve();
  }

  get(p: string): Promise<WorkspaceEntry | undefined> {
    const e = this.#recent.find((x) => x.path === p);
    return Promise.resolve(e ? { ...e } : undefined);
  }

  bind(conversationId: string, p: string): Promise<void> {
    this.#byConversation.set(conversationId, p);
    return Promise.resolve();
  }

  unbind(conversationId: string): Promise<void> {
    this.#byConversation.delete(conversationId);
    return Promise.resolve();
  }

  lookup(conversationId: string): Promise<string | undefined> {
    return Promise.resolve(this.#byConversation.get(conversationId));
  }
}

// ---------- SQLite backend ----------

interface RecentRow {
  path: string;
  name: string;
  last_used_at: string;
}

/**
 * SQLite-backed registry. Two tables — `workspace_recent` (one row per recent
 * path, ordered by `last_used_at DESC`) and `workspace_bindings`
 * (conversation_id → path). `migrate()` (in sqlite.ts) is idempotent. The
 * `MAX_RECENT` cap is enforced on `touch` by deleting the overflow tail.
 */
export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Open a `sqlite:` URL into a standalone workspace store. */
  static open(url: string): SqliteWorkspaceStore {
    return new SqliteWorkspaceStore(openSqlite(url));
  }

  listRecent(): Promise<WorkspaceEntry[]> {
    const rows = this.#db
      .prepare<[number], RecentRow>(
        "SELECT path, name, last_used_at FROM workspace_recent ORDER BY last_used_at DESC, rowid DESC LIMIT ?",
      )
      .all(MAX_RECENT);
    return Promise.resolve(rows.map((r) => ({ path: r.path, name: r.name, last_used_at: r.last_used_at })));
  }

  touch(p: string, name?: string): Promise<string> {
    const label = name ?? basename(p);
    this.#db
      .prepare(
        `INSERT INTO workspace_recent (path, name, last_used_at)
         VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at`,
      )
      .run(p, label, nowIso());
    // Enforce the cap: keep the newest MAX_RECENT rows, drop the tail.
    this.#db
      .prepare(
        `DELETE FROM workspace_recent
         WHERE path NOT IN (
           SELECT path FROM workspace_recent ORDER BY last_used_at DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(MAX_RECENT);
    return Promise.resolve(p);
  }

  forget(p: string): Promise<void> {
    this.#db.prepare("DELETE FROM workspace_recent WHERE path = ?").run(p);
    return Promise.resolve();
  }

  get(p: string): Promise<WorkspaceEntry | undefined> {
    const row = this.#db
      .prepare<[string], RecentRow>("SELECT path, name, last_used_at FROM workspace_recent WHERE path = ?")
      .get(p);
    return Promise.resolve(
      row ? { path: row.path, name: row.name, last_used_at: row.last_used_at } : undefined,
    );
  }

  bind(conversationId: string, p: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO workspace_bindings (conversation_id, path)
         VALUES (?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET path = excluded.path`,
      )
      .run(conversationId, p);
    return Promise.resolve();
  }

  unbind(conversationId: string): Promise<void> {
    this.#db.prepare("DELETE FROM workspace_bindings WHERE conversation_id = ?").run(conversationId);
    return Promise.resolve();
  }

  lookup(conversationId: string): Promise<string | undefined> {
    const row = this.#db
      .prepare<[string], { path: string }>("SELECT path FROM workspace_bindings WHERE conversation_id = ?")
      .get(conversationId);
    return Promise.resolve(row?.path);
  }
}
