// Test runner setup — extends `expect` with the DOM matchers from
// `@testing-library/jest-dom`, polyfills `localStorage` (vitest 4
// + jsdom 29 ship without it by default), and resets the Zustand
// store between every test so one suite's writes don't bleed into
// the next.

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// In-memory `Storage` shim so `localStorage.getItem("...")` works
// without `--localstorage-file`. Closer to the browser semantics
// we actually rely on than the empty default jsdom now ships.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}
const ls = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });

// Snapshot the store's initial state so we can rewind after each
// test. The import has to land *after* the localStorage polyfill so
// the module-level `loadX()` calls that seed the store don't crash.
const { useAppStore } = await import("../store/appStore");
const INITIAL = useAppStore.getState();

beforeEach(() => {
  ls.clear();
});

afterEach(() => {
  cleanup();
  useAppStore.setState(INITIAL, /*replace=*/ true);
});
