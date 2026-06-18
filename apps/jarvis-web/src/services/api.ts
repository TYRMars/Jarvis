// API origin + URL helpers. The web client may run colocated with
// the Rust server (production: same-origin, no override) or against
// the Vite dev server (`vite preview` on :4173, `vite dev` on :5173,
// or opened as `file://` for sanity-checking a static build) — in
// those cases we fall back to a runtime override, a saved
// `jarvis.apiOrigin`, or the build-time `VITE_BACKEND_URL` default.
//
// Backend switch (migration): the default below is injected at build time
// from `VITE_BACKEND_URL` (see vite.config.ts), so the same SPA build can
// target the Rust server or the Node `@jarvis/jarvis-app` on a different
// port. At runtime, `setApiOriginOverride(...)` / `localStorage
// jarvis.apiOrigin` still win, so you can flip the live page between
// backends without a rebuild.

// Build-time backend origin (vite `define`); `undefined` under plain `tsc` /
// vitest where the define isn't applied — we fall back to the loopback default.
declare const __BACKEND_URL__: string | undefined;

const DEFAULT_BACKEND =
  typeof __BACKEND_URL__ === "string" && __BACKEND_URL__ ? __BACKEND_URL__ : "http://127.0.0.1:7001";

let runtimeOriginOverride: string | null = null;

export function setApiOriginOverride(origin: string | null): void {
  runtimeOriginOverride = origin ? origin.replace(/\/$/, "") : null;
}

function originOverride(): string {
  if (runtimeOriginOverride) return runtimeOriginOverride;
  const saved = localStorage.getItem("jarvis.apiOrigin");
  if (saved) return saved.replace(/\/$/, "");
  return DEFAULT_BACKEND.replace(/\/$/, "");
}

function usesExternalOrigin(): boolean {
  return !!runtimeOriginOverride || location.protocol === "file:" || ["4173", "5173"].includes(location.port);
}

export function apiUrl(path: string): string {
  if (usesExternalOrigin()) return `${originOverride()}${path}`;
  return path;
}

export function wsUrl(): string {
  if (usesExternalOrigin()) {
    const url = new URL(originOverride());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/chat/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/v1/chat/ws`;
}
