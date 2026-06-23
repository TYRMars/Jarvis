// Navigation lockdown policy for the privileged renderer.
//
// The main window is hardened on the webPreferences side (contextIsolation,
// sandbox, nodeIntegration off) and then navigated to the live embedded-server
// origin via `loadURL`, so the SPA runs SAME-ORIGIN with the preload bridge
// (openPath / revealPath / restart IPC). A hardened webPreferences is necessary
// but not sufficient: without pinning navigation, any in-page navigation — a
// malicious/compromised link, an injected redirect, or `window.open` — could
// move the privileged renderer to an arbitrary origin that then inherits the
// preload IPC surface (Electron security checklist).
//
// `isNavigationAllowed` is the single decision point for `will-navigate`. It is
// Electron-free so it can be unit-tested under plain `node --test`.

/**
 * Decide whether the privileged renderer may navigate to `target`.
 *
 * Allowed:
 *   - `file:` URLs — the bundled SPA fallback loaded from disk before / when the
 *     embedded server is unavailable.
 *   - the current embedded-server origin (`allowedOrigin`); its port can change
 *     across restarts, so callers pass the live value.
 *
 * Everything else (other http(s) origins, `about:`, custom schemes, unparseable
 * targets) is refused. Programmatic `loadURL` / `loadFile` do not fire
 * `will-navigate`, so our own navigation to the server origin is never blocked.
 */
export function isNavigationAllowed(target: string, allowedOrigin: string | null): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return true;
  return allowedOrigin !== null && url.origin === allowedOrigin;
}

/** Normalise an api_origin string to its origin, or null if unparseable. */
export function originOf(apiOrigin: string): string | null {
  try {
    return new URL(apiOrigin).origin;
  } catch {
    return null;
  }
}
