// Permission modes + rule engine + REST routes.
//
// Ported from:
//   - crates/harness-core/src/permission.rs      (the engine: modes, rule
//     table, glob matcher, mode→default mapping, the PermissionStore trait)
//   - crates/harness-server/src/permissions.rs    (the /v1/permissions routes)
//
// In the Rust tree the *engine* lives in harness-core and the *routes* in
// harness-server. This Node port keeps them in one module because the Node
// `@jarvis/core` index is owned by a separate step (we must not edit it). The
// exported `PermissionMode` type + `evaluateTable` / `modeDefault` /
// `RuleApprover` are the reusable bits the composition root and the WebSocket
// transport consume later; everything else is the REST surface.
//
// ## Mode semantics
//
// | Mode          | Default decision                                            |
// |---------------|-------------------------------------------------------------|
// | "ask"         | every gated tool prompts via the fallback Approver          |
// | "accept-edits"| auto-allow `write` tools; ask for everything else gated     |
// | "plan"        | read-only — the LLM tool catalogue is filtered to `read`    |
// |               | tools + a synthetic `exit_plan`; the engine treats it       |
// |               | like Ask for whatever still calls it                        |
// | "auto"        | auto-allow everything gated                                 |
// | "bypass"      | auto-allow everything; UI shows a persistent warning        |
//
// ## Rule evaluation
//
// Eval order: every rule in `deny` (first match wins) → every rule in `ask`
// → every rule in `allow` → fall through to the mode default. `matchers`
// keys are JSON Pointers (RFC 6901) into the tool's arguments object; an
// empty matcher set means "match every invocation of this tool". A rule with
// `tool: "*"` matches every tool name.
//
// ## REST surface (mounted only when `state.permissionStore` is wired)
//
// - `GET    /v1/permissions`        — full table snapshot
// - `POST   /v1/permissions/rules`  — append rule (body: {scope, bucket, rule})
// - `DELETE /v1/permissions/rules`  — delete rule (query: scope, bucket, index)
// - `PUT    /v1/permissions/mode`   — set the default mode of a scope (body: {scope, mode})
import type { FastifyInstance, FastifyReply } from "fastify";
import type { JsonValue } from "@jarvis/core";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  ToolCategory,
} from "@jarvis/core";
import type { AppState } from "./state.ts";

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * What permission mode the session is currently in. Drives the fall-through
 * "no rule matched" decision plus the Plan Mode tool filter that the binary
 * installs. Serialised kebab-case to match the Rust enum's wire form.
 */
export type PermissionMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "accept-edits",
  "plan",
  "auto",
  "bypass",
];

/**
 * Parse a permission mode from a string (CLI flag, env var, settings file).
 * Accepts the same aliases as Rust's `PermissionMode::parse`. Returns
 * `undefined` for unknown values so callers can format their own error.
 */
export function parsePermissionMode(s: string): PermissionMode | undefined {
  switch (s) {
    case "ask":
      return "ask";
    case "accept-edits":
    case "accept_edits":
    case "acceptEdits":
      return "accept-edits";
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "bypass":
    case "bypass-permissions":
    case "bypassPermissions":
      return "bypass";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Decision / Scope
// ---------------------------------------------------------------------------

/** Outcome of evaluating a tool call against the rule table + mode. */
export type Decision = "allow" | "deny" | "ask";

/**
 * Where a stored rule came from / where the user wants a new rule written.
 * Higher entries override lower entries during evaluation:
 * `user > project > session`.
 */
export type Scope = "session" | "project" | "user";

const DECISIONS: readonly Decision[] = ["allow", "deny", "ask"];
const SCOPES: readonly Scope[] = ["session", "project", "user"];

function isDecision(v: unknown): v is Decision {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}
function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * One persisted rule. `tool` is either a literal tool name (`"shell.exec"`)
 * or `"*"` (every tool). `matchers` are JSON pointers into the tool's
 * argument object → glob pattern. An empty / absent matcher set means "match
 * every invocation of this tool".
 */
export interface PermissionRule {
  tool: string;
  /** JSON-pointer → glob pattern. Omitted on the wire when empty (serde parity). */
  matchers?: Record<string, string>;
}

/** A rule that matches every call to `tool`, no argument constraints. */
export function wholeToolRule(tool: string): PermissionRule {
  return { tool };
}

/** Add or replace one matcher. Returns a new rule (builder style). */
export function withMatcher(rule: PermissionRule, pointer: string, glob: string): PermissionRule {
  return { tool: rule.tool, matchers: { ...(rule.matchers ?? {}), [pointer]: glob } };
}

/**
 * Test whether `rule` matches `(tool, args)`. The tool name must equal
 * `rule.tool` (or `rule.tool === "*"`); each matcher's pointer must resolve
 * to a string in `args` and that string must satisfy the glob.
 */
export function ruleMatches(rule: PermissionRule, tool: string, args: JsonValue): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  const matchers = rule.matchers;
  if (!matchers) return true;
  for (const pointer of Object.keys(matchers)) {
    const pat = matchers[pointer]!;
    const target = resolvePointer(args, pointer);
    if (typeof target !== "string") return false;
    if (!globMatch(pat, target)) return false;
  }
  return true;
}

/**
 * Resolve an RFC-6901 JSON Pointer against `value`. Returns the addressed
 * node, or `undefined` if the pointer doesn't resolve. The empty pointer
 * (`""`) addresses the whole document. `~1`/`~0` unescape to `/` / `~`.
 */
function resolvePointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let cur: JsonValue = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      // Numeric index only (no `-` end-of-array support; the engine only
      // dereferences object string fields in practice).
      if (!/^\d+$/.test(token)) return undefined;
      const idx = Number(token);
      if (idx >= cur.length) return undefined;
      cur = cur[idx]!;
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return undefined;
      cur = (cur as { [k: string]: JsonValue })[token]!;
    } else {
      return undefined;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Hit source / result
// ---------------------------------------------------------------------------

/**
 * Where the final decision came from. Surfaced in `ApprovalDecision` events
 * so the UI / audit log can show "auto-allowed by user-scope rule fs.edit".
 */
export type HitSource =
  | { kind: "rule"; scope: Scope; bucket: Decision; index: number }
  | { kind: "mode_default"; mode: PermissionMode }
  | { kind: "user_prompt" };

/** Result of `evaluateTable`. */
export interface RuleHit {
  decision: Decision;
  source: HitSource;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** A rule with its origin scope attached. */
export interface ScopedRule {
  scope: Scope;
  // The rule is flattened into the same object on the wire (serde `flatten`),
  // so `tool` / `matchers` sit alongside `scope`.
  tool: string;
  matchers?: Record<string, string>;
}

/**
 * Persisted permission state — the default mode + three rule buckets. The
 * merged in-memory table the engine evaluates against.
 */
export interface PermissionTable {
  default_mode: PermissionMode;
  deny: ScopedRule[];
  ask: ScopedRule[];
  allow: ScopedRule[];
}

export function emptyTable(): PermissionTable {
  return { default_mode: "ask", deny: [], ask: [], allow: [] };
}

function scopedToRule(sr: ScopedRule): PermissionRule {
  return sr.matchers ? { tool: sr.tool, matchers: sr.matchers } : { tool: sr.tool };
}

/**
 * Walk `deny → ask → allow → mode-default` against `(tool, args)` and return
 * the first match. The caller computes `modeDefault` for the tool's category
 * and passes it in so this stays free of per-tool tagging.
 */
export function evaluateTable(
  table: PermissionTable,
  tool: string,
  args: JsonValue,
  modeDefaultDecision: Decision,
  activeMode: PermissionMode,
): RuleHit {
  const buckets: ReadonlyArray<[Decision, ScopedRule[]]> = [
    ["deny", table.deny],
    ["ask", table.ask],
    ["allow", table.allow],
  ];
  for (const [bucket, rules] of buckets) {
    for (let idx = 0; idx < rules.length; idx++) {
      const sr = rules[idx]!;
      if (ruleMatches(scopedToRule(sr), tool, args)) {
        return { decision: bucket, source: { kind: "rule", scope: sr.scope, bucket, index: idx } };
      }
    }
  }
  return { decision: modeDefaultDecision, source: { kind: "mode_default", mode: activeMode } };
}

// ---------------------------------------------------------------------------
// Glob matching — token-aware so an `allow shell.exec(npm test*)` rule can't
// match `npm test; rm -rf ~`. Ported verbatim from permission.rs::glob_match.
// ---------------------------------------------------------------------------

const WHITESPACE_RE = /\s+/;

function splitWhitespace(s: string): string[] {
  return s.split(WHITESPACE_RE).filter((t) => t.length > 0);
}

export function globMatch(pattern: string, target: string): boolean {
  const patTokens = splitWhitespace(pattern);
  const tgtTokens = splitWhitespace(target);
  if (patTokens.length !== tgtTokens.length) {
    // A trailing `*` token absorbs the rest, e.g. `git diff *` matches
    // `git diff src/foo`.
    if (patTokens.length > 0 && patTokens[patTokens.length - 1] === "*") {
      if (tgtTokens.length >= patTokens.length - 1) {
        // Zip up to the shorter length (mirrors Rust's `.zip`): the trailing
        // `*` token absorbs whatever remains and is never compared.
        const n = Math.min(patTokens.length, tgtTokens.length);
        for (let i = 0; i < n; i++) {
          if (!tokenMatch(patTokens[i]!, tgtTokens[i]!)) return false;
        }
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i < patTokens.length; i++) {
    if (!tokenMatch(patTokens[i]!, tgtTokens[i]!)) return false;
  }
  return true;
}

function tokenMatch(pattern: string, target: string): boolean {
  // `*` / `**` in a single-token context mean "match anything here".
  if (pattern === "*" || pattern === "**") return true;
  if (!pattern.includes("*")) return pattern === target;
  const parts = pattern.split("*");
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.length === 0) continue;
    if (i === 0) {
      if (!target.slice(cursor).startsWith(part)) return false;
      cursor += part.length;
    } else if (i === parts.length - 1) {
      return target.slice(cursor).endsWith(part);
    } else {
      const pos = target.slice(cursor).indexOf(part);
      if (pos < 0) return false;
      cursor += pos + part.length;
    }
  }
  // Pattern ended in `*` → the rest of target is fine.
  const last = parts[parts.length - 1];
  return last === undefined || last.length === 0;
}

// ---------------------------------------------------------------------------
// Mode → default-decision mapping
// ---------------------------------------------------------------------------

/**
 * Compute the fall-through decision for a tool when no rule matched.
 *
 * - "ask"          → always prompt
 * - "accept-edits" → auto-allow `write` tools, prompt for everything else
 * - "plan"         → would prompt, but Plan Mode hides write/exec/network
 *                    tools from the LLM so the approver rarely sees them
 * - "auto"         → auto-allow everything
 * - "bypass"       → auto-allow everything (entry guarded by the binary)
 */
export function modeDefault(mode: PermissionMode, category: ToolCategory): Decision {
  switch (mode) {
    case "ask":
      return "ask";
    case "accept-edits":
      return category === "write" ? "allow" : "ask";
    case "plan":
      return "ask";
    case "auto":
    case "bypass":
      return "allow";
  }
}

// ---------------------------------------------------------------------------
// PermissionStore — persistence seam. Concrete file-backed impls live in the
// composition root later; the in-memory impl below covers Session scope +
// tests + the route module's needs.
// ---------------------------------------------------------------------------

export interface PermissionStore {
  /** Current merged table (user ∪ project ∪ session). Cheap; no disk hit. */
  snapshot(): Promise<PermissionTable>;
  /** Append a rule into the named scope's bucket. Duplicates allowed. */
  appendRule(scope: Scope, bucket: Decision, rule: PermissionRule): Promise<void>;
  /** Remove the rule at `index` of the named (scope, bucket). Throws on OOB. */
  deleteRule(scope: Scope, bucket: Decision, index: number): Promise<void>;
  /** Update the `default_mode` recorded in the named scope. */
  setDefaultMode(scope: Scope, mode: PermissionMode): Promise<void>;
}

/** Error message substring the route handler maps to a 404. Matches Rust's check. */
export const OUT_OF_BOUNDS = "out of bounds";

/**
 * In-memory permission store. Backs Session scope and tests; the merge here
 * is the simple "all three scopes share one table, mode = the last set" model
 * adequate for a single-process run. File-backed scopes layer on top later.
 */
export class MemoryPermissionStore implements PermissionStore {
  #table: PermissionTable = emptyTable();

  /**
   * The current session default mode, read synchronously. This is the single
   * source of truth a {@link RuleApprover}'s {@link ModeHandle} delegates to,
   * so a `PUT /v1/permissions/mode` that calls {@link setDefaultMode} takes
   * effect for the next gated tool call without any extra plumbing.
   */
  currentMode(): PermissionMode {
    return this.#table.default_mode;
  }

  snapshot(): Promise<PermissionTable> {
    // Deep-ish clone so callers can't mutate our buckets.
    return Promise.resolve({
      default_mode: this.#table.default_mode,
      deny: this.#table.deny.map(cloneScoped),
      ask: this.#table.ask.map(cloneScoped),
      allow: this.#table.allow.map(cloneScoped),
    });
  }

  appendRule(scope: Scope, bucket: Decision, rule: PermissionRule): Promise<void> {
    const sr: ScopedRule = rule.matchers
      ? { scope, tool: rule.tool, matchers: { ...rule.matchers } }
      : { scope, tool: rule.tool };
    this.#bucket(bucket).push(sr);
    return Promise.resolve();
  }

  deleteRule(_scope: Scope, bucket: Decision, index: number): Promise<void> {
    const list = this.#bucket(bucket);
    if (index < 0 || index >= list.length) {
      return Promise.reject(new Error(`rule index ${index} ${OUT_OF_BOUNDS} for ${bucket} bucket`));
    }
    list.splice(index, 1);
    return Promise.resolve();
  }

  setDefaultMode(_scope: Scope, mode: PermissionMode): Promise<void> {
    this.#table.default_mode = mode;
    return Promise.resolve();
  }

  #bucket(bucket: Decision): ScopedRule[] {
    switch (bucket) {
      case "deny":
        return this.#table.deny;
      case "ask":
        return this.#table.ask;
      case "allow":
        return this.#table.allow;
    }
  }
}

function cloneScoped(sr: ScopedRule): ScopedRule {
  return sr.matchers ? { scope: sr.scope, tool: sr.tool, matchers: { ...sr.matchers } } : { scope: sr.scope, tool: sr.tool };
}

// ---------------------------------------------------------------------------
// RuleApprover — consults a PermissionStore before falling through to a
// wrapped Approver. The reusable piece the WS transport / composition root
// install around their ChannelApprover. Mirrors permission.rs::RuleApprover.
// ---------------------------------------------------------------------------

/** A mutable holder for the per-socket active mode (RwLock<PermissionMode> in Rust). */
export interface ModeHandle {
  get(): PermissionMode;
}

export class RuleApprover implements Approver {
  #store: PermissionStore;
  #fallback: Approver;
  #mode: ModeHandle;

  constructor(store: PermissionStore, fallback: Approver, mode: ModeHandle) {
    this.#store = store;
    this.#fallback = fallback;
    this.#mode = mode;
  }

  currentMode(): PermissionMode {
    return this.#mode.get();
  }

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const [decision] = await this.approveWithSource(request);
    return decision;
  }

  async approveWithSource(request: ApprovalRequest): Promise<[ApprovalDecision, HitSource]> {
    const activeMode = this.#mode.get();
    const table = await this.#store.snapshot();
    const def = modeDefault(activeMode, request.category);
    const hit = evaluateTable(table, request.tool_name, request.arguments, def, activeMode);
    switch (hit.decision) {
      case "allow":
        return [{ decision: "approve" }, hit.source];
      case "deny": {
        const by =
          hit.source.kind === "rule"
            ? hit.source.scope
            : hit.source.kind === "mode_default"
              ? hit.source.mode
              : "user";
        return [{ decision: "deny", reason: `denied by ${by} rule` }, hit.source];
      }
      case "ask": {
        const decision = await this.#fallback.approve(request);
        return [decision, { kind: "user_prompt" }];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// State seam. `permissionStore` now lives on {@link AppState} proper (folded in
// by the composition root, which seeds it from `JARVIS_PERMISSION_MODE` and
// wraps every `createAgent` approver in a {@link RuleApprover} around it), so
// these routes read it directly. Absent → every permission route 503s.
// ---------------------------------------------------------------------------

/** Return the store, or send a 503 and return undefined. */
function requireStore(state: AppState, reply: FastifyReply): PermissionStore | undefined {
  if (!state.permissionStore) {
    reply.code(503).send({ error: "permission store not configured" });
    return undefined;
  }
  return state.permissionStore;
}

function internalError(reply: FastifyReply, e: unknown): FastifyReply {
  const msg = e instanceof Error ? e.message : String(e);
  return reply.code(500).send({ error: msg });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerPermissionsRoutes(app: FastifyInstance, state: AppState): void {
  const s = state;

  // ------------------- GET /v1/permissions -------------------
  app.get("/v1/permissions", async (_req, reply) => {
    const store = requireStore(s, reply);
    if (!store) return reply;
    try {
      const table = await store.snapshot();
      return reply.send({
        default_mode: table.default_mode,
        deny: table.deny,
        ask: table.ask,
        allow: table.allow,
      });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // ------------------- POST /v1/permissions/rules -------------------
  app.post("/v1/permissions/rules", async (req, reply) => {
    const store = requireStore(s, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { scope?: unknown; bucket?: unknown; rule?: unknown };
    if (!isScope(body.scope)) {
      return reply.code(400).send({ error: "scope must be one of session|project|user" });
    }
    if (!isDecision(body.bucket)) {
      return reply.code(400).send({ error: "bucket must be one of deny|ask|allow" });
    }
    const rule = parseRule(body.rule);
    if (!rule) {
      return reply.code(400).send({ error: "rule.tool must be a non-empty string" });
    }
    try {
      await store.appendRule(body.scope, body.bucket, rule);
      return reply.code(201).send({ ok: true });
    } catch (e) {
      return internalError(reply, e);
    }
  });

  // ------------------- DELETE /v1/permissions/rules -------------------
  app.delete("/v1/permissions/rules", async (req, reply) => {
    const store = requireStore(s, reply);
    if (!store) return reply;
    const q = (req.query ?? {}) as { scope?: unknown; bucket?: unknown; index?: unknown };
    if (!isScope(q.scope)) {
      return reply.code(400).send({ error: "scope must be one of session|project|user" });
    }
    if (!isDecision(q.bucket)) {
      return reply.code(400).send({ error: "bucket must be one of deny|ask|allow" });
    }
    const index = parseIndex(q.index);
    if (index === undefined) {
      return reply.code(400).send({ error: "index must be a non-negative integer" });
    }
    try {
      await store.deleteRule(q.scope, q.bucket, index);
      return reply.send({ ok: true });
    } catch (e) {
      // Out-of-bounds is the most common shape → surface as 404 (Rust parity).
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes(OUT_OF_BOUNDS)) {
        return reply.code(404).send({ error: msg });
      }
      return internalError(reply, e);
    }
  });

  // ------------------- PUT /v1/permissions/mode -------------------
  app.put("/v1/permissions/mode", async (req, reply) => {
    const store = requireStore(s, reply);
    if (!store) return reply;
    const body = (req.body ?? {}) as { scope?: unknown; mode?: unknown };
    if (!isScope(body.scope)) {
      return reply.code(400).send({ error: "scope must be one of session|project|user" });
    }
    const mode = typeof body.mode === "string" ? parsePermissionMode(body.mode) : undefined;
    if (!mode) {
      return reply.code(400).send({ error: "mode must be one of ask|accept-edits|plan|auto|bypass" });
    }
    // Bypass mode is never writable to the project scope — it would let any
    // committed file silently disable approval for everyone who pulls the
    // repo. User / session scope is fine: those are private to this machine.
    if (body.scope === "project" && mode === "bypass") {
      return reply.code(400).send({
        error:
          "bypass mode cannot be written to project scope (it would commit to git and affect every teammate); use user or session scope instead",
      });
    }
    try {
      await store.setDefaultMode(body.scope, mode);
      return reply.send({ ok: true, mode });
    } catch (e) {
      return internalError(reply, e);
    }
  });
}

/** Validate + normalise a rule body. Returns undefined when `tool` is missing/blank. */
function parseRule(raw: unknown): PermissionRule | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as { tool?: unknown; matchers?: unknown };
  if (typeof obj.tool !== "string" || obj.tool.length === 0) return undefined;
  let matchers: Record<string, string> | undefined;
  if (obj.matchers !== undefined && obj.matchers !== null) {
    if (typeof obj.matchers !== "object" || Array.isArray(obj.matchers)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.matchers as Record<string, unknown>)) {
      if (typeof v !== "string") return undefined;
      out[k] = v;
    }
    if (Object.keys(out).length > 0) matchers = out;
  }
  return matchers ? { tool: obj.tool, matchers } : { tool: obj.tool };
}

/** Parse a non-negative integer index from a query value (string or number). */
function parseIndex(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}
