// Policy for renderer-initiated new windows (window.open / target="_blank").
//
// The bundled SPA opens external URLs (channel OAuth2 start URLs, doc/PR links)
// via `window.open(url, "_blank", …)` and `target="_blank"` anchors. Without a
// `webContents.setWindowOpenHandler`, Electron answers each of these by spawning
// a *new in-app BrowserWindow* — a child window NOT covered by the parent's
// hardened `webPreferences`, free to navigate to attacker-influenced OAuth / PR
// destinations inside the app shell (Electron security-checklist: "disable or
// limit creation of new windows").
//
// We never let Electron create such a child window: always deny. An http(s) URL
// is instead handed to the OS browser via `shell.openExternal`; anything else
// (about:blank, javascript:, file:, custom schemes) is dropped silently.
//
// This is the child-window / `window.open` vector, distinct from `will-navigate`
// main-frame navigation lockdown (issue #171). Kept as a pure function so the
// decision is unit-testable without an Electron runtime; `index.ts` performs the
// `shell.openExternal` side effect based on the result.

/** Decision for a renderer-requested new window. `action` is always `"deny"`. */
export interface WindowOpenDecision {
  /** Electron `WindowOpenHandlerResponse` action — we never allow new windows. */
  readonly action: "deny";
  /** When present, hand this URL to the OS browser (`shell.openExternal`). */
  readonly openExternal?: string;
}

/**
 * Decide how to answer a renderer's new-window request.
 *
 * @param url The target URL Electron reports for the `window.open` / `_blank`.
 * @returns Always `{ action: "deny" }`; for `http:`/`https:` targets also
 *          carries `openExternal` so the caller routes it to the OS browser.
 */
export function decideWindowOpen(url: string): WindowOpenDecision {
  if (/^https?:\/\//i.test(url)) {
    return { action: "deny", openExternal: url };
  }
  return { action: "deny" };
}
