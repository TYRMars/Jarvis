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
 * Every provider formats an upstream failure as `status <code>: <body>`, so we
 * prefer that structured status: when it's present we classify on the code
 * alone and ignore the body entirely. This is deliberate — the response body
 * may itself mention an auth subsystem (e.g. a `503` whose body reads
 * "authentication service temporarily unavailable", or a rate-limit body whose
 * trace id contains "401"), and a substring scan of the whole text would
 * misread those transient outages as fatal and defeat failover.
 *
 * Only when no HTTP status is present (a raw network/transport error, or an
 * auth failure thrown before any round-trip) do we fall back to substring
 * heuristics over the lowercased text, so it still works on any thrown value —
 * `ProviderError`, a raw `Error`, or a string.
 */
export function isTransientError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();

  // Prefer the structured HTTP status when the error was formatted with one.
  const status = httpStatusFromMessage(msg);
  if (status !== undefined) {
    // Transient: rate-limit, request-timeout, and any 5xx server failure. Every
    // other code (401/403/400/404/…) is a request-level problem the next
    // provider would hit identically, so it propagates.
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
  }

  // No structured status — classify from the text.
  // Definite-not-transient: auth + bad-request signals.
  const authOrBadRequest =
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("authentication");
  if (authOrBadRequest) return false;
  // Transient: rate limit / server error / network.
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate-limit") ||
    msg.includes("rate_limit") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
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
 * Pull the HTTP status out of a provider-formatted error message. Providers
 * render upstream failures as `status <code>: <body>`, so the FIRST
 * `status <code>:` in the (lowercased) message is the real response status —
 * anything the body itself happens to say about "status" comes after it and is
 * ignored. Returns `undefined` when the message carries no such prefix.
 */
function httpStatusFromMessage(msg: string): number | undefined {
  const m = /status (\d{3}):/.exec(msg);
  return m ? Number(m[1]) : undefined;
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
