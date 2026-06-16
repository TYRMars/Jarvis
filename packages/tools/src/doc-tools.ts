// Persistent Doc CRUD — `doc.{list,search,get,upsert,create,update,delete}`
// and `doc.draft.{get,save}` tools. Ported from
// crates/harness-tools/src/doc.rs.
//
// Surfaces the @jarvis/project DocStore API to the LLM. Mirrors the REST
// endpoints in the server's doc routes but with typed schemas and per-call
// workspace resolution. Drafts are append-only by design — `doc.draft.save`
// always inserts a new revision; the UI reads the most-recent one via
// `DocStore.latestDraft`.
//
// All write operations are `category = "write"` and `requiresApproval = true`
// per the policy decided in the Rust plan (every data change goes through the
// approver).
//
// Workspace resolution: each workspace-targeting tool takes a construction-
// time `defaultRoot` and accepts an optional per-call `workspace` override.
// The Rust module resolves this through the task-local
// `active_workspace_or` + `canonicalize_workspace`; the Node harness has no
// task-local workspace channel, so the override (or the default root) is
// canonicalized lexically via `path.resolve` — already-absolute paths pass
// through unchanged. A single agent process serving multiple sockets pinned
// to different roots never cross-contaminates because the override is always
// honoured first.
import path from "node:path";

import type { JsonValue, Tool, ToolCategory, ToolRegistry } from "@jarvis/core";
import type { DocDraft, DocKind, DocProject, DocStore } from "@jarvis/project";
import { docKindFromWire, newDocDraft, newDocProject, touchDocProject } from "@jarvis/project";

const MAX_DRAFT_BYTES = 50 * 1024;
const DEFAULT_DOC_SEARCH_LIMIT = 10;
const MAX_DOC_SEARCH_LIMIT = 50;
const DOC_SNIPPET_CHARS = 240;

// ---------- shared helpers -------------------------------------------------

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

function asStringArray(v: JsonValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new Error("expected an array of strings");
  }
  return v.map((item) => {
    if (typeof item !== "string") {
      throw new Error("expected an array of strings");
    }
    return item;
  });
}

/**
 * Resolve the target workspace. A non-empty per-call `workspace` override
 * wins; otherwise the construction-time default root is used. The result is
 * canonicalized lexically via `path.resolve` (already-absolute inputs are
 * returned unchanged) — mirrors the Rust `resolve_workspace`.
 */
function resolveWorkspace(defaultRoot: string, override: string | undefined): string {
  const raw = override !== undefined && override !== "" ? override : defaultRoot;
  return path.resolve(raw);
}

/** Parse a wire `kind` string, throwing on unknown values (matches Rust). */
function parseKind(s: string): DocKind {
  const kind = docKindFromWire(s);
  if (kind === undefined) {
    throw new Error(
      `unknown kind \`${s}\` — expected one of ` + "note / research / report / design / guide",
    );
  }
  return kind;
}

/**
 * Case-insensitive substring test. An empty query matches everything (mirrors
 * the Rust `contains_query`).
 */
function containsQuery(haystack: string, query: string): boolean {
  return query === "" || haystack.toLowerCase().includes(query);
}

/**
 * Build a `DOC_SNIPPET_CHARS`-wide snippet around the first match of `query`
 * (or the head of the content when `query` is empty). Surrounds with `...`
 * markers when it's a window into a longer body. Mirrors the Rust
 * `content_snippet` — character-based, not byte-based, so multibyte text
 * (CJK) is sliced cleanly.
 */
function contentSnippet(content: string, query: string): string {
  const trimmed = content.trim();
  if (trimmed === "") {
    return "";
  }
  const chars = [...trimmed];
  const lower = trimmed.toLowerCase();
  // Find the start character index of the match. `String.indexOf` returns a
  // UTF-16 code-unit offset; convert it to a character index so the slice
  // lines up with the `chars` array.
  let start = 0;
  if (query !== "") {
    const codeUnit = lower.indexOf(query);
    start = codeUnit <= 0 ? 0 : [...lower.slice(0, codeUnit)].length;
  }
  let snippet = chars.slice(start, start + DOC_SNIPPET_CHARS).join("");
  if (start > 0) {
    snippet = `...${snippet}`;
  }
  if (chars.length > start + DOC_SNIPPET_CHARS) {
    snippet = `${snippet}...`;
  }
  return snippet;
}

/** Trim, drop blanks, and de-duplicate tags preserving first-seen order. */
function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t !== "" && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Bump the parent project's `updated_at` after a draft save. */
async function touchProject(store: DocStore, projectId: string): Promise<void> {
  const project = await store.getProject(projectId);
  if (project !== undefined) {
    touchDocProject(project);
    await store.upsertProject(project);
  }
}

// ---------- doc.list -------------------------------------------------------

export class DocListTool implements Tool {
  readonly name = "doc.list";
  readonly category: ToolCategory = "read";
  readonly description =
    "List doc projects in the current workspace, newest-first. " +
    "Capped at 500 items. By default hides archived docs and " +
    "includes both pinned and unpinned. Pass `archived: true` to " +
    "see archived docs, or `pinned_only: true` to filter to pinned.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Absolute path. Optional; defaults to the agent's pinned workspace.",
      },
      archived: {
        type: "boolean",
        description: "Include archived docs. Defaults to false.",
      },
      pinned_only: {
        type: "boolean",
        description: "Restrict to pinned docs. Defaults to false.",
      },
    },
  };

  readonly #store: DocStore;
  readonly #defaultRoot: string;

  constructor(store: DocStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));
    const archived = asBool(obj["archived"]) ?? false;
    const pinnedOnly = asBool(obj["pinned_only"]) ?? false;
    let items = await this.#store.listProjects(workspace);
    if (!archived) {
      items = items.filter((p) => !p.archived);
    }
    if (pinnedOnly) {
      items = items.filter((p) => p.pinned);
    }
    return JSON.stringify({
      workspace,
      items,
      count: items.length,
    });
  }
}

// ---------- doc.search -----------------------------------------------------

export class DocSearchTool implements Tool {
  readonly name = "doc.search";
  readonly category: ToolCategory = "read";
  readonly description =
    "Search doc projects in the current workspace by title, tags, kind, " +
    "and latest draft body. Use this before editing/deleting when the " +
    "user names a document naturally instead of giving an id.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Free-text query. Blank returns recent docs.",
      },
      workspace: {
        type: "string",
        description: "Absolute path. Optional; defaults to the agent's pinned workspace.",
      },
      archived: {
        type: "boolean",
        description: "Include archived docs. Defaults to false.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DOC_SEARCH_LIMIT,
        description: "Max results. Defaults to 10.",
      },
    },
  };

  readonly #store: DocStore;
  readonly #defaultRoot: string;

  constructor(store: DocStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));
    const archived = asBool(obj["archived"]) ?? false;
    const queryRaw = asString(obj["query"]) ?? "";
    const query = queryRaw.trim().toLowerCase();
    const limitRaw = obj["limit"];
    let limit = DEFAULT_DOC_SEARCH_LIMIT;
    if (typeof limitRaw === "number" && Number.isFinite(limitRaw)) {
      limit = Math.trunc(limitRaw);
    }
    limit = Math.min(Math.max(limit, 1), MAX_DOC_SEARCH_LIMIT);

    const results: JsonValue[] = [];
    const projects = await this.#store.listProjects(workspace);
    for (const project of projects) {
      if (!archived && project.archived) {
        continue;
      }
      const latest = await this.#store.latestDraft(project.id);
      const matchedFields: string[] = [];
      if (containsQuery(project.title, query)) {
        matchedFields.push("title");
      }
      // `DocKind` wire form IS the enum string itself, so match against it
      // directly (the Rust calls `kind.as_wire()`).
      if (containsQuery(project.kind, query)) {
        matchedFields.push("kind");
      }
      if (project.tags.some((t) => containsQuery(t, query))) {
        matchedFields.push("tags");
      }
      if (latest !== undefined && containsQuery(latest.content, query)) {
        matchedFields.push("content");
      }
      if (matchedFields.length === 0) {
        continue;
      }
      results.push({
        project: project as unknown as JsonValue,
        matched_fields: matchedFields,
        latest_draft:
          latest !== undefined
            ? {
                id: latest.id,
                format: latest.format,
                created_at: latest.created_at,
                updated_at: latest.updated_at,
                snippet: contentSnippet(latest.content, query),
              }
            : null,
      });
      if (results.length >= limit) {
        break;
      }
    }
    return JSON.stringify({
      workspace,
      query: queryRaw,
      count: results.length,
      items: results,
    });
  }
}

// ---------- doc.get --------------------------------------------------------

export class DocGetTool implements Tool {
  readonly name = "doc.get";
  readonly category: ToolCategory = "read";
  readonly description =
    "Get a doc project by id. With `with_draft: true`, also " +
    "returns the most-recent draft (`null` if none). Use " +
    "`doc.draft.get` directly if you only need the body.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
      with_draft: {
        type: "boolean",
        description: "Include the latest draft. Defaults to false.",
      },
    },
    required: ["id"],
  };

  readonly #store: DocStore;

  constructor(store: DocStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("doc.get: bad args: missing `id`");
    }
    const project = await this.#store.getProject(id);
    if (project === undefined) {
      throw new Error(`doc not found: \`${id}\``);
    }
    const withDraft = asBool(obj["with_draft"]) ?? false;
    const out: { [k: string]: JsonValue } = { project: project as unknown as JsonValue };
    if (withDraft) {
      const draft = await this.#store.latestDraft(id);
      out["draft"] = draft !== undefined ? (draft as unknown as JsonValue) : null;
    }
    return JSON.stringify(out);
  }
}

// ---------- doc.upsert -----------------------------------------------------

export class DocUpsertTool implements Tool {
  readonly name = "doc.upsert";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Create or update one doc project and optionally append a latest " +
    "markdown draft in a single operation. If `id` is provided, updates " +
    "that project. Otherwise an exact title match in the workspace is " +
    "updated; no match creates a new doc. Ambiguous title matches error.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Existing doc id. Preferred when editing a known doc.",
      },
      title: {
        type: "string",
        description: "Title for create, rename, or exact-title lookup when id is absent.",
      },
      content: {
        type: "string",
        description: "Markdown body to save as a new latest draft. Up to ~50KB.",
      },
      kind: {
        type: "string",
        enum: ["note", "research", "report", "design", "guide"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      pinned: { type: "boolean" },
      archived: { type: "boolean" },
      workspace: {
        type: "string",
        description: "Absolute path. Optional; defaults to the agent's pinned workspace.",
      },
    },
  };

  readonly #store: DocStore;
  readonly #defaultRoot: string;

  constructor(store: DocStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const titleRaw = asString(obj["title"]);
    const title = titleRaw !== undefined ? titleRaw.trim() : undefined;
    const titleArg = title !== undefined && title !== "" ? title : undefined;
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));

    let created = false;
    let project: DocProject;
    const idRaw = asString(obj["id"]);
    const id = idRaw !== undefined && idRaw.trim() !== "" ? idRaw.trim() : undefined;
    if (id !== undefined) {
      const found = await this.#store.getProject(id);
      if (found === undefined) {
        throw new Error(`doc not found: \`${id}\``);
      }
      project = found;
    } else {
      if (titleArg === undefined) {
        throw new Error("doc.upsert: `title` is required when `id` is absent");
      }
      const titleLc = titleArg.toLowerCase();
      const all = await this.#store.listProjects(workspace);
      const matches = all.filter((p) => p.title.trim().toLowerCase() === titleLc);
      if (matches.length === 0) {
        created = true;
        project = newDocProject(workspace, titleArg);
      } else if (matches.length === 1) {
        project = matches[0] as DocProject;
      } else {
        const ids = matches.map((p) => `${p.title} (${p.id})`);
        throw new Error(
          `doc.upsert: title \`${titleArg}\` matched multiple docs; pass \`id\`. matches: ${ids.join(
            ", ",
          )}`,
        );
      }
    }

    if (titleArg !== undefined) {
      project.title = titleArg;
    }
    const kind = asString(obj["kind"]);
    if (kind !== undefined) {
      project.kind = parseKind(kind);
    }
    const tags = asStringArray(obj["tags"]);
    if (tags !== undefined) {
      project.tags = cleanTags(tags);
    }
    const pinned = asBool(obj["pinned"]);
    if (pinned !== undefined) {
      project.pinned = pinned;
    }
    const archived = asBool(obj["archived"]);
    if (archived !== undefined) {
      project.archived = archived;
    }
    touchDocProject(project);
    await this.#store.upsertProject(project);

    let draft: DocDraft | undefined;
    const content = asString(obj["content"]);
    if (content !== undefined) {
      const byteLen = Buffer.byteLength(content, "utf8");
      if (byteLen > MAX_DRAFT_BYTES) {
        throw new Error(
          `doc.upsert: content too large (${byteLen} bytes) — cap is ${MAX_DRAFT_BYTES} bytes`,
        );
      }
      draft = newDocDraft(project.id, content);
      await this.#store.upsertDraft(draft);
    }

    return JSON.stringify({
      created,
      project: project as unknown as JsonValue,
      draft: draft !== undefined ? (draft as unknown as JsonValue) : null,
    });
  }
}

// ---------- doc.create -----------------------------------------------------

export class DocCreateTool implements Tool {
  readonly name = "doc.create";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Create a new doc project (the metadata container). Use " +
    "`doc.draft.save` afterwards to write the actual body. " +
    "Returns the created project.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      title: { type: "string", description: "Display title." },
      kind: {
        type: "string",
        enum: ["note", "research", "report", "design", "guide"],
        description: "Document type. Defaults to `note`.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      pinned: { type: "boolean", description: "Defaults to false." },
      workspace: {
        type: "string",
        description: "Absolute path. Optional; defaults to the agent's pinned workspace.",
      },
    },
    required: ["title"],
  };

  readonly #store: DocStore;
  readonly #defaultRoot: string;

  constructor(store: DocStore, defaultRoot: string) {
    this.#store = store;
    this.#defaultRoot = defaultRoot;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const title = (asString(obj["title"]) ?? "").trim();
    if (title === "") {
      throw new Error("doc.create: `title` must not be blank");
    }
    const workspace = resolveWorkspace(this.#defaultRoot, asString(obj["workspace"]));
    const project = newDocProject(workspace, title);
    const kind = asString(obj["kind"]);
    if (kind !== undefined) {
      project.kind = parseKind(kind);
    }
    const tags = asStringArray(obj["tags"]);
    if (tags !== undefined) {
      project.tags = cleanTags(tags);
    }
    project.pinned = asBool(obj["pinned"]) ?? false;
    await this.#store.upsertProject(project);
    return JSON.stringify(project as unknown as JsonValue);
  }
}

// ---------- doc.update -----------------------------------------------------

export class DocUpdateTool implements Tool {
  readonly name = "doc.update";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Update a doc project's metadata. Pass any subset of {title, " +
    "kind, tags, pinned, archived} — omitted fields keep their " +
    "current value. Returns the updated project.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      kind: {
        type: "string",
        enum: ["note", "research", "report", "design", "guide"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      pinned: { type: "boolean" },
      archived: { type: "boolean" },
    },
    required: ["id"],
  };

  readonly #store: DocStore;

  constructor(store: DocStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("doc.update: bad args: missing `id`");
    }
    const project = await this.#store.getProject(id);
    if (project === undefined) {
      throw new Error(`doc not found: \`${id}\``);
    }
    let changed = false;
    if (obj["title"] !== undefined) {
      const trimmed = (asString(obj["title"]) ?? "").trim();
      if (trimmed === "") {
        throw new Error("doc.update: `title` must not be blank");
      }
      project.title = trimmed;
      changed = true;
    }
    const kind = asString(obj["kind"]);
    if (kind !== undefined) {
      project.kind = parseKind(kind);
      changed = true;
    }
    const tags = asStringArray(obj["tags"]);
    if (tags !== undefined) {
      project.tags = cleanTags(tags);
      changed = true;
    }
    const pinned = asBool(obj["pinned"]);
    if (pinned !== undefined) {
      project.pinned = pinned;
      changed = true;
    }
    const archived = asBool(obj["archived"]);
    if (archived !== undefined) {
      project.archived = archived;
      changed = true;
    }
    if (changed) {
      touchDocProject(project);
    }
    await this.#store.upsertProject(project);
    return JSON.stringify(project as unknown as JsonValue);
  }
}

// ---------- doc.delete -----------------------------------------------------

export class DocDeleteTool implements Tool {
  readonly name = "doc.delete";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Hard-delete a doc project AND every draft attached to it. " +
    "Irreversible. Prefer `doc.update { archived: true }` unless " +
    "the user explicitly asked to remove it permanently. Returns " +
    "`{deleted: bool}`.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  };

  readonly #store: DocStore;

  constructor(store: DocStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const id = asString(obj["id"]);
    if (id === undefined) {
      throw new Error("doc.delete: bad args: missing `id`");
    }
    const deleted = await this.#store.deleteProject(id);
    return JSON.stringify({ id, deleted });
  }
}

// ---------- doc.draft.get --------------------------------------------------

export class DocDraftGetTool implements Tool {
  readonly name = "doc.draft.get";
  readonly category: ToolCategory = "read";
  readonly description =
    "Fetch the most-recent draft (markdown body) of a doc " +
    "project. Returns `null` if the project has no drafts yet.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      project_id: { type: "string" },
    },
    required: ["project_id"],
  };

  readonly #store: DocStore;

  constructor(store: DocStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const projectId = asString(obj["project_id"]);
    if (projectId === undefined) {
      throw new Error("doc.draft.get: bad args: missing `project_id`");
    }
    const draft = await this.#store.latestDraft(projectId);
    return draft !== undefined ? JSON.stringify(draft) : "null";
  }
}

// ---------- doc.draft.save -------------------------------------------------

export class DocDraftSaveTool implements Tool {
  readonly name = "doc.draft.save";
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly description =
    "Append a new draft (revision) to a doc project. Drafts are " +
    "versioned — this never overwrites an existing draft. The UI " +
    "shows the most-recent one. Body is capped at 50KB; split " +
    "longer content into multiple doc projects.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: {
      project_id: { type: "string" },
      content: {
        type: "string",
        description: "Markdown body. Up to ~50KB.",
      },
      format: {
        type: "string",
        description: "Wire format. Defaults to `markdown` (the only supported value in v0).",
      },
    },
    required: ["project_id", "content"],
  };

  readonly #store: DocStore;

  constructor(store: DocStore) {
    this.#store = store;
  }

  async invoke(args: JsonValue): Promise<string> {
    const obj = asObject(args);
    const projectId = asString(obj["project_id"]);
    if (projectId === undefined) {
      throw new Error("doc.draft.save: bad args: missing `project_id`");
    }
    const content = asString(obj["content"]);
    if (content === undefined) {
      throw new Error("doc.draft.save: bad args: missing `content`");
    }
    const byteLen = Buffer.byteLength(content, "utf8");
    if (byteLen > MAX_DRAFT_BYTES) {
      throw new Error(
        `doc.draft.save: content too large (${byteLen} bytes) — cap is ${MAX_DRAFT_BYTES} bytes`,
      );
    }
    // Confirm the parent project exists; otherwise the orphan draft would
    // clutter the store and never be visible in the UI.
    if ((await this.#store.getProject(projectId)) === undefined) {
      throw new Error(`doc.draft.save: project \`${projectId}\` not found`);
    }
    const draft = newDocDraft(projectId, content);
    const format = asString(obj["format"]);
    if (format !== undefined) {
      const trimmed = format.trim();
      if (trimmed !== "") {
        draft.format = trimmed;
      }
    }
    await this.#store.upsertDraft(draft);
    await touchProject(this.#store, draft.project_id);
    return JSON.stringify(draft);
  }
}

// ---------- registration helper -------------------------------------------

/** Stores needed to construct the `doc.*` tool family. */
export interface DocToolStores {
  docs: DocStore;
  /**
   * Construction-time default workspace root for the workspace-targeting
   * tools (`doc.list` / `doc.search` / `doc.create` / `doc.upsert`). Falls
   * back to `"."` when omitted — mirrors the Rust `default_root` plumbed from
   * the composition root. Per-call `workspace` overrides always win.
   */
  fsRoot?: string;
}

/**
 * Construct and register the `doc.*` tool family into `registry`. Mirrors the
 * Rust `register_builtins` doc-store branch: all nine tools (`doc.list`,
 * `doc.search`, `doc.get`, `doc.upsert`, `doc.create`, `doc.update`,
 * `doc.delete`, `doc.draft.get`, `doc.draft.save`) register together when the
 * `DocStore` is supplied; the four mutators (`upsert`, `create`, `update`,
 * `delete`) and `draft.save` are approval-gated.
 */
export function registerDocTools(registry: ToolRegistry, stores: DocToolStores): void {
  const { docs } = stores;
  const root = stores.fsRoot ?? ".";
  registry.register(new DocListTool(docs, root));
  registry.register(new DocSearchTool(docs, root));
  registry.register(new DocGetTool(docs));
  registry.register(new DocUpsertTool(docs, root));
  registry.register(new DocCreateTool(docs, root));
  registry.register(new DocUpdateTool(docs));
  registry.register(new DocDeleteTool(docs));
  registry.register(new DocDraftGetTool(docs));
  registry.register(new DocDraftSaveTool(docs));
}
