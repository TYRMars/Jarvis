// Registry of custom-block markdown handlers. Standard blocks
// (paragraph, heading, lists, table, code block, etc.) are baked
// into parse.ts / stringify.ts; custom blocks (Callout, Toggle, …)
// register themselves here so the serializer stays open for
// extension without re-opening the core walker.

import type { BlockHandler } from "./types";

const handlers: BlockHandler[] = [];

/** Register a custom handler. Called once per extension at module
 *  load. Idempotent on duplicate `pmType`. */
export function registerHandler(handler: BlockHandler): void {
  const existing = handlers.findIndex((h) => h.pmType === handler.pmType);
  if (existing >= 0) handlers[existing] = handler;
  else handlers.push(handler);
}

/** Look up by PM node type (used by stringify.ts). */
export function handlerForPmType(pmType: string): BlockHandler | undefined {
  return handlers.find((h) => h.pmType === pmType);
}

/** Look up by mdast node type (used by parse.ts). May match
 *  more than one handler — the first one whose `parse` returns
 *  non-null wins. */
export function handlersForMdastType(mdastType: string): BlockHandler[] {
  return handlers.filter((h) => h.mdastTypes.includes(mdastType));
}

/** Test-only: drop every registered handler. */
export function _clearHandlersForTesting(): void {
  handlers.length = 0;
}
