// `learning.memory.*` tools — row-based long-term Memory CRUD. Ported from
// crates/harness-tools/src/learning_memory.rs.
//
// Phase 1 of docs/proposals/self-improving-agent.zh-CN.md. Distinct from the
// `memory.*` tools (workspace / user MEMORY.md files); this family operates on
// the row-based MemoryItem in @jarvis/learning's MemoryStore.
//
// Both surfaces can coexist:
//   - memory.list/read/write/delete — markdown notes the agent maintains as
//     part of its current-workspace context.
//   - learning.memory.list/add/update/delete — pinnable, scoped facts ("the
//     user prefers terse answers") that survive across workspaces and feed
//     into the next turn's prompt-context block.
//
// Phase 1 ships ONLY the user scope through the tool surface. The type allows
// Project / Workspace so the existing ProjectMemory surface can move onto the
// same trait later without a wire migration.
//
// Result of every tool is a STRING — JSON.stringify of the structured result,
// matching the Tool interface (Rust returns serde_json::to_string_pretty; the
// Node port uses the 2-space pretty form to mirror the Rust output shape).
//
// `learning.memory.delete` is the only approval-gated tool here — the spec
// calls it out explicitly ("memory.delete | write | 需权限策略").
import type { JsonValue, Tool, ToolCategory, ToolRegistry } from "@jarvis/core";
import type {
  MemoryFilter,
  MemoryItem,
  MemoryKind,
  MemoryPatch,
  MemoryStore,
} from "@jarvis/learning";
import { newMemoryItem, withMemorySource } from "@jarvis/learning";

// ---------- arg helpers ----------------------------------------------------

const MEMORY_KINDS: readonly MemoryKind[] = [
  "preference",
  "fact",
  "lesson",
  "gotcha",
  "convention",
];

function asObject(args: JsonValue): { [k: string]: JsonValue } {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as { [k: string]: JsonValue };
  }
  return {};
}

function asString(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: JsonValue | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asNumber(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Collect a `tags` arg into a string[] (drops non-string entries, mirrors
 * the Rust `filter_map(|v| v.as_str())`). Returns undefined when absent. */
function asTags(v: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string");
}

/**
 * Parse a wire `kind` string into {@link MemoryKind}, throwing on unknown
 * values (mirrors the Rust `serde_json::from_value` error path).
 */
function parseKind(raw: string): MemoryKind {
  if ((MEMORY_KINDS as readonly string[]).includes(raw)) {
    return raw as MemoryKind;
  }
  throw new Error(`invalid kind: unknown variant \`${raw}\``);
}

/** Clamp a number into [lo, hi] (mirrors Rust `f32::clamp`). */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

// ---------- learning.memory.list -------------------------------------------

export class LearningMemoryListTool implements Tool {
  readonly name = "learning.memory.list";
  readonly category: ToolCategory = "read";
  readonly description =
    "List the user's long-term memory rows (preferences, facts, conventions). " +
    "Phase 1 surface — only user-scope rows are returned. Filter by `kind` " +
    "(preference/fact/lesson/gotcha/convention), `tags` (all-match), or `pinned`. " +
    "Default limit 50; cap 200.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["preference", "fact", "lesson", "gotcha", "convention"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "All listed tags must be present on the row.",
      },
      pinned: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
  };

  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    // Phase 1 surface: always user scope.
    const filter: MemoryFilter = { scope: { kind: "user" } };
    const kindRaw = asString(obj["kind"]);
    if (kindRaw !== undefined) {
      filter.kind = parseKind(kindRaw);
    }
    const tags = asTags(obj["tags"]);
    if (tags !== undefined) {
      filter.tags = tags;
    }
    const pinned = asBool(obj["pinned"]);
    if (pinned !== undefined) {
      filter.pinned = pinned;
    }
    const limitRaw = asNumber(obj["limit"]);
    // Clamp to the schema bounds (minimum:1, maximum:200) at runtime — a
    // negative `limit` would otherwise reach `slice(0, -N)` and silently drop
    // the last N rows instead of erroring. See issue #276.
    const limit = Math.max(1, Math.min(limitRaw !== undefined ? Math.trunc(limitRaw) : 50, 200));
    filter.limit = limit;
    const rows = await this.#store.list(filter);
    return JSON.stringify({ items: rows }, null, 2);
  }
}

// ---------- learning.memory.add --------------------------------------------

export class LearningMemoryAddTool implements Tool {
  readonly name = "learning.memory.add";
  readonly category: ToolCategory = "write";
  readonly description =
    'Persist a new long-term user memory row (e.g. "user prefers zh-CN replies"). ' +
    "Title is required and ≤200 chars; body is required and ≤2 KiB. Use " +
    "`kind` to categorise (preference / fact / lesson / gotcha / convention). " +
    "Set `pinned: true` to prevent the future Curator from auto-archiving it.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      kind: {
        type: "string",
        enum: ["preference", "fact", "lesson", "gotcha", "convention"],
        default: "preference",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      pinned: { type: "boolean", default: false },
      confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
    },
    required: ["title", "body"],
  };

  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const title = asString(obj["title"]);
    if (title === undefined) {
      throw new Error("missing `title`");
    }
    if (title.trim() === "") {
      throw new Error("`title` must be non-empty");
    }
    const body = asString(obj["body"]);
    if (body === undefined) {
      throw new Error("missing `body`");
    }
    if (body.trim() === "") {
      throw new Error("`body` must be non-empty");
    }
    const kindRaw = asString(obj["kind"]);
    const kind: MemoryKind = kindRaw !== undefined ? parseKind(kindRaw) : "preference";

    // Tool calls are always agent-originated. Reviewer fork will set
    // { kind: "run", run_id } later.
    const item = withMemorySource(
      newMemoryItem({ kind: "user" }, kind, title, body),
      { kind: "agent" },
    );
    const tags = asTags(obj["tags"]);
    if (tags !== undefined) {
      item.tags = tags;
    }
    if (asBool(obj["pinned"]) === true) {
      item.pinned = true;
    }
    const confidence = asNumber(obj["confidence"]);
    if (confidence !== undefined) {
      item.confidence = clamp(confidence, 0.0, 1.0);
    }
    const saved = await this.#store.upsert(item);
    return JSON.stringify({ item: saved }, null, 2);
  }
}

// ---------- learning.memory.update -----------------------------------------

export class LearningMemoryUpdateTool implements Tool {
  readonly name = "learning.memory.update";
  readonly category: ToolCategory = "write";
  readonly description =
    "Patch fields on an existing user memory row by id. Unspecified fields " +
    "are left as-is. Use this to refine a long-term memory rather than " +
    "appending a near-duplicate.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      kind: {
        type: "string",
        enum: ["preference", "fact", "lesson", "gotcha", "convention"],
      },
      tags: { type: "array", items: { type: "string" } },
      pinned: { type: "boolean" },
      confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
    },
    required: ["id"],
  };

  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("missing `id`");
    }
    // Reject an explicit empty `title` / `body` up front so the caller gets a
    // precise message; the store's atomic `patch` also re-validates (covering
    // the patched-result case) but its error is generic. Mirrors the non-empty
    // guards on `add`.
    const titleArg = asString(obj["title"]);
    if (titleArg !== undefined && titleArg.trim() === "") {
      throw new Error("`title` must be non-empty");
    }
    const bodyArg = asString(obj["body"]);
    if (bodyArg !== undefined && bodyArg.trim() === "") {
      throw new Error("`body` must be non-empty");
    }

    const patch: MemoryPatch = {};
    if (titleArg !== undefined) patch.title = titleArg;
    if (bodyArg !== undefined) patch.body = bodyArg;
    const kindRaw = obj["kind"];
    if (kindRaw !== undefined && kindRaw !== null) {
      const kindStr = asString(kindRaw);
      if (kindStr === undefined) {
        throw new Error(`invalid kind: expected a string`);
      }
      patch.kind = parseKind(kindStr);
    }
    const tags = asTags(obj["tags"]);
    if (tags !== undefined) patch.tags = tags;
    const pinned = asBool(obj["pinned"]);
    if (pinned !== undefined) patch.pinned = pinned;
    const confidence = asNumber(obj["confidence"]);
    if (confidence !== undefined) patch.confidence = confidence;

    // Atomic read-modify-write in the store: this serialises against
    // concurrent updates (no lost patch) and against `delete` — a row removed
    // mid-flight yields `undefined` rather than being resurrected.
    const saved = await this.#store.patch(id, patch);
    if (saved === undefined) {
      throw new Error(`no memory with id \`${id}\``);
    }
    return JSON.stringify({ item: saved }, null, 2);
  }
}

// ---------- learning.memory.delete -----------------------------------------

/**
 * Approval-gated because the spec calls this out explicitly: "memory.delete |
 * write | 需权限策略".
 */
export class LearningMemoryDeleteTool implements Tool {
  readonly name = "learning.memory.delete";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Delete a long-term user memory row by id. Returns `{deleted: bool}` — " +
    "deletion is idempotent (`false` when no such id). Approval-gated.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("missing `id`");
    }
    const deleted = await this.#store.delete(id);
    return JSON.stringify({ deleted }, null, 2);
  }
}

// ---------- registration helper --------------------------------------------

/**
 * Stores needed to construct the `learning.memory.*` tool family. Mirrors the
 * conditional-tool pattern: a single `memory` MemoryStore drives all four
 * tools.
 */
export interface LearningMemoryToolStores {
  memory: MemoryStore;
}

/**
 * Construct and register the `learning.memory.*` tools into `registry`. The
 * `delete` tool is approval-gated; the other three are not.
 */
export function registerLearningMemoryTools(
  registry: ToolRegistry,
  stores: LearningMemoryToolStores,
): void {
  const { memory } = stores;
  registry.register(new LearningMemoryListTool(memory));
  registry.register(new LearningMemoryAddTool(memory));
  registry.register(new LearningMemoryUpdateTool(memory));
  registry.register(new LearningMemoryDeleteTool(memory));
}
