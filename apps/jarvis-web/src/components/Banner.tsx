// Top-of-chat error banner. Subscribes to `appStore.bannerError`
// and auto-hides 6 s after each new message — same UX the old
// imperative `showError()` had, just owned by React now. Replacing
// the legacy `els.banner.textContent = ...` path is part of Batch B.

import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";

const HIDE_AFTER_MS = 6000;

export function Banner() {
  const message = useAppStore((s) => s.bannerError);
  const showBanner = useAppStore((s) => s.showBanner);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!message) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      showBanner(null);
      timer.current = null;
    }, HIDE_AFTER_MS);
    return () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [message, showBanner]);

  // Keep the legacy id so `els.banner` lookups inside legacy.ts
  // still resolve; the imperative `showError` now writes to both
  // the store and (for the moment) the DOM, so behaviour is
  // identical even if a non-migrated module reads the node.
  return (
    <div id="banner" className={message ? "" : "hidden"} role="status">
      {message || ""}
    </div>
  );
}
