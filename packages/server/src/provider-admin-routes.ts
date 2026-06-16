// REST routes for runtime provider admin. Ported from
// crates/harness-server/src/provider_admin_routes.rs + provider_registry.rs.
//
// All endpoints are mounted only when a `ProviderAdmin` impl is wired onto
// `AppState.providerAdmin`. When the binary didn't wire one, every admin call
// returns `503 Service Unavailable` so the Web UI can render an
// "edit-from-config-only" hint instead of crashing (per CLAUDE.md:
// "/v1/providers (+ /default) … 503 when no admin impl is wired").
//
// Endpoints:
//
// | Method | Path                     | Body                                   | Returns                       |
// |--------|--------------------------|----------------------------------------|-------------------------------|
// | POST   | /v1/providers            | ProviderDef                            | 201 {provider: Snapshot}      |
// | GET    | /v1/providers/:name      | —                                      | 200 {provider: Snapshot}      |
// | PATCH  | /v1/providers/:name      | ProviderDef (name in body must match)  | 200 {provider: Snapshot}      |
// | DELETE | /v1/providers/:name      | ?purge_secret=true (default true)      | 200 {deleted: boolean}        |
// | PUT    | /v1/providers/default    | {name}                                 | 200 {default: name}           |
//
// On any successful mutation the handler invokes `state.providersChanged?.()`
// (the broadcast seam) so connected WS clients can refetch `/v1/providers` and
// re-render their picker. Both the admin impl and the change-notify hook are
// OPTIONAL seams on AppState — absent in the committed shape, wired by the
// composition root (apps/jarvis) which alone knows the binary `Config`. See the
// `ProviderAdminState` widening below; the Assemble step adds the fields to
// AppState proper.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppState } from "./state.ts";

// ---------------------------------------------------------------------------
// Value types — ported from provider_admin.rs + provider_registry.rs.
// ---------------------------------------------------------------------------

/**
 * One model's capability snapshot, echoed verbatim through the admin impl. The
 * route handler never constructs these — it only passes whatever the impl
 * returns onto the wire — so the field stays an opaque passthrough here rather
 * than importing the full `ModelCapability` from `@jarvis/llm` (which is not a
 * dependency of `@jarvis/server`). The real shape lives in
 * packages/llm/src/profile.ts and is preserved losslessly across the boundary.
 */
export type ModelCapabilityLike = Record<string, unknown>;

/**
 * Wire shape for `POST /v1/providers` and `PATCH /v1/providers/:name`. Mirrors
 * the binary's `ProviderConfig` so the Web form ↔ on-disk `config.json`
 * round-trip is verbatim. Rust uses `#[serde(deny_unknown_fields)]`; we do not
 * reject extra keys here — the admin impl owns validation and surfaces
 * `ProvisionError.Invalid` for anything it can't accept.
 */
export interface ProviderDef {
  /**
   * User-chosen, unique within the registry. The auth-file is keyed off this
   * (`~/.config/jarvis/auth/<name>.json`) so renaming is NOT an in-place edit;
   * delete + re-add.
   */
  name: string;
  /**
   * Provider kind selecting which LlmProvider impl is constructed. Mirrors the
   * binary's `build_provider` switch: `"openai"` / `"openai-responses"` /
   * `"anthropic"` / `"google"` / `"codex"` / `"kimi"` / `"kimi-code"` /
   * `"ollama"`. Custom OpenAI-compatible endpoints use `"openai"` + a non-empty
   * `base_url`.
   */
  kind: string;
  /**
   * API key in plaintext on the wire. Never echoed back on reads (GET only
   * reports whether a key is present). Only sent on create / update; omitting
   * it on PATCH leaves the existing auth-file untouched.
   */
  api_key?: string;
  /** HTTP base URL override (required for `kind="openai"` non-OpenAI targets). */
  base_url?: string;
  /** Default model id used when the request doesn't specify one. */
  default_model: string;
  /** Curated model list for the picker. Empty is fine — registry adds default. */
  models?: string[];
  /** Anthropic `anthropic-version` header. */
  version?: string;
  /** Codex / OpenAI-Responses `reasoning.summary` (`auto`/`concise`/`detailed`). */
  reasoning_summary?: string;
  /** Codex / OpenAI-Responses `reasoning.effort` (`low`/`medium`/`high`/`max`). */
  reasoning_effort?: string;
  /** Codex / OpenAI-Responses: include `reasoning.encrypted_content`. */
  include_encrypted_reasoning?: boolean;
  /** Codex / OpenAI-Responses `service_tier` (`auto`/`priority`/`flex`). */
  service_tier?: string;
  /** Codex: override the default `~/.codex` directory. */
  codex_home?: string;
  /** Codex: override the default `/codex/responses` endpoint path. */
  codex_path?: string;
  /** Codex: `originator` header (defaults to `"jarvis"`). */
  codex_originator?: string;
}

/**
 * Snapshot of a provider's state for the edit form. Mirrors `ProviderDef` but
 * NEVER carries the api_key — the form shows "Key on file: yes/no" via
 * `has_api_key` and only writes a new one when the user supplies it.
 */
export interface ProviderSnapshot {
  name: string;
  kind: string;
  /** `true` when an api-key auth file or env var is in scope. */
  has_api_key: boolean;
  default_model: string;
  models: string[];
  is_default: boolean;
  base_url?: string;
  version?: string;
  reasoning_summary?: string;
  reasoning_effort?: string;
  include_encrypted_reasoning?: boolean;
  service_tier?: string;
  codex_home?: string;
  codex_path?: string;
  codex_originator?: string;
}

/**
 * Wire shape for `GET /v1/providers` (the read-only list served elsewhere; the
 * value type lives here for completeness alongside the admin routes). `kind` /
 * `capabilities` are absent for legacy entries that predate profile metadata.
 * Ported from `provider_registry.rs::ProviderInfo`.
 */
export interface ProviderInfo {
  name: string;
  default_model: string;
  models: string[];
  is_default: boolean;
  /** Omitted when empty (serde `skip_serializing_if = "String::is_empty"`). */
  kind?: string;
  /** Omitted when empty (serde `skip_serializing_if = "Vec::is_empty"`). */
  capabilities?: ModelCapabilityLike[];
}

// ---------------------------------------------------------------------------
// ProvisionError — sum type the admin impl rejects with. The kind maps to an
// HTTP status in `mapError`. Mirrors `provider_admin.rs::ProvisionError`.
// `erasableSyntaxOnly` forbids enums, so this is a string-union discriminant.
// ---------------------------------------------------------------------------

export type ProvisionErrorKind =
  | "invalid"
  | "already_exists"
  | "not_found"
  | "construction"
  | "persistence";

/** Carries a kind (→ status) plus a human message (→ `{error}` body). */
export class ProvisionError extends Error {
  readonly kind: ProvisionErrorKind;
  constructor(kind: ProvisionErrorKind, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.kind = kind;
  }
  static invalid(msg: string): ProvisionError {
    return new ProvisionError("invalid", `invalid provider config: ${msg}`);
  }
  static alreadyExists(name: string): ProvisionError {
    return new ProvisionError("already_exists", `provider \`${name}\` already exists`);
  }
  static notFound(name: string): ProvisionError {
    return new ProvisionError("not_found", `provider \`${name}\` not found`);
  }
  static construction(msg: string): ProvisionError {
    return new ProvisionError("construction", `provider construction failed: ${msg}`);
  }
  static persistence(msg: string): ProvisionError {
    return new ProvisionError("persistence", `persistence i/o error: ${msg}`);
  }
}

/**
 * The interface every binary that wants Web-UI-driven provider management
 * implements. `apps/jarvis` is the one impl today; future binaries can stub it
 * out (or simply not wire it) so the routes return 503 cleanly. Mirrors
 * `provider_admin.rs::ProviderAdmin`.
 */
export interface ProviderAdmin {
  /**
   * Create or fully-replace a provider. POST passes `allowOverwrite=false`,
   * PATCH passes `true`. Returns the live snapshot of the newly-installed
   * provider so the caller can echo it back without a separate read.
   */
  provision(def: ProviderDef, allowOverwrite: boolean): Promise<ProviderSnapshot>;
  /**
   * Drop a provider. Resolves `true` if a row was removed, `false` when the
   * name wasn't installed (idempotent delete). `purgeSecret=true` also wipes
   * the auth-file.
   */
  unprovision(name: string, purgeSecret: boolean): Promise<boolean>;
  /** Set the registry-wide default provider. Must already be installed. */
  setDefault(name: string): Promise<void>;
  /** Full snapshot of one provider for the Web UI's edit form. */
  snapshot(name: string): Promise<ProviderSnapshot>;
}

// ---------------------------------------------------------------------------
// State seam. The committed AppState does not yet carry `providerAdmin` /
// `providersChanged` (and this port must not edit state.ts), so the routes read
// them off a structural widening. The composition root sets them; the Assemble
// step folds these fields into AppState proper.
// ---------------------------------------------------------------------------

interface ProviderAdminState extends AppState {
  /** Runtime provider admin impl. Absent → every admin route 503s. */
  providerAdmin?: ProviderAdmin;
  /**
   * Change-notify hook fired after any successful mutation so WS clients can
   * refetch `/v1/providers`. Mirrors Rust's `state.providers_changed.send(())`.
   * Optional — absent means "no listeners wired", a silent no-op.
   */
  providersChanged?: () => void;
}

/** Return the admin impl, or send a 503 and return undefined. */
function requireAdmin(state: ProviderAdminState, reply: FastifyReply): ProviderAdmin | undefined {
  if (!state.providerAdmin) {
    reply
      .code(503)
      .send({ error: "provider admin not configured (binary didn't wire ProviderAdmin)" });
    return undefined;
  }
  return state.providerAdmin;
}

/** Map a `ProvisionError` (or any thrown error) onto a status + `{error}` body. */
function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ProvisionError) {
    const status =
      e.kind === "invalid" || e.kind === "construction"
        ? 400
        : e.kind === "already_exists"
          ? 409
          : e.kind === "not_found"
            ? 404
            : 500; // persistence
    return reply.code(status).send({ error: e.message });
  }
  // Defensive: an impl that throws something unexpected becomes a 500 rather
  // than a thrown handler (Fastify would 500 anyway, but we keep the body shape).
  const msg = e instanceof Error ? e.message : String(e);
  return reply.code(500).send({ error: msg });
}

/** Fire the change-notify hook if wired (silent no-op otherwise). */
function notifyChanged(state: ProviderAdminState): void {
  state.providersChanged?.();
}

export function registerProviderAdminRoutes(app: FastifyInstance, state: AppState): void {
  const s = state as ProviderAdminState;

  // ---------------------- POST /v1/providers --------------------------------
  app.post("/v1/providers", async (req, reply) => {
    const admin = requireAdmin(s, reply);
    if (!admin) return reply;
    const body = (req.body ?? {}) as ProviderDef;
    try {
      const snapshot = await admin.provision(body, false);
      notifyChanged(s);
      return reply.code(201).send({ provider: snapshot });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------- GET /v1/providers/:name ---------------------------
  app.get("/v1/providers/:name", async (req, reply) => {
    const admin = requireAdmin(s, reply);
    if (!admin) return reply;
    const { name } = req.params as { name: string };
    try {
      const snapshot = await admin.snapshot(name);
      return reply.send({ provider: snapshot });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------- PATCH /v1/providers/:name -------------------------
  app.patch("/v1/providers/:name", async (req, reply) => {
    const admin = requireAdmin(s, reply);
    if (!admin) return reply;
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as ProviderDef;
    // The path's name is authoritative. Accepting a body name lets callers send
    // a full ProviderDef back from a GET, but renaming mid-PATCH is unsupported
    // (the auth-file key would orphan).
    if (typeof body.name === "string" && body.name !== "" && body.name !== name) {
      return sendError(
        reply,
        ProvisionError.invalid(
          `PATCH cannot rename \`${name}\` → \`${body.name}\` (delete + re-create)`,
        ),
      );
    }
    body.name = name;
    try {
      const snapshot = await admin.provision(body, true);
      notifyChanged(s);
      return reply.send({ provider: snapshot });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------- DELETE /v1/providers/:name ------------------------
  app.delete("/v1/providers/:name", async (req, reply) => {
    const admin = requireAdmin(s, reply);
    if (!admin) return reply;
    const { name } = req.params as { name: string };
    // `purge_secret` defaults to `true` for the Web UI's "Delete provider"
    // button — keeping the secret around when the provider is gone is more
    // confusing than helpful. Only an explicit `false`/`0`/`no` opts out.
    const raw = (req.query as { purge_secret?: string }).purge_secret;
    const purgeSecret =
      raw === undefined ? true : !(raw === "false" || raw === "0" || raw === "no");
    try {
      const removed = await admin.unprovision(name, purgeSecret);
      if (removed) notifyChanged(s);
      return reply.send({ deleted: removed });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------- PUT /v1/providers/default -------------------------
  app.put("/v1/providers/default", async (req, reply) => {
    const admin = requireAdmin(s, reply);
    if (!admin) return reply;
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") {
      return sendError(reply, ProvisionError.invalid("`name` must not be blank"));
    }
    try {
      await admin.setDefault(name);
      notifyChanged(s);
      return reply.send({ default: name });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
