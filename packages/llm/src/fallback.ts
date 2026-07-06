// Provider-level fallback wrapper. Ported from harness-llm/src/fallback.rs.
//
// `FallbackProvider` wraps a primary `LlmProvider` plus an ordered chain of
// `{ name, provider }` fallbacks. On a transient upstream failure
// (429 / 5xx / timeout / connect error) it walks the chain in order, returning
// the first successful result. Non-transient failures (auth / other 4xx /
// model-invalid) propagate immediately — fallback semantics are "this provider
// is unhealthy *right now*", not "this request is wrong".
//
// Streaming:
//   * If `completeStream` rejects synchronously (e.g. the auth round-trip
//     failed before the SSE handshake) with a transient error, retry against
//     the next fallback.
//   * If it resolves with an iterable and the stream itself errors later, that
//     propagates. Mid-stream retries would replay tokens the user already saw.
import { ProviderError, errorText } from "@jarvis/core";
import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";

/**
 * One named entry in the fallback chain. `name` is informational (matches the
 * registry-side provider name when applicable) and is used to filter out a
 * self-referencing fallback.
 */
export interface FallbackEntry {
  name: string;
  provider: LlmProvider;
}

/** Convenience constructor mirroring `FallbackEntry::new`. */
export function fallbackEntry(name: string, provider: LlmProvider): FallbackEntry {
  return { name, provider };
}

/**
 * Heuristic — is this error worth retrying against the next provider? Mirrors
 * the Rust `is_transient_error`: 4xx auth failures are *not* transient (the
 * next provider has the same auth surface), but 429 rate-limits, 5xx server
 * failures, and connection-level errors are.
 *
 * Matches against the lowercased error text (substring scan), so it works on
 * any thrown value — `ProviderError`, a raw `Error`, or a string.
 */
export function isTransientError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  // Prefer the authoritative HTTP status. Every provider formats an upstream
  // failure as `status <code>: <body>`, so the leading status is ground truth:
  // the response *body* may itself mention an auth subsystem ("authentication
  // service temporarily unavailable") or carry a stray `401` in a trace id, and
  // that must never override a genuine 429/5xx. Substring-scanning the whole
  // text (the old behaviour) let those bodies defeat failover.
  const status = httpStatus(msg);
  if (status !== null) {
    // 429 rate-limit + any 5xx are transient (retry the next provider). Every
    // other explicit code (401/403/400/404/…) is fatal for failover — the next
    // provider shares the same auth surface, or the request itself is wrong.
    return status === 429 || (status >= 500 && status <= 599);
  }
  // No explicit status → a network / transport error (or a bare message).
  // Auth / bad-request text is fatal; connection-level + rate-limit signals
  // are transient.
  const authOrBadRequest =
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("authentication");
  if (authOrBadRequest) return false;
  return (
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("rate_limit") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("network") ||
    msg.includes("dns") ||
    msg.includes("reset by peer") ||
    msg.includes("transport:") ||
    msg.includes("error sending request")
  );
}

/**
 * Extract the authoritative HTTP status code from an error message, if any.
 * Recognises the provider `status <code>` / `HTTP <code>` shapes first, then a
 * bare 3-digit code at the start of the (possibly prefixed) message — so both
 * `status 503: …` and a raw `"401 unauthorized"` are handled — while ignoring
 * digits buried later in a response body. Returns `null` when no plausible
 * status is present. `msg` is expected pre-lowercased.
 */
function httpStatus(msg: string): number | null {
  const m = /(?:status|http)\s+(\d{3})\b/.exec(msg) ?? /(?:^|:\s*)(\d{3})\b/.exec(msg);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 100 && n < 600 ? n : null;
}

/**
 * Wraps a primary provider + ordered fallback chain. Identical surface to
 * `LlmProvider` so callers have nothing to migrate.
 */
export class FallbackProvider implements LlmProvider {
  readonly #primaryName: string;
  readonly #primary: LlmProvider;
  readonly #fallbacks: ReadonlyArray<FallbackEntry>;

  /**
   * `primaryName` is the registry name of the wrapped provider. `fallbacks` is
   * the ordered chain — entries with the same name as `primaryName` are dropped
   * to avoid retry-self.
   */
  constructor(primaryName: string, primary: LlmProvider, fallbacks: FallbackEntry[]) {
    this.#primaryName = primaryName;
    this.#primary = primary;
    this.#fallbacks = fallbacks.filter((f) => f.name !== primaryName);
  }

  /** Number of registered fallback entries (useful for startup logs + tests). */
  fallbackCount(): number {
    return this.#fallbacks.length;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    let lastError: unknown;
    try {
      return await this.#primary.complete(req);
    } catch (e) {
      if (!isTransientError(e)) throw e;
      lastError = e;
    }

    for (const entry of this.#fallbacks) {
      try {
        return await entry.provider.complete(req);
      } catch (e) {
        if (!isTransientError(e)) throw e;
        lastError = e;
      }
    }
    throw asError(lastError);
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    let lastError: unknown;
    try {
      return await this.#primary.completeStream(req);
    } catch (e) {
      if (!isTransientError(e)) throw e;
      lastError = e;
    }

    for (const entry of this.#fallbacks) {
      try {
        return await entry.provider.completeStream(req);
      } catch (e) {
        if (!isTransientError(e)) throw e;
        lastError = e;
      }
    }
    throw asError(lastError);
  }
}

/** Re-throw the last seen error verbatim, or synthesise one if nothing was captured. */
function asError(e: unknown): unknown {
  if (e !== undefined) return e;
  return new ProviderError("fallback chain exhausted with no error recorded");
}
