// SubAgent runs ledger — a record of recent subagent invocations, populated
// observationally from the SubAgentEvent stream. Ported from
// harness-server/src/subagent_runs.rs (the in-process `SubAgentRunRegistry`).
//
// In Rust this is an in-memory RwLock ledger only. The Node port ships:
//   - the store TRAIT (`SubAgentRunStore`, async),
//   - a Memory backend (`MemorySubAgentRunStore`) — the faithful port of the
//     Rust registry (FIFO ring cap, cooperative cancel, per-run event list),
//   - a JsonFile backend (`JsonFileSubAgentRunStore`) — durable across
//     restarts, one `<id>.json` per run under `<baseDir>/subagent_runs/`.
//
// Status / record wire shapes match the Rust serde output exactly
// (snake_case, `skip_serializing_if = Option::is_none` -> optional fields
// absent when undefined).
//
// `record_frame` is the observational write the transports call at every
// `AgentEvent::SubAgentEvent` relay. It keys on `subagent_id`, maps lifecycle
// frames to status transitions, and (Memory backend) trims to a bounded ring.
//
// Cancellation deferral note: Rust signals a `tokio_util CancellationToken`.
// There is no portable abort primitive across the injectable subagent
// implementations here, so cancel is cooperative: it flips status to
// `cancelled` and exposes `isCancelled(id)` for an implementation to poll
// between iterations. Pure LLM-loop subagents that don't poll finish
// naturally — the cancel mark is the audit signal (same as Rust's note for
// token-less subagents).
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type { SubAgentEvent, SubAgentFrame } from "./subagent.ts";

// @jarvis/store keeps `isNotFound` / `readJsonFile` / `readJsonDir` private to
// its package (only atomicWrite / encodeId / ensureDir are re-exported). We
// re-implement the same three primitives here, byte-for-byte with json-file.ts
// / fs-util.ts, rather than reach into another package's internals.
function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

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

async function readJsonDir<T>(dir: string): Promise<T[]> {
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
    const row = await readJsonFile<T>(path.join(dir, name));
    if (row !== undefined) out.push(row);
  }
  return out;
}

/** Cap on the number of run records kept (Memory backend FIFO ring). */
export const MAX_RUNS = 200;
/** Cap on detail-endpoint events kept per run. */
export const MAX_EVENTS_PER_RUN = 1_000;

/** One run's lifecycle status (serde snake_case). */
export type SubAgentRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Snapshot of one SubAgent run. `events` is populated only on the detail path
 * to keep list responses small (see {@link SubAgentRunStore.events}). Optional
 * fields are absent (undefined) when the producing frames didn't supply them,
 * matching Rust's `skip_serializing_if = "Option::is_none"`.
 */
export interface SubAgentRunRecord {
  id: string;
  name: string;
  task?: string;
  model?: string;
  conversation_id?: string;
  status: SubAgentRunStatus;
  /** Epoch milliseconds. */
  started_at: number;
  /** Epoch milliseconds. */
  updated_at: number;
  /** Wall-clock duration in ms (elapsed-since-start while running). */
  duration_ms: number;
  /** Count of `tool_start` events seen. */
  tool_call_count: number;
  error?: string;
  final_message?: string;
}

/** One recorded frame in a run's detail event list. */
export interface SubAgentEventRecord {
  /** Epoch milliseconds. */
  timestamp: number;
  frame: SubAgentFrame;
}

/**
 * Persistence operations on the SubAgent runs ledger. Async to match the
 * package convention; the Memory backend resolves synchronously.
 */
export interface SubAgentRunStore {
  /**
   * Observe one frame. Idempotent for non-terminal frames; the terminal
   * `done` / `error` frame freezes status. `conversationId` is the owning
   * conversation (transports pass it through), or undefined.
   */
  recordFrame(conversationId: string | undefined, frame: SubAgentFrame): Promise<void>;
  /**
   * Mark a run cancelled. Resolves `true` when the run existed and was still
   * `running`; `false` for "no such run" or "already terminal".
   */
  cancel(id: string): Promise<boolean>;
  /** Whether `id` has been cancelled (cooperative-cancel poll). */
  isCancelled(id: string): Promise<boolean>;
  /** Every known run, newest-first by `started_at`. */
  list(): Promise<SubAgentRunRecord[]>;
  /** One run by id, or undefined. Running rows recompute `duration_ms`. */
  get(id: string): Promise<SubAgentRunRecord | undefined>;
  /** The recorded detail events for `id`, or undefined when no such run. */
  events(id: string): Promise<SubAgentEventRecord[] | undefined>;
}

// ---------------------------------------------------------------------------
// Shared frame-folding logic (used by both backends)
// ---------------------------------------------------------------------------

function freshRecord(id: string, name: string, conversationId: string | undefined, now: number): SubAgentRunRecord {
  const rec: SubAgentRunRecord = {
    id,
    name,
    status: "running",
    started_at: now,
    updated_at: now,
    duration_ms: 0,
    tool_call_count: 0,
  };
  if (conversationId !== undefined) rec.conversation_id = conversationId;
  return rec;
}

/** Apply one event to a record in place. Returns nothing; mutates `rec`. */
function applyEvent(rec: SubAgentRunRecord, event: SubAgentEvent, now: number): void {
  rec.updated_at = now;
  if (event.kind === "started") {
    if (rec.task === undefined) rec.task = event.task;
    if (rec.model === undefined && event.model !== undefined) rec.model = event.model;
  } else if (event.kind === "tool_start") {
    rec.tool_call_count += 1;
  } else if (event.kind === "done") {
    // Don't overwrite a prior cancel mark — a manual cancel is the operator's
    // truth and typically arrives before the natural done.
    if (rec.status !== "cancelled") rec.status = "completed";
    rec.final_message = event.final_message;
    rec.duration_ms = Math.max(0, now - rec.started_at);
  } else if (event.kind === "error") {
    if (rec.status !== "cancelled") rec.status = "failed";
    rec.error = event.message;
    rec.duration_ms = Math.max(0, now - rec.started_at);
  }
}

/** Recompute a running row's `duration_ms` at read time. */
function withLiveDuration(rec: SubAgentRunRecord, now: number): SubAgentRunRecord {
  if (rec.status !== "running") return { ...rec };
  return { ...rec, duration_ms: Math.max(0, now - rec.started_at) };
}

// ---------------------------------------------------------------------------
// Memory backend — faithful port of the Rust in-process registry
// ---------------------------------------------------------------------------

interface RunInternals {
  record: SubAgentRunRecord;
  events: SubAgentEventRecord[];
}

export class MemorySubAgentRunStore implements SubAgentRunStore {
  readonly #runs = new Map<string, RunInternals>();
  /** Insertion order so we can evict FIFO past the cap. */
  readonly #order: string[] = [];

  recordFrame(conversationId: string | undefined, frame: SubAgentFrame): Promise<void> {
    const now = Date.now();
    const id = frame.subagent_id;
    let entry = this.#runs.get(id);
    const isNew = entry === undefined;
    if (entry === undefined) {
      entry = { record: freshRecord(id, frame.subagent_name, conversationId, now), events: [] };
      this.#runs.set(id, entry);
    }
    applyEvent(entry.record, frame.event, now);
    if (entry.events.length < MAX_EVENTS_PER_RUN) {
      entry.events.push({ timestamp: now, frame: structuredClone(frame) });
    }
    if (isNew) {
      this.#order.push(id);
      while (this.#order.length > MAX_RUNS) {
        const oldest = this.#order.shift();
        if (oldest !== undefined) this.#runs.delete(oldest);
      }
    }
    return Promise.resolve();
  }

  cancel(id: string): Promise<boolean> {
    const entry = this.#runs.get(id);
    if (entry === undefined || entry.record.status !== "running") return Promise.resolve(false);
    const now = Date.now();
    entry.record.status = "cancelled";
    entry.record.updated_at = now;
    entry.record.duration_ms = Math.max(0, now - entry.record.started_at);
    return Promise.resolve(true);
  }

  isCancelled(id: string): Promise<boolean> {
    return Promise.resolve(this.#runs.get(id)?.record.status === "cancelled");
  }

  list(): Promise<SubAgentRunRecord[]> {
    const now = Date.now();
    const out = [...this.#runs.values()].map((e) => withLiveDuration(e.record, now));
    out.sort((a, b) => b.started_at - a.started_at);
    return Promise.resolve(out);
  }

  get(id: string): Promise<SubAgentRunRecord | undefined> {
    const entry = this.#runs.get(id);
    return Promise.resolve(entry ? withLiveDuration(entry.record, Date.now()) : undefined);
  }

  events(id: string): Promise<SubAgentEventRecord[] | undefined> {
    const entry = this.#runs.get(id);
    return Promise.resolve(entry ? entry.events.map((e) => structuredClone(e)) : undefined);
  }
}

// ---------------------------------------------------------------------------
// JsonFile backend — durable across restarts
// ---------------------------------------------------------------------------

interface OnDiskRun {
  record: SubAgentRunRecord;
  events: SubAgentEventRecord[];
}

export class JsonFileSubAgentRunStore implements SubAgentRunStore {
  readonly #dir: string;

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Open or create a store at `<baseDir>/subagent_runs/`. */
  static async open(baseDir: string): Promise<JsonFileSubAgentRunStore> {
    const dir = path.join(baseDir, "subagent_runs");
    await ensureDir(dir);
    return new JsonFileSubAgentRunStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async #read(id: string): Promise<OnDiskRun | undefined> {
    return readJsonFile<OnDiskRun>(this.#pathFor(id));
  }

  async #write(run: OnDiskRun): Promise<void> {
    await atomicWrite(this.#pathFor(run.record.id), JSON.stringify(run, null, 2));
  }

  async recordFrame(conversationId: string | undefined, frame: SubAgentFrame): Promise<void> {
    const now = Date.now();
    const id = frame.subagent_id;
    let stored = await this.#read(id);
    if (stored === undefined) {
      stored = { record: freshRecord(id, frame.subagent_name, conversationId, now), events: [] };
      // FIFO ring eviction across the directory: drop the oldest rows past cap.
      await this.#evictPastCap();
    }
    applyEvent(stored.record, frame.event, now);
    if (stored.events.length < MAX_EVENTS_PER_RUN) {
      stored.events.push({ timestamp: now, frame });
    }
    await this.#write(stored);
  }

  /** Drop the oldest rows (by started_at) so the directory stays under MAX_RUNS. */
  async #evictPastCap(): Promise<void> {
    const rows = await readJsonDir<OnDiskRun>(this.#dir);
    if (rows.length < MAX_RUNS) return; // we are about to add one more -> == MAX_RUNS is fine
    rows.sort((a, b) => a.record.started_at - b.record.started_at); // oldest first
    const overflow = rows.length - (MAX_RUNS - 1);
    for (let i = 0; i < overflow; i++) {
      const victim = rows[i];
      if (victim) await this.#delete(victim.record.id);
    }
  }

  async #delete(id: string): Promise<void> {
    try {
      await rm(this.#pathFor(id));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async cancel(id: string): Promise<boolean> {
    const stored = await this.#read(id);
    if (stored === undefined || stored.record.status !== "running") return false;
    const now = Date.now();
    stored.record.status = "cancelled";
    stored.record.updated_at = now;
    stored.record.duration_ms = Math.max(0, now - stored.record.started_at);
    await this.#write(stored);
    return true;
  }

  async isCancelled(id: string): Promise<boolean> {
    const stored = await this.#read(id);
    return stored?.record.status === "cancelled";
  }

  async list(): Promise<SubAgentRunRecord[]> {
    const now = Date.now();
    const rows = await readJsonDir<OnDiskRun>(this.#dir);
    const out = rows.map((r) => withLiveDuration(r.record, now));
    out.sort((a, b) => b.started_at - a.started_at);
    return out;
  }

  async get(id: string): Promise<SubAgentRunRecord | undefined> {
    const stored = await this.#read(id);
    return stored ? withLiveDuration(stored.record, Date.now()) : undefined;
  }

  async events(id: string): Promise<SubAgentEventRecord[] | undefined> {
    const stored = await this.#read(id);
    return stored ? stored.events : undefined;
  }
}
