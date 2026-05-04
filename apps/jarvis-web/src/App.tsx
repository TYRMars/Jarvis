// Top-level layout + global effects. Each region (sidebar, chat
// pane, workspace rail, approvals rail, quick switcher) is its own
// component so this file stays focused on the boot/effects/wiring,
// not 200 lines of sidebar SVG.
//
// Routing: react-router-dom (`BrowserRouter`) wraps the tree so the
// app can host multiple pages at the server root (`/`, `/settings`,
// future `/conversations/:id`) without the URL gaining a `/ui/`
// prefix. The Rust side serves `index.html` for any extension-less
// path (see `crates/harness-server/src/ui.rs::spa_fallback`), so
// reloading on `/settings` works like a real route, not just a
// hash-based shim.

import { useEffect } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { AppChatPane } from "./components/AppChatPane";
import { AppWorkspaceRail } from "./components/AppWorkspaceRail";
import { AppApprovalsRail } from "./components/AppApprovalsRail";
import { QuickSwitcher } from "./components/QuickSwitcher/QuickSwitcher";
import { SettingsPage } from "./components/Settings/SettingsPage";
import { ProjectsPage } from "./components/Projects/ProjectsPage";
import { DocsPage } from "./components/Docs/DocsPage";
import { WorkOverviewPage } from "./components/Projects/WorkOverview/WorkOverviewPage";
import { SubAgentDemoPage } from "./components/SubAgent/SubAgentDemoPage";
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
  // Strict Mode's double-mount in dev is safe. Boot fires regardless
  // of which route the user lands on — Settings still needs the
  // provider catalog and persisted prefs, and bouncing the WS open
  // when the user navigates from `/settings` back to `/` would be
  // jarring (it'd look like a reconnect).
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
  // bare `?`, 1-9 model picker). Mounted at the App root so the
  // shortcuts fire on every page — Cmd+K on the Settings page still
  // jumps you to a conversation.
  useShortcuts({ showHelp: showHelpOverlay });

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatLayout />} />
        <Route path="/projects/overview" element={<WorkOverviewLayout />} />
        {/* `/projects/:projectId` deep-links into a specific project's
            kanban so browser back, bookmarks, and sidebar links all
            survive a reload. The plain `/projects` URL is the list. */}
        <Route path="/projects/:projectId" element={<ProjectsLayout />} />
        <Route path="/projects" element={<ProjectsLayout />} />
        <Route path="/docs" element={<DocsLayout />} />
        {/* Diagnostics moved into Work Overview. Keep the legacy URL
            as a redirect so old bookmarks / docs links still resolve. */}
        <Route
          path="/diagnostics"
          element={<Navigate to="/projects/overview" replace />}
        />
        <Route path="/settings" element={<SettingsPage />} />
        {/* SubAgent UI preview — static prototype with mocked frame
            data. Reachable directly only; not linked from nav. Will
            be replaced by the real components consuming WS events
            once the subagent backend lands. */}
        <Route path="/demo/subagent" element={<SubAgentDemoPage />} />
        {/* Catch-all: send unknown SPA paths home rather than rendering
            a blank page. Server-side `spa_fallback` already serves
            index.html for these, so this is the client-side mirror. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/// The chat workspace — sidebar, chat pane, two rails, resize
/// handles, and the Cmd+P quick switcher. Lives at `/`. Extracted
/// from `App` so other routes (Settings, future Conversations
/// archive) don't carry the chat-specific chrome.
function ChatLayout() {
  return (
    <>
      <a className="skip-link" href="#chat">Skip to main content</a>
      <div id="app">
        <AppSidebar />
        <AppChatPane />
        <AppWorkspaceRail />
        <AppApprovalsRail />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={-1} />
        <div id="resize-rail" className="resize-handle resize-rail" role="separator" aria-orientation="vertical" aria-label="Resize approvals panel" tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

function ProjectsLayout() {
  return (
    <>
      <a className="skip-link" href="#projects-page">Skip to main content</a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <ProjectsPage />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

function DocsLayout() {
  return (
    <>
      <a className="skip-link" href="#docs-page">Skip to main content</a>
      <div id="app" className="page-app docs-app">
        <AppSidebar />
        <DocsPage />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

// v1.0 — full-page WorkOverview, reachable from the Work-mode
// sidebar's "工作总览" link. Same shell as `ProjectsLayout` (same
// `page-app projects-app` class so the sidebar layout matches);
// the body just renders the existing `WorkOverviewPage` component
// instead of the project list.
function WorkOverviewLayout() {
  return (
    <>
      <a className="skip-link" href="#work-overview-page">Skip to main content</a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <main id="work-overview-page" className="work-overview-page-shell" tabIndex={-1}>
          <WorkOverviewPage />
        </main>

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}
