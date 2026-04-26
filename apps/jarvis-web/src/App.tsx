// Top-level layout + global effects. Each region (sidebar, chat
// pane, workspace rail, approvals rail, quick switcher) is its own
// component so this file stays focused on the boot/effects/wiring,
// not 200 lines of sidebar SVG.

import { useEffect } from "react";
import { AppSidebar } from "./components/AppSidebar";
import { AppChatPane } from "./components/AppChatPane";
import { AppWorkspaceRail } from "./components/AppWorkspaceRail";
import { AppApprovalsRail } from "./components/AppApprovalsRail";
import { QuickSwitcher } from "./components/QuickSwitcher/QuickSwitcher";
import { useAppStore, appStore } from "./store/appStore";
import { boot, applyI18n } from "./services/boot";
import { useShortcuts } from "./hooks/useShortcuts";
import { showHelpOverlay } from "./services/slash_commands";
import { loadProviders } from "./services/providers";
import { apiUrl } from "./services/api";
import "./styles.css";

export function App() {
  // One-shot boot: persisted prefs into store, copy/resize affordances,
  // providers + convo list fetch, WebSocket open. Idempotent so React
  // Strict Mode's double-mount in dev is safe.
  useEffect(() => {
    boot();
  }, []);

  // Subscribe to `lang` so the whole tree re-renders when the user
  // toggles the language switch. `t()` reads it through the store;
  // the subscription is what makes downstream components re-render.
  const lang = useAppStore((s) => s.lang);
  // Re-translate the static `data-i18n` markers + reload provider
  // names (catalog labels are locale-flavoured) on lang change.
  // First render is handled by `boot()` so we skip it here.
  useEffect(() => {
    if (!appStore.getState().providers.length) return; // not booted yet
    applyI18n();
    void loadProviders(apiUrl);
  }, [lang]);

  // Global keyboard shortcuts (Cmd+K / Cmd+P / Cmd+/, Esc cascade,
  // bare `?`, 1-9 model picker).
  useShortcuts({ showHelp: showHelpOverlay });

  return (
    <div id="app">
      <AppSidebar />
      <AppChatPane />
      <AppWorkspaceRail />
      <AppApprovalsRail />

      <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={-1} />
      <div id="resize-rail" className="resize-handle resize-rail" role="separator" aria-orientation="vertical" aria-label="Resize approvals panel" tabIndex={-1} />

      <QuickSwitcher />
    </div>
  );
}
