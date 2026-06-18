// Tool-progress channel. Ported from harness-core/src/progress.rs.
//
// Long-running tools (shell.exec, …) publish intermediate output via
// `emitProgress`; the agent loop relays each chunk as a `tool_progress`
// event. Scoped with AsyncLocalStorage in place of Rust's task_local; emits
// outside a `withProgress` scope are no-ops.
import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolProgress {
  /** Tool-defined stream label ("stdout" / "stderr" / "log" / …). */
  stream: string;
  /** Raw UTF-8 chunk content. */
  chunk: string;
}

const store = new AsyncLocalStorage<(progress: ToolProgress) => void>();

/** Publish a progress chunk. No-op outside a `withProgress` scope. */
export function emitProgress(stream: string, chunk: string): void {
  store.getStore()?.({ stream, chunk });
}

/** Whether a progress sink is installed for the current async context. */
export function progressActive(): boolean {
  return store.getStore() !== undefined;
}

/** Run `fn` with `sink` installed as the active progress sink. */
export function withProgress<T>(
  sink: (progress: ToolProgress) => void,
  fn: () => Promise<T>,
): Promise<T> {
  return store.run(sink, fn);
}
