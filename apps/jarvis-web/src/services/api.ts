// API origin + URL helpers. The web client may run colocated with
// the Rust server (production: same-origin, no override) or against
// the Vite dev server (`vite preview` on :4173, `vite dev` on :5173,
// or opened as `file://` for sanity-checking a static build) — in
// those cases we fall back to a saved `jarvis.apiOrigin` (or the
// hardcoded loopback default) instead of the page origin.

let runtimeOriginOverride: string | null = null;

export function setApiOriginOverride(origin: string | null): void {
  runtimeOriginOverride = origin ? origin.replace(/\/$/, "") : null;
}

function originOverride(): string {
  if (runtimeOriginOverride) return runtimeOriginOverride;
  const saved = localStorage.getItem("jarvis.apiOrigin");
  if (saved) return saved.replace(/\/$/, "");
  return "http://127.0.0.1:7001";
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
