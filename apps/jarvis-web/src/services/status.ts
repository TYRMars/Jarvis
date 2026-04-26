// Tiny status-bar helpers. The actual rendering lives in
// `<ConnectionStatus>` / `<Banner>` (React); these just push into
// the store so non-React modules (services/, legacy.ts) can surface
// transient errors and connection states without touching the DOM.

import { appStore } from "../store/appStore";

export function setStatus(key: string | null, cls: string | null = null): void {
  appStore.getState().setStatus(key, cls);
}

export function showError(msg: string | null): void {
  appStore.getState().showBanner(msg);
}

export function setInFlight(v: boolean): void {
  appStore.getState().setInFlight(v);
  document.body.classList.toggle("turn-in-flight", !!v);
}

/// Push a status briefly, then revert to "connected" — but only if
/// nobody pushed a different status in between. Used for one-shot
/// banners like "configured" / "interrupted".
export function showTransientStatus(key: string, cls: string): void {
  setStatus(key, cls);
  setTimeout(() => {
    if (appStore.getState().statusKey === key) setStatus("connected", "connected");
  }, 1200);
}
