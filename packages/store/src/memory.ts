// In-memory ConversationStore. Mirrors Rust's MemoryConversationStore:
// always available for tests / a server's "no DB configured" fallback, but
// NOT selectable via connect() (no durable URL scheme maps to it).
import type { Conversation } from "@jarvis/core";
import {
  ConversationStoreBase,
  type ConversationMetadata,
  type ConversationRecord,
} from "./types.ts";

interface Row {
  created_at: string;
  updated_at: string;
  messages: Conversation["messages"];
  metadata: ConversationMetadata;
}

export class MemoryConversationStore extends ConversationStoreBase {
  #rows = new Map<string, Row>();

  saveEnvelope(id: string, conversation: Conversation, metadata: ConversationMetadata): Promise<void> {
    const now = new Date().toISOString();
    const createdAt = this.#rows.get(id)?.created_at ?? now;
    this.#rows.set(id, {
      created_at: createdAt,
      updated_at: now,
      messages: [...conversation.messages],
      metadata: { project_id: metadata.project_id ?? null, lifecycle: metadata.lifecycle },
    });
    return Promise.resolve();
  }

  loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined> {
    const row = this.#rows.get(id);
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve([{ messages: [...row.messages] }, { ...row.metadata }]);
  }

  list(limit: number): Promise<ConversationRecord[]> {
    const records: ConversationRecord[] = [];
    for (const [id, row] of this.#rows) {
      records.push({
        id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        message_count: row.messages.length,
        project_id: row.metadata.project_id ?? null,
        lifecycle: row.metadata.lifecycle,
      });
    }
    records.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return Promise.resolve(records.slice(0, limit));
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}
