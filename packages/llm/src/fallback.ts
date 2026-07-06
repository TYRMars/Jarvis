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
 * Classification prefers the **HTTP status** (structured `ProviderError.status`,
 * or the `status <N>:` prefix providers format their errors with) over scanning
 * the free text. This matters because the error text embeds the raw upstream
 * response *body*, which can itself mention auth ("authentication service
 * temporarily unavailable") or contain digits like `401` in a trace id. A pure
 * substring scan would then misclassify a genuine transient 5xx/429 as fatal
 * and defeat failover. Only when no status is recoverable (transport / parse /
 * network errors, or non-`ProviderError` throwables) do we fall back to the
 * substring heuristic — and there transient signals are checked first so an
 * incidental auth substring can't veto a real transient signal.
 */
export function isTransientError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status !== undefined) {
    // Authoritative: the status wins over any substring in the body.
    // 429 + 5xx are transient; 4xx (auth / bad request) and anything else are
    // not — the next provider shares the same auth surface or request shape.
    return status === 429 || (status >= 500 && status <= 599);
  }

  // No recoverable status — fall back to substring heuristics on the text.
  const msg = errorText(err).toLowerCase();
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
 * Recover the upstream HTTP status from an error, preferring the structured
 * `ProviderError.status` field and falling back to the `status <N>:` prefix
 * that every provider's `#post` formats HTTP failures with (e.g.
 * `llm provider error: status 503: <body>`). Returns `undefined` when no status
 * is present so the caller can drop to text heuristics. The prefix is anchored
 * so a status-looking digit sequence *inside* the response body can't match.
 */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof ProviderError && err.status !== undefined) return err.status;
  const m = /(?:^|:\s*)status (\d{3})\b/i.exec(errorText(err));
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
