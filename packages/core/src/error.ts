// Error types for the harness. Ported from harness-core/src/error.rs.
//
// Tool `invoke` may throw any error; the agent loop catches it and surfaces
// the message as text (`tool error: <message>`) so the model can recover —
// it never propagates as a thrown error out of the loop. Provider / memory /
// max-iteration failures DO propagate (out of `run`) or become a terminal
// `error` event (in `runStream`).

/** Base class for all harness errors. */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export class ProviderError extends HarnessError {
  /**
   * Upstream HTTP status when the error originated from an HTTP response.
   * Left unset for transport/parse/auth-plumbing errors that never reached a
   * status. Consumers (e.g. fallback classification) should prefer this
   * structured value over scanning the message text, since the text embeds the
   * raw upstream body and can contain misleading substrings.
   */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(`llm provider error: ${message}`);
    this.name = "ProviderError";
    if (status !== undefined) this.status = status;
  }
}

export class MemoryError extends HarnessError {
  constructor(message: string) {
    super(`memory error: ${message}`);
    this.name = "MemoryError";
  }
}

export class ApprovalError extends HarnessError {
  constructor(message: string) {
    super(`approval error: ${message}`);
    this.name = "ApprovalError";
  }
}

export class MaxIterationsError extends HarnessError {
  readonly iterations: number;
  constructor(iterations: number) {
    super(`agent reached max iterations (${iterations}) without terminating`);
    this.name = "MaxIterationsError";
    this.iterations = iterations;
  }
}

/** Best-effort Display of any thrown value, mirroring Rust's `format!("{e}")`. */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
