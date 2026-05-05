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
        // Preserve the active project + workspace when the user hits
        // Cmd+K — they expect "new chat in the same context", not a
        // hard reset. Match the locked-popover "New chat (keep
        // project)" semantics.
        newConversation({
          projectId: store.draftProjectId ?? null,
          workspacePath: store.draftWorkspacePath ?? null,
        });
        return;
      }
      // Cmd/Ctrl+N: route-aware "new item" — mirrors the primary
      // create action of whichever surface the user is on. Lets a
      // single muscle memory ("new thing") work across all three
      // products. Page-level pages listen for the same event the
      // sidebar's "+ New" button dispatches, so this stays in sync
      // without each route having to wire its own handler.
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const path = window.location.pathname;
        if (path.startsWith("/projects")) {
          window.dispatchEvent(new Event("jarvis:new-project"));
        } else if (path.startsWith("/docs")) {
          window.dispatchEvent(new Event("jarvis:new-doc"));
        } else {
          // Same "preserve context" semantics as Cmd+K above —
          // keyboard shortcut and locked-popover button stay in sync.
          newConversation({
            projectId: store.draftProjectId ?? null,
            workspacePath: store.draftWorkspacePath ?? null,
          });
        }
        return;
      }
      if (meta && (e.key.toLowerCase() === "l" || e.key.toLowerCase() === "p")) {
        // Cmd+P (and the legacy Cmd+L) both open the QuickSwitcher
        // modal — unified surface for "find a chat" by title or by
        // message body. Cmd+P shadows browser Print, but in a chat
        // app the muscle memory points at "find a thing" not "print
        // a page". Cmd+L used to focus the inline sidebar input;
        // that input is gone (the modal covers its job + more).
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
      if (meta && e.key.toLowerCase() === "b") {
        e.preventDefault();
        store.setSidebarOpen(!store.sidebarOpen);
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

      // ---- Bare `/` outside editable surfaces: focus surface search ----
      // Same muscle memory as GitHub / Linear / GitLab — `/` always
      // means "search what I'm looking at". Picks the search affordance
      // that belongs to the current surface:
      //   /projects → focus the page-level project list-search
      //   /docs     → focus the page-level doc list-search
      //   /         → open the QuickSwitcher modal (chat has no inline
      //                search input; the modal IS the search surface)
      if (!inEditable && !meta && !e.altKey && e.key === "/") {
        const path = window.location.pathname;
        let input: HTMLInputElement | null = null;
        if (path.startsWith("/projects")) {
          input = document.querySelector(".projects-search input");
        } else if (path.startsWith("/docs")) {
          input = document.querySelector(".docs-list-search input");
        }
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        } else {
          // Chat (or any route with no inline search) → modal search.
          e.preventDefault();
          store.setQuickOpen(true);
        }
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
