// Global keyboard shortcuts. Mounted once at the App root via
// `useShortcuts()`; the listener attaches to `document` so it works
// regardless of which surface has focus.
//
// Cmd/Ctrl shortcuts (K/L/P/J/Slash) work even from the textarea —
// they don't conflict with normal typing. Bare `?` only fires
// outside editable surfaces. Esc runs a cascade: close transient
// overlays first, then if nothing else absorbed it, request a
// server-side interrupt for the in-flight turn.

import { useEffect } from "react";
import { appStore } from "../store/appStore";
import { newConversation } from "../services/conversations";
import { requestInterrupt } from "../services/socket";
import { selectModel } from "../services/socket";

export function useShortcuts(opts: { showHelp: () => void }): void {
  const { showHelp } = opts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditable =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      const store = appStore.getState();

      // ---- Cmd/Ctrl + letter ----
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        newConversation();
        return;
      }
      if (meta && e.key.toLowerCase() === "l") {
        e.preventDefault();
        document.getElementById("convo-search")?.focus();
        return;
      }
      if (meta && e.key.toLowerCase() === "p") {
        // Cmd + P shadows browser Print, but in a chat app the
        // muscle memory points at "find a thing" not "print a page".
        e.preventDefault();
        store.setQuickOpen(true);
        return;
      }
      if (meta && e.key === "/") {
        e.preventDefault();
        const ta = document.getElementById("input") as HTMLTextAreaElement | null;
        ta?.focus();
        const cur = store.composerValue;
        if (!cur.startsWith("/")) store.setComposerValue("/" + cur);
        return;
      }
      if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        store.setWorkspaceRailOpen(!store.workspaceRailOpen);
        return;
      }

      // ---- Esc cascade ----
      if (e.key === "Escape") {
        const wasModel = store.modelMenuOpen;
        const wasSlash = store.composerValue.startsWith("/");
        const wasQuick = store.quickOpen;
        store.setModelMenuOpen(false);
        store.setWorkspacePanelMenuOpen(false);
        store.setAccountMenuOpen(false);
        if (wasSlash) store.setComposerValue("");
        if (wasQuick) store.setQuickOpen(false);
        if (!wasModel && !wasSlash && !wasQuick && store.inFlight) {
          requestInterrupt();
        }
        document.body.classList.remove("approvals-open");
        return;
      }

      // ---- Bare `?` outside editable surfaces ----
      if (!inEditable && !meta && !e.altKey && e.key === "?") {
        e.preventDefault();
        showHelp();
        return;
      }

      // ---- Number-key model picker (1-9) when menu is open ----
      if (!store.modelMenuOpen) return;
      if (e.key >= "1" && e.key <= "9") {
        const flat: string[] = [];
        for (const p of store.providers) {
          const seen = new Set<string>();
          for (const m of [p.default_model, ...p.models]) {
            if (!m || seen.has(m)) continue;
            seen.add(m);
            flat.push(`${p.name}|${m}`);
          }
        }
        const target = flat[Number(e.key) - 1];
        if (target) selectModel(target);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showHelp]);
}
