// OAuth verification landing page.
//
// Reached after a WeCom 自建应用 OAuth round-trip:
//   1. Operator (or user) clicks an /v1/channels/:id/oauth/start link
//   2. Backend signs CSRF state and 302s to WeCom's authorize page
//   3. User authorises inside the WeCom client (snsapi_base = silent)
//   4. WeCom 302s back to /v1/channels/:id/oauth/callback?code=&state=
//   5. Backend verifies, fetches access_token, exchanges code→userid
//   6. Backend 302s here as `?userid=<u>&ctx=<c>` (when start passed
//      next=<this page>)
//
// What this page does NOT do:
//   - Mint sessions / log the user in. Jarvis has no user/auth model
//     yet; surfacing the verified userid is the v1 end-state.
//   - Auto-bind to a conversation. Would require a "current binding"
//     selector that this page doesn't have context for. Operators can
//     copy the userid here and paste into Settings → 渠道 manually.

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { t } from "../../utils/i18n";

// Local fallback-aware wrapper — same pattern as ChannelsSection. `t`
// returns the key itself when no translation exists, which is bad
// UX; this surfaces the English fallback we passed instead.
function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function OAuthResultPage() {
  const [params] = useSearchParams();
  const userid = params.get("userid") ?? "";
  const ctx = params.get("ctx") ?? "";
  const error = params.get("error") ?? "";

  const status = useMemo<"ok" | "error" | "missing">(() => {
    if (error) return "error";
    if (!userid) return "missing";
    return "ok";
  }, [error, userid]);

  // Subscribe to lang changes so the page re-renders on toggle. The
  // store path is via t()/tx() — they read `lang` lazily, but to
  // trigger a re-render we need a subscription. Reuse the existing
  // pattern from elsewhere by reading window flag.
  useEffect(() => {
    document.title = "OAuth — Jarvis";
  }, []);

  const [copied, setCopied] = useState(false);
  const copyUserId = async () => {
    if (!userid) return;
    try {
      await navigator.clipboard.writeText(userid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Insecure-origin / older browsers — fall through silently.
      // The userid is on screen for manual copy regardless.
    }
  };

  return (
    <div className="oauth-result-page">
      <div className="oauth-result-card" role="status">
        {status === "ok" && (
          <>
            <div className="oauth-result-icon" aria-hidden>
              ✅
            </div>
            <h1 className="oauth-result-title">
              {tx("oauthResultTitleOk", "Identity verified")}
            </h1>
            <p className="oauth-result-subtitle">
              {tx(
                "oauthResultSubtitleOk",
                "WeCom returned the userid below. Copy it or use it in your active conversation.",
              )}
            </p>
            <div className="oauth-result-field">
              <div className="oauth-result-field-label">
                {tx("oauthResultUseridLabel", "userid")}
              </div>
              <div className="oauth-result-field-row">
                <code className="oauth-result-userid">{userid}</code>
                <button
                  type="button"
                  className="settings-btn ghost"
                  onClick={() => void copyUserId()}
                >
                  {copied
                    ? tx("oauthResultCopied", "Copied!")
                    : tx("oauthResultCopy", "Copy")}
                </button>
              </div>
            </div>
            {ctx && (
              <div className="oauth-result-field">
                <div className="oauth-result-field-label">
                  {tx("oauthResultCtxLabel", "ctx (caller-supplied)")}
                </div>
                <code className="oauth-result-ctx">{ctx}</code>
              </div>
            )}
          </>
        )}
        {status === "error" && (
          <>
            <div className="oauth-result-icon oauth-result-icon-error" aria-hidden>
              ⚠️
            </div>
            <h1 className="oauth-result-title">
              {tx("oauthResultTitleError", "Verification failed")}
            </h1>
            <p className="oauth-result-subtitle">{error}</p>
          </>
        )}
        {status === "missing" && (
          <>
            <div className="oauth-result-icon oauth-result-icon-error" aria-hidden>
              ❓
            </div>
            <h1 className="oauth-result-title">
              {tx("oauthResultTitleMissing", "No verification result")}
            </h1>
            <p className="oauth-result-subtitle">
              {tx(
                "oauthResultSubtitleMissing",
                "Open this page via the OAuth flow from Settings → Channels — direct visits have no userid to show.",
              )}
            </p>
          </>
        )}
        <div className="oauth-result-actions">
          <Link to="/settings" className="settings-btn">
            {tx("oauthResultBackToSettings", "Back to settings")}
          </Link>
          <Link to="/" className="settings-btn ghost">
            {tx("oauthResultHome", "Home")}
          </Link>
        </div>
      </div>
    </div>
  );
}
