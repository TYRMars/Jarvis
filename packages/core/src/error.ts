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
  constructor(message: string) {
    super(`llm provider error: ${message}`);
    this.name = "ProviderError";
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

/**
 * Thrown out of the agent loop when the caller's `AbortSignal` fires. The loop
 * checks the signal between iterations and before each tool dispatch, so an
 * aborted run stops issuing `llm.complete` calls and — critically — stops
 * invoking side-effecting tools (`fs.write` / `shell.exec` / …). Callers that
 * race the run against their own timeout/cancel promise (e.g. the workflow
 * runtime) can treat this as the loop having halted, not a genuine failure.
 */
export class AbortError extends HarnessError {
  constructor(message = "agent run aborted") {
    super(message);
    this.name = "AbortError";
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
