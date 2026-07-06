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
  // Prefer a structured HTTP status when one is derivable — either an explicit
  // `status` field on a `ProviderError`, or the `status <N>:` prefix every
  // provider's `#post` emits. Classifying on the status directly avoids the
  // substring trap where a genuinely transient 5xx/429 whose response *body*
  // mentions "authentication" (or contains "401" in a trace id) is misread as
  // fatal and defeats failover.
  const status = httpStatusOf(err);
  if (status !== undefined) {
    // 408 Request Timeout / 425 Too Early / 429 rate-limit / any 5xx: retry.
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
      return true;
    }
    // Any other 4xx (auth, bad request, not-found, unprocessable): terminal.
    if (status >= 400 && status <= 499) return false;
    // Unexpected 1xx–3xx surfacing as an error: fall through to substrings.
  }

  const msg = errorText(err).toLowerCase();
  // No usable status (network/transport error, or a non-HTTP throw): fall back
  // to substring signals. Auth + bad-request first.
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
 * Best-effort extraction of an upstream HTTP status from a thrown value.
 * Prefers an explicit `ProviderError.status`; otherwise reads the leading
 * `status <N>:` prefix that every provider's `#post` prepends when formatting
 * an upstream failure (`status ${resp.status}: ${body}`). Returns `undefined`
 * for network/transport errors and non-HTTP throws, which carry no status.
 */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof ProviderError && typeof err.status === "number") return err.status;
  // Match only the provider-formatted prefix (`status <N>:`), not any `status`
  // token buried later in the upstream body.
  const m = /(?:^|\bstatus )(\d{3}):/.exec(errorText(err));
  if (m) return Number(m[1]);
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
