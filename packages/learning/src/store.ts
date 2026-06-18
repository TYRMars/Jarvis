// Persistence traits for the self-improving-agent surfaces.
//
// Ported from the `#[async_trait]` traits in crates/harness-learning/src/lib.rs:
//   - `SkillUsageStore`   — append-only telemetry (record + list + report).
//   - `SkillLifecycleStore` — Phase-2 lifecycle rows keyed by skill_name.
//   - `MemoryStore`       — long-term memory rows (list/get/upsert/patch/delete).
//
// Async trait methods → `Promise`-returning interface methods. Rust's
// `MemoryStore` trait carries no broadcast channel itself, but the server fans
// `MemoryEvent`s out to the WS; in the Node port we model that the same way the
// @jarvis/project store family does — `MemoryStore extends EventSource` and
// backends emit on every successful mutation. `SkillUsageStore` /
// `SkillLifecycleStore` are NOT event sources (Rust carries no fanout for
// them).
//
// Concrete implementations live in the sibling `*-store.ts` files.
import type { EventSource } from "./event-source.ts";
import type { MemoryEvent, MemoryFilter, MemoryItem, MemoryPatch } from "./memory.ts";
import type { SkillLifecycle } from "./skill-lifecycle.ts";
import type {
  SkillUsageEvent,
  SkillUsageFilter,
  SkillUsageRow,
} from "./skill-usage.ts";

/**
 * Persistence surface for skill usage telemetry. Append-only by design —
 * Phase 0 only records and reads.
 */
export interface SkillUsageStore {
  /**
   * Append a single usage event. Implementations MUST allocate `id` and stamp
   * `created_at` if the caller left them empty, returning the stamped event.
   */
  recordEvent(event: SkillUsageEvent): Promise<SkillUsageEvent>;
  /**
   * Return raw events matching `filter`, newest-first. An unset `limit` means
   * "all rows" (callers should set one for the REST surface).
   */
  listEvents(filter: SkillUsageFilter): Promise<SkillUsageEvent[]>;
  /**
   * Aggregated per-skill usage report. Folds over {@link listEvents} via
   * {@link foldEventsIntoRows}; SQL backends could override with a grouped
   * query.
   */
  report(filter: SkillUsageFilter): Promise<SkillUsageRow[]>;
}

/**
 * Persistence surface for {@link SkillLifecycle} rows, keyed by `skill_name`.
 * `upsert` stamps `created_at` (if empty) + `updated_at` (always); `delete` is
 * idempotent (resolves `false` for a missing name).
 */
export interface SkillLifecycleStore {
  list(): Promise<SkillLifecycle[]>;
  get(skillName: string): Promise<SkillLifecycle | undefined>;
  upsert(row: SkillLifecycle): Promise<SkillLifecycle>;
  delete(skillName: string): Promise<boolean>;
}

/**
 * Persistence surface for long-term {@link MemoryItem} rows.
 *
 * `upsert` is the single write path: it allocates `id` + stamps `created_at` /
 * `updated_at` when needed (and always refreshes `updated_at`), validates the
 * row through {@link validateMemorySafe}, then persists. `delete` is
 * idempotent — resolves `false` for missing ids. `patch` is the atomic
 * read-modify-write primitive: a `delete` that lands first wins (`patch` then
 * resolves `undefined` without re-inserting the row).
 *
 * Mutations fan out a {@link MemoryEvent} after a successful durable write.
 */
export interface MemoryStore extends EventSource<MemoryEvent> {
  list(filter: MemoryFilter): Promise<MemoryItem[]>;
  get(id: string): Promise<MemoryItem | undefined>;
  /**
   * Persist `item`: allocate `id` if empty, set `created_at` if empty, always
   * refresh `updated_at`, validate, then write. Rejects (rejected Promise)
   * when the row fails {@link validateMemorySafe}. Resolves the stamped row.
   */
  upsert(item: MemoryItem): Promise<MemoryItem>;
  /**
   * Atomically apply `patch` to the row identified by `id`. Resolves:
   *   - the updated row when it existed and passed validation,
   *   - `undefined` when no row with `id` exists (never created, or
   *     concurrently deleted) — nothing is written,
   *   - rejects when the patched row fails {@link validateMemorySafe}.
   */
  patch(id: string, patch: MemoryPatch): Promise<MemoryItem | undefined>;
  delete(id: string): Promise<boolean>;
}
