// On-disk JSON-file ConversationStore. Ported from
// harness-store/src/json_file.rs (the conversation subset).
//
// One `<id>.json` per conversation in a directory. Writes go to `.tmp`
// first and rename onto the target (crash-safe; last-write-wins). Ids that
// aren't `[A-Za-z0-9._-]` are percent-encoded for the filename so the
// `__memory__.summary:<hash>` summary-cache namespace (containing `:`) is
// Windows-safe. Timestamps live in the file body (RFC-3339), not from mtime.
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Conversation, Message } from "@jarvis/core";
import {
  ConversationStoreBase,
  StoreError,
  type ConversationMetadata,
  type ConversationRecord,
} from "./types.ts";

interface OnDiskConversation {
  id: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  project_id?: string;
  lifecycle?: "archived" | "abandoned"; // omitted when default ("active")
}

export class JsonFileConversationStore extends ConversationStoreBase {
  readonly #dir: string;

  private constructor(dir: string) {
    super();
    this.#dir = dir;
  }

  /** Open or create a store at `dir` (created recursively if missing). */
  static async open(dir: string): Promise<JsonFileConversationStore> {
    await ensureDir(dir);
    return new JsonFileConversationStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async saveEnvelope(id: string, conversation: Conversation, metadata: ConversationMetadata): Promise<void> {
    const filePath = this.#pathFor(id);
    const now = new Date().toISOString();

    // Preserve created_at across overwrites.
    let createdAt = now;
    const existing = await readJsonFile<OnDiskConversation>(filePath);
    if (existing?.created_at) createdAt = existing.created_at;

    const stored: OnDiskConversation = {
      id,
      created_at: createdAt,
      updated_at: now,
      messages: conversation.messages,
    };
    if (metadata.project_id != null) stored.project_id = metadata.project_id;
    if (metadata.lifecycle !== "active") stored.lifecycle = metadata.lifecycle;

    await atomicWrite(filePath, JSON.stringify(stored, null, 2));
  }

  async loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined> {
    const stored = await readJsonFile<OnDiskConversation>(this.#pathFor(id));
    if (!stored) return undefined;
    const conv: Conversation = { messages: stored.messages };
    const meta: ConversationMetadata = {
      project_id: stored.project_id ?? null,
      lifecycle: stored.lifecycle ?? "active",
    };
    return [conv, meta];
  }

  async list(limit: number): Promise<ConversationRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }

    const records: ConversationRecord[] = [];
    for (const name of names) {
      // skip .tmp files, sibling subdirs (projects/ etc.), non-.json.
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      const stored = await readJsonFile<OnDiskConversation>(path.join(this.#dir, name));
      // Skip directory entries, unparseable files, and any non-conversation
      // JSON that may share this dir (e.g. a legacy flat workspaces.json, #469):
      // a real conversation record always carries a `messages` array.
      if (!stored || !Array.isArray(stored.messages)) continue;
      records.push({
        id: stored.id,
        created_at: stored.created_at,
        updated_at: stored.updated_at,
        message_count: stored.messages.length,
        project_id: stored.project_id ?? null,
        lifecycle: stored.lifecycle ?? "active",
      });
    }
    // Newest first by updated_at (RFC-3339 strings sort lexicographically).
    records.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return records.slice(0, limit);
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
}

// ---------- helpers ----------

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

/** Read + parse a JSON file; undefined if missing, parse error, or a directory. */
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

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Write to `<path>.tmp` then rename, so a crash mid-write leaves the old file intact. */
export async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, filePath);
}

/**
 * Percent-encode any byte not in `[A-Za-z0-9._-]`. UUIDs pass through; `:`
 * (from the `__memory__.summary:` namespace) becomes `%3A`. Mirrors Rust's
 * `encode_id` byte-for-byte (uppercase 2-digit hex).
 */
export function encodeId(id: string): string {
  const bytes = new TextEncoder().encode(id);
  let out = "";
  for (const b of bytes) {
    const safe =
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2e || // .
      b === 0x2d || // -
      b === 0x5f; // _
    out += safe ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
