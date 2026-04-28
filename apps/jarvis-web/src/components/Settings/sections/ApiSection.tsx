// API origin override. The web bundle defaults to same-origin (the
// Rust server it ships from). External-origin scenarios — `vite
// preview` on :4173, `vite dev` on :5173, opening `dist/index.html`
// from `file://` — fall back to a saved `jarvis.apiOrigin` (or
// `http://127.0.0.1:7001`). This section is the user-visible
// override for that key.
//
// Saving requires a page reload to re-bootstrap the WS connection
// against the new origin (the WS URL is computed once at boot).
// We surface that explicitly rather than auto-reload — silently
// reconnecting under the user feels worse than asking.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";

const KEY = "jarvis.apiOrigin";
const DEFAULT_HINT = "http://127.0.0.1:7001";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function ApiSection() {
  const [origin, setOrigin] = useState("");
  const [savedOrigin, setSavedOrigin] = useState("");
  // Read once on mount. localStorage doesn't fire `storage` events
  // for same-tab writes, so subsequent edits use local state until
  // the user hits Save.
  useEffect(() => {
    const v = localStorage.getItem(KEY) || "";
    setOrigin(v);
    setSavedOrigin(v);
  }, []);

  const dirty = origin !== savedOrigin;
  const onSave = () => {
    const cleaned = origin.trim().replace(/\/$/, "");
    if (cleaned) {
      localStorage.setItem(KEY, cleaned);
    } else {
      localStorage.removeItem(KEY);
    }
    setOrigin(cleaned);
    setSavedOrigin(cleaned);
  };
  const onReset = () => {
    localStorage.removeItem(KEY);
    setOrigin("");
    setSavedOrigin("");
  };

  return (
    <Section
      id="api"
      titleKey="settingsApiTitle"
      titleFallback="API"
      descKey="settingsApiDesc"
      descFallback="Backend origin override. Empty means same-origin (the server this page was loaded from). Reload after saving."
    >
      <Row
        label={tx("settingsApiOrigin", "API origin")}
        hint={tx("settingsApiOriginHint", "Used when the page isn't served from the Jarvis backend (vite dev/preview, file://). Default fallback: http://127.0.0.1:7001")}
      >
        <div className="settings-input-row">
          <input
            type="url"
            className="settings-input"
            placeholder={DEFAULT_HINT}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button type="button" className="settings-btn" disabled={!dirty} onClick={onSave}>
            {tx("settingsSave", "Save")}
          </button>
          <button type="button" className="settings-btn settings-btn-ghost" onClick={onReset} disabled={!savedOrigin && !origin}>
            {tx("settingsReset", "Reset")}
          </button>
        </div>
      </Row>

      {dirty && (
        <p className="settings-warning">
          {tx("settingsReloadNeeded", "Reload the page after saving — the WebSocket reconnects only on first load.")}
        </p>
      )}
    </Section>
  );
}
