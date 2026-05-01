// Shared singleton for the active Docs page scope (All / Pinned /
// Kind / Tag / Archive). Both `AppSidebar.DocSidebarBody` and
// `DocsPage` read/write it via `useDocScope`; using a module-local
// store lets the rail live in the global sidebar without paying the
// cost of putting transient UI state into `appStore.ts`.

import { useSyncExternalStore } from "react";
import type { DocKind } from "../types/frames";

export type DocScope =
  | { type: "all" }
  | { type: "pinned" }
  | { type: "archived" }
  | { type: "kind"; kind: DocKind }
  | { type: "tag"; tag: string };

let scope: DocScope = { type: "all" };
const subs = new Set<() => void>();

function notify() {
  for (const s of subs) {
    try {
      s();
    } catch (e) {
      console.warn("doc-scope subscriber threw", e);
    }
  }
}

export function getDocScope(): DocScope {
  return scope;
}

export function setDocScope(next: DocScope): void {
  // Keep referential identity stable when nothing changed so React
  // bail-out works on `useSyncExternalStore`.
  if (sameScope(scope, next)) return;
  scope = next;
  notify();
}

export function subscribeDocScope(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export function useDocScope(): DocScope {
  return useSyncExternalStore(subscribeDocScope, getDocScope, getDocScope);
}

export function sameScope(a: DocScope, b: DocScope): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "kind" && b.type === "kind") return a.kind === b.kind;
  if (a.type === "tag" && b.type === "tag") return a.tag === b.tag;
  return true;
}
