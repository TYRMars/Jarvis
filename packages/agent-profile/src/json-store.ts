// JSON-file AgentProfileStore. Ported from
// harness-store/src/json_file.rs (`JsonFileAgentProfileStore`).
//
// One `<encodeId(id)>.json` per profile under `<base>/agent_profiles/`. The
// set is small (dozens) so a flat directory is fine. Writes go through
// `atomicWrite` (tmp + rename; crash-safe, last-write-wins); ids that aren't
// `[A-Za-z0-9._-]` are percent-encoded for the filename via `encodeId`. A
// missing directory yields an empty `list` (ENOENT → empty). `list` sorts by
// `name` ascending and soft-caps at 200. Mutations fan out an
// AgentProfileEvent after the durable write succeeds.
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, encodeId, ensureDir } from "@jarvis/store";
import type { AgentProfile, AgentProfileEvent } from "./agent-profile.ts";
import {
  byName,
  Fanout,
  LIST_SOFT_CAP,
  type AgentProfileStore,
  type EventListener,
  type Unsubscribe,
} from "./store.ts";

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

export class JsonFileAgentProfileStore implements AgentProfileStore {
  readonly #dir: string;
  readonly #fanout = new Fanout<AgentProfileEvent>();

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /** Open or create a store at `<baseDir>/agent_profiles/` (created recursively). */
  static async open(baseDir: string): Promise<JsonFileAgentProfileStore> {
    const dir = path.join(baseDir, "agent_profiles");
    await ensureDir(dir);
    return new JsonFileAgentProfileStore(dir);
  }

  #pathFor(id: string): string {
    return path.join(this.#dir, `${encodeId(id)}.json`);
  }

  async list(): Promise<AgentProfile[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    const rows: AgentProfile[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".json.tmp")) continue;
      let bytes: string;
      try {
        bytes = await readFile(path.join(this.#dir, name), "utf8");
      } catch {
        continue; // unreadable / vanished mid-scan → skip
      }
      try {
        rows.push(JSON.parse(bytes) as AgentProfile);
      } catch {
        // unparseable → skip (mirrors Rust's `if let Ok(p) = ...`)
      }
    }
    rows.sort(byName);
    return rows.slice(0, LIST_SOFT_CAP);
  }

  async get(id: string): Promise<AgentProfile | undefined> {
    let bytes: string;
    try {
      bytes = await readFile(this.#pathFor(id), "utf8");
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
    return JSON.parse(bytes) as AgentProfile;
  }

  async upsert(profile: AgentProfile): Promise<void> {
    await ensureDir(this.#dir);
    await atomicWrite(this.#pathFor(profile.id), JSON.stringify(profile, null, 2));
    this.#fanout.emit({ type: "upserted", ...profile });
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.#pathFor(id));
    } catch (e) {
      if (isNotFound(e)) return false; // already absent → no-op, no broadcast
      throw e;
    }
    this.#fanout.emit({ type: "deleted", id });
    return true;
  }

  subscribe(listener: EventListener<AgentProfileEvent>): Unsubscribe {
    return this.#fanout.subscribe(listener);
  }
}
