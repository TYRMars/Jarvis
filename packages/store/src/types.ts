// ConversationStore surface + value types. Ported from
// harness-core/src/store.rs (the conversation subset). Kept in @jarvis/store
// rather than @jarvis/core so core stays a pure agent-loop leaf.
import type { Conversation } from "@jarvis/core";

/**
 * User-driven lifecycle state for a Conversation. Wire strings are stable so
 * the on-disk / REST form doesn't shift. `active` is the default; legacy rows
 * without the field rehydrate as `active`.
 */
export type ConversationLifecycle = "active" | "archived" | "abandoned";

/** Per-conversation metadata stored alongside (not inside) the Conversation. */
export interface ConversationMetadata {
  /** Project this conversation is bound to, if any. */
  project_id?: string | null;
  /** Lifecycle state. Defaults to `active`. */
  lifecycle: ConversationLifecycle;
}

export function defaultMetadata(): ConversationMetadata {
  return { lifecycle: "active" };
}

/** Summary record returned by `ConversationStore.list`. */
export interface ConversationRecord {
  id: string;
  /** RFC-3339 timestamps (lexicographically comparable). */
  created_at: string;
  updated_at: string;
  message_count: number;
  project_id?: string | null;
  lifecycle: ConversationLifecycle;
}

/**
 * Persistence operations on conversations, keyed by an opaque caller-chosen
 * id. The envelope methods carry `ConversationMetadata`; `save`/`load` are
 * thin wrappers using empty metadata. Implementations must be safe to share
 * across async tasks.
 */
export interface ConversationStore {
  saveEnvelope(id: string, conversation: Conversation, metadata: ConversationMetadata): Promise<void>;
  loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined>;
  /** List up to `limit` conversations, newest first. */
  list(limit: number): Promise<ConversationRecord[]>;
  /** As `list` but filtered to one project. */
  listByProject(projectId: string, limit: number): Promise<ConversationRecord[]>;
  /** Delete `id`; `false` if it didn't exist. */
  delete(id: string): Promise<boolean>;
  /** `saveEnvelope` with default metadata. */
  save(id: string, conversation: Conversation): Promise<void>;
  /** `loadEnvelope` dropping the metadata. */
  load(id: string): Promise<Conversation | undefined>;
}

/** Supplies the wrapper methods so backends implement only the core four. */
export abstract class ConversationStoreBase implements ConversationStore {
  abstract saveEnvelope(
    id: string,
    conversation: Conversation,
    metadata: ConversationMetadata,
  ): Promise<void>;
  abstract loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined>;
  abstract list(limit: number): Promise<ConversationRecord[]>;
  abstract delete(id: string): Promise<boolean>;

  save(id: string, conversation: Conversation): Promise<void> {
    return this.saveEnvelope(id, conversation, defaultMetadata());
  }

  async load(id: string): Promise<Conversation | undefined> {
    const r = await this.loadEnvelope(id);
    return r?.[0];
  }

  async listByProject(projectId: string, limit: number): Promise<ConversationRecord[]> {
    const scanLimit = Math.max(limit, limit * 4);
    const rows = await this.list(scanLimit);
    return rows.filter((r) => (r.project_id ?? null) === projectId).slice(0, limit);
  }
}

/** Backend chosen by `connect` couldn't be matched / configured. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}
