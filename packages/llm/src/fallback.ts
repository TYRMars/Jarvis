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
 * When the error carries a structured HTTP `status` (every provider attaches
 * `resp.status` to the `ProviderError` it throws on a non-OK response), that
 * status is authoritative: 429 / 5xx are transient, every other status is not.
 * This avoids a false "not transient" verdict when a genuine 5xx/429 whose
 * response *body* merely mentions an auth subsystem (e.g. "503: authentication
 * service temporarily unavailable") would otherwise trip the substring scan.
 *
 * Only when no structured status is present (transport/decode errors, raw
 * `Error`s, strings) does it fall back to a lowercased substring scan.
 */
export function isTransientError(err: unknown): boolean {
  // Authoritative path: a structured upstream status beats any body substring.
  const status = providerStatus(err);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status <= 599);
  }
  const msg = errorText(err).toLowerCase();
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
 * Extract a structured HTTP status from a thrown value, if the provider
 * attached one. Returns the numeric `status` of a `ProviderError` (only when
 * it's a finite number), else undefined.
 */
function providerStatus(err: unknown): number | undefined {
  if (err instanceof ProviderError && typeof err.status === "number" && Number.isFinite(err.status)) {
    return err.status;
  }
  return undefined;
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
