// ChatGPT-OAuth credentials for the Codex Responses provider.
// Ported from harness-llm/src/codex_auth.rs.
//
// Two construction paths:
//   * CodexAuth.fromStatic({accessToken, accountId?}) — caller supplies a
//     bearer token directly. No on-disk state, no refresh capability. Useful
//     for tests, scripts, prototyping.
//   * CodexAuth.loadFromCodexHome(codexHomeDir) — reads `<dir>/auth.json`,
//     the file the official `codex` CLI writes on `codex login`. Carries the
//     refresh token + the path so `refresh()` can rotate the access token in
//     place and write it back atomically.
//
// On a 401 from the Responses backend the provider locks this struct and calls
// `refresh()`, which POSTs `grant_type=refresh_token` to
// `https://auth.openai.com/oauth/token` with the SAME `client_id` the Codex
// CLI uses (we extend the same session, not impersonate a different client).
// The endpoint is overridable for tests via the constructor config.
//
// `refresh` writes back to disk with a write-then-rename atomic sequence so a
// crash mid-write doesn't leave a corrupt auth.json.
//
// NOTE: never reads process.env — the refresh-URL override and codex-home dir
// are always passed in explicitly (env reading lives in the composition root).
import { ProviderError, errorText } from "@jarvis/core";
import { readFile, writeFile, rename } from "node:fs/promises";
import * as path from "node:path";

/**
 * OAuth client id used by the Codex CLI for ChatGPT login. We re-use it on
 * refresh so the same session keeps working — a distinct client_id would
 * require its own token issuance flow.
 */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Options for {@link CodexAuth.fromStatic}. */
export interface StaticAuthInit {
  accessToken: string;
  accountId?: string | null;
}

/**
 * Working credentials for the Codex Responses backend. Cheap to construct
 * (just a few strings); the provider keeps a single instance behind an
 * async mutex so refresh-on-401 is serialised.
 */
export class CodexAuth {
  accessToken: string;
  /** `null` for static/dev tokens — refresh fails with a clear error. */
  refreshToken: string | null;
  accountId: string | null;
  /**
   * Where the credentials came from; `null` means "in-memory only, don't
   * write back on refresh".
   */
  readonly #persistPath: string | null;
  /**
   * Override of the refresh endpoint. Defaults to the live OpenAI URL; tests
   * inject a local stub here (the Rust impl used CODEX_REFRESH_TOKEN_URL_OVERRIDE).
   */
  readonly #refreshUrl: string;
  /** Injected `fetch` (tests / proxies). Defaults to global fetch. */
  readonly #fetch: typeof fetch;

  private constructor(init: {
    accessToken: string;
    refreshToken: string | null;
    accountId: string | null;
    persistPath: string | null;
    refreshUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.accessToken = init.accessToken;
    this.refreshToken = init.refreshToken;
    this.accountId = init.accountId;
    this.#persistPath = init.persistPath;
    this.#refreshUrl = init.refreshUrl ?? REFRESH_TOKEN_URL;
    this.#fetch = init.fetchImpl ?? fetch;
  }

  /**
   * Static token — used when the caller supplies bearer credentials
   * out-of-band (e.g. a CODEX_ACCESS_TOKEN env var resolved upstream). No
   * refresh capability.
   */
  static fromStatic(init: StaticAuthInit, opts: CodexAuthOptions = {}): CodexAuth {
    return new CodexAuth({
      accessToken: init.accessToken,
      refreshToken: null,
      accountId: init.accountId ?? null,
      persistPath: null,
      refreshUrl: opts.refreshUrl,
      fetchImpl: opts.fetchImpl,
    });
  }

  /**
   * Read `<codexHome>/auth.json` and pull out the bearer token, refresh
   * token, and ChatGPT account id. The on-disk format is the one the Codex
   * CLI writes — parsed permissively, requiring only the fields we use.
   */
  static async loadFromCodexHome(codexHome: string, opts: CodexAuthOptions = {}): Promise<CodexAuth> {
    return CodexAuth.loadFromFile(path.join(codexHome, "auth.json"), opts);
  }

  /**
   * Read an `auth.json`-shaped file at an arbitrary path. The persisted-write
   * path on `refresh()` is set to this same file, so refresh updates land
   * where they were loaded from.
   */
  static async loadFromFile(filePath: string, opts: CodexAuthOptions = {}): Promise<CodexAuth> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (e) {
      throw new ProviderError(`read ${filePath}: ${errorText(e)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw new ProviderError(`parse auth.json: ${errorText(e)}`);
    }
    if (!isObject(value)) {
      throw new ProviderError("auth.json is not a JSON object");
    }
    const tokens = value["tokens"];
    if (!isObject(tokens)) {
      throw new ProviderError("auth.json has no `tokens` block; run `jarvis login --provider codex`");
    }
    const accessToken = tokens["access_token"];
    if (typeof accessToken !== "string") {
      throw new ProviderError("auth.json missing tokens.access_token");
    }
    const refreshToken = typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : null;
    const accountId = typeof tokens["account_id"] === "string" ? tokens["account_id"] : null;
    return new CodexAuth({
      accessToken,
      refreshToken,
      accountId,
      persistPath: filePath,
      refreshUrl: opts.refreshUrl,
      fetchImpl: opts.fetchImpl,
    });
  }

  /** True iff this credential can refresh (i.e. has a refresh token). */
  canRefresh(): boolean {
    return this.refreshToken !== null;
  }

  /**
   * POST to the refresh endpoint with `grant_type=refresh_token` to rotate
   * the access token. On success, in-memory state and (if loaded from disk)
   * the on-disk auth.json are both updated. Failures throw with the upstream
   * status / body text.
   */
  async refresh(): Promise<void> {
    const refreshToken = this.refreshToken;
    if (refreshToken === null) {
      throw new ProviderError("no refresh_token available; static-token mode cannot refresh");
    }

    const form = new URLSearchParams();
    form.set("client_id", CLIENT_ID);
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken);

    let resp: Response;
    try {
      resp = await this.#fetch(this.#refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    } catch (e) {
      throw new ProviderError(`refresh transport: ${errorText(e)}`);
    }

    let body: string;
    try {
      body = await resp.text();
    } catch (e) {
      throw new ProviderError(`refresh read body: ${errorText(e)}`);
    }
    if (!resp.ok) {
      throw new ProviderError(`refresh failed: status ${resp.status}: ${body}`, resp.status);
    }

    let parsed: { access_token?: unknown; refresh_token?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch (e) {
      throw new ProviderError(`decode refresh response: ${errorText(e)}; body=${body}`);
    }
    if (typeof parsed.access_token !== "string") {
      throw new ProviderError(`decode refresh response: missing access_token; body=${body}`);
    }

    this.accessToken = parsed.access_token;
    if (typeof parsed.refresh_token === "string") {
      this.refreshToken = parsed.refresh_token;
    }

    if (this.#persistPath !== null) {
      await this.writeBack(this.#persistPath);
    }
  }

  /**
   * Atomic write to `auth.json`: read existing JSON, replace just the
   * `tokens.access_token` (and `tokens.refresh_token` if it rotated), write to
   * a sibling `*.tmp` and rename. Preserves any other fields the Codex CLI may
   * have written (`auth_mode`, `OPENAI_API_KEY`, `last_refresh`, …).
   */
  async writeBack(filePath: string): Promise<void> {
    let value: Record<string, unknown> = {};
    try {
      const existing = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(existing);
      if (isObject(parsed)) value = parsed;
    } catch {
      // Missing or corrupt file → start from {} (Rust: json!({}) fallback).
      value = {};
    }

    const tokensValue = value["tokens"];
    const tokens: Record<string, unknown> = isObject(tokensValue) ? tokensValue : {};
    tokens["access_token"] = this.accessToken;
    if (this.refreshToken !== null) {
      tokens["refresh_token"] = this.refreshToken;
    }
    value["tokens"] = tokens;

    const pretty = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${filePath}.tmp`;
    try {
      await writeFile(tmp, pretty, "utf8");
    } catch (e) {
      throw new ProviderError(`write ${tmp}: ${errorText(e)}`);
    }
    try {
      await rename(tmp, filePath);
    } catch (e) {
      throw new ProviderError(`rename onto ${filePath}: ${errorText(e)}`);
    }
  }
}

/** Shared options for the `CodexAuth` loaders / static constructor. */
export interface CodexAuthOptions {
  /** Override the OAuth refresh endpoint (tests inject a local stub). */
  refreshUrl?: string;
  /** Inject a `fetch` implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
