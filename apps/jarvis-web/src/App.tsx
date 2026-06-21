// Top-level layout + global effects. Each region (sidebar, chat
// pane, workspace rail, approvals rail, quick switcher) is its own
// component so this file stays focused on the boot/effects/wiring,
// not 200 lines of sidebar SVG.
//
// Routing: react-router-dom (`BrowserRouter`) wraps the tree so the
// app can host multiple pages at the server root (`/`, `/settings`,
// `/sessions/:id`) without the URL gaining a `/ui/`
// prefix. The server serves `index.html` for any extension-less
// path (see `packages/server/src/ui.ts` spa_fallback), so
// reloading on `/settings` works like a real route, not just a
// hash-based shim.

import { useEffect } from "react";
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { AppChatPane } from "./components/AppChatPane";
import { AppWorkspaceRail } from "./components/AppWorkspaceRail";
import { AppApprovalsRail } from "./components/AppApprovalsRail";
import { QuickSwitcher } from "./components/QuickSwitcher/QuickSwitcher";
import { SettingsPage } from "./components/Settings/SettingsPage";
import { CustomizePage } from "./components/Customize/CustomizePage";
import { ProjectsPage } from "./components/Projects/ProjectsPage";
import { DocsPage } from "./components/Docs/DocsPage";
import { WorkOverviewPage } from "./components/Projects/WorkOverview/WorkOverviewPage";
import { AutoModeDashboardPage } from "./components/AutoMode/AutoModeDashboardPage";
import { WorktreesPage } from "./components/Worktrees/WorktreesPage";
import { SubAgentDemoPage } from "./components/SubAgent/SubAgentDemoPage";
import { OAuthResultPage } from "./components/OAuth/OAuthResultPage";
import { DesktopStartupOverlay } from "./components/Desktop/DesktopStartupOverlay";
import { useAppStore, appStore } from "./store/appStore";
import { boot, applyI18n } from "./services/boot";
import { isDesktopRuntime } from "./services/desktop";
import { useShortcuts } from "./hooks/useShortcuts";
import { showHelpOverlay } from "./services/slash_commands";
import { newConversation, resumeConversation } from "./services/conversations";
import { loadProviders } from "./services/providers";
import { apiUrl } from "./services/api";
import { ConfirmDialogHost } from "./components/ui";
import { t } from "./utils/i18n";
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

  const Router = isDesktopRuntime() ? HashRouter : BrowserRouter;

  return (
    <Router>
      <DesktopStartupOverlay />
      <Routes>
        <Route path="/" element={<ChatLayout newDraftOnMount />} />
        <Route path="/sessions/:id" element={<ChatSessionLayout />} />
        <Route path="/projects/overview" element={<WorkOverviewLayout />} />
        <Route path="/projects/auto-mode" element={<AutoModeDashboardLayout />} />
        <Route path="/projects/worktrees" element={<WorktreesLayout />} />
        <Route path="/projects/list" element={<ProjectsLayout />} />
        {/* `/projects/:projectId` deep-links into a specific project's
            kanban so browser back, bookmarks, and sidebar links all
            survive a reload. `/projects` itself opens the overview by
            default; the list is available at `/projects/list`. */}
        <Route path="/projects/:projectId" element={<ProjectsLayout />} />
        <Route
          path="/projects"
          element={<Navigate to="/projects/overview" replace />}
        />
        <Route path="/docs" element={<DocsLayout />} />
        {/* Per-doc deep link. The sidebar's doc list uses these URLs
            so browser back / refresh / bookmarks all preserve the
            currently-open doc; DocsPage reads `:id` via
            `useParams`. */}
        <Route path="/docs/:id" element={<DocsLayout />} />
        {/* Diagnostics moved into Work Overview. Keep the legacy URL
            as a redirect so old bookmarks / docs links still resolve. */}
        <Route
          path="/diagnostics"
          element={<Navigate to="/projects/overview" replace />}
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/customize" element={<CustomizeLayout />} />
        {/* SubAgent UI preview — static prototype with mocked frame
            data. Reachable directly only; not linked from nav. Will
            be replaced by the real components consuming WS events
            once the subagent backend lands. */}
        <Route path="/demo/subagent" element={<SubAgentDemoPage />} />
        {/* WeCom OAuth2 landing page. Reached by `/v1/channels/:id/oauth/callback`
            after it 302s here with `?userid=&ctx=`. Standalone — no
            sidebar / chrome, since the audience is a freshly opened
            tab from a WeCom client deep link. */}
        <Route path="/oauth/result" element={<OAuthResultPage />} />
        {/* Catch-all: send unknown SPA paths home rather than rendering
            a blank page. Server-side `spa_fallback` already serves
            index.html for these, so this is the client-side mirror. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ConfirmDialogHost />
    </Router>
  );
}

/// The chat workspace — sidebar, chat pane, two rails, resize
/// handles, and the Cmd+P quick switcher. Lives at `/`. Extracted
/// from `App` so other routes (Settings, future Conversations
/// archive) don't carry the chat-specific chrome.
function ChatLayout({ newDraftOnMount = false }: { newDraftOnMount?: boolean }) {
  useEffect(() => {
    if (!newDraftOnMount) return;
    const store = appStore.getState();
    newConversation({
      projectId: store.activeProjectFilter ?? store.draftProjectId ?? null,
      workspacePath: store.draftWorkspacePath ?? null,
    });
    window.setTimeout(() => document.getElementById("input")?.focus(), 0);
  }, [newDraftOnMount]);

  return (
    <>
      <a className="skip-link" href="#chat">{t("chatCoreSkipToContent")}</a>
      <div id="app">
        <AppSidebar />
        <AppChatPane />
        <AppWorkspaceRail />
        <AppApprovalsRail />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeSidebar")} tabIndex={-1} />
        <div id="resize-rail" className="resize-handle resize-rail" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeApprovals")} tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

function ChatSessionLayout() {
  const { id } = useParams<{ id: string }>();
  useEffect(() => {
    if (!id) return;
    void resumeConversation(id);
  }, [id]);
  return <ChatLayout />;
}

function ProjectsLayout() {
  return (
    <>
      <a className="skip-link" href="#projects-page">{t("chatCoreSkipToContent")}</a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <ProjectsPage />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeSidebar")} tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

function DocsLayout() {
  return (
    <>
      <a className="skip-link" href="#docs-page">{t("chatCoreSkipToContent")}</a>
      <div id="app" className="page-app docs-app">
        <AppSidebar />
        <DocsPage />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeSidebar")} tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}

// Customize — unified entry point for Skills / MCP / Plugins.
// Reachable from the chat sidebar under "能力市场". Shares the same
// shell as ProjectsLayout so the global sidebar still anchors the
// page.
function CustomizeLayout() {
  return (
    <>
      <a className="skip-link" href="#customize-page">
        {t("chatCoreSkipToContent")}
      </a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <CustomizePage />

        <div
          id="resize-sidebar"
          className="resize-handle resize-sidebar"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chatCoreResizeSidebar")}
          tabIndex={-1}
        />

        <QuickSwitcher />
      </div>
    </>
  );
}

// Worktree management — sibling to the Auto-mode dashboard under
// Work mode. Lists orphan git worktrees + cleanup.
function WorktreesLayout() {
  return (
    <>
      <a className="skip-link" href="#worktrees-page">
        {t("chatCoreSkipToContent")}
      </a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <WorktreesPage />

        <div
          id="resize-sidebar"
          className="resize-handle resize-sidebar"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chatCoreResizeSidebar")}
          tabIndex={-1}
        />

        <QuickSwitcher />
      </div>
    </>
  );
}

// Auto-mode scheduler dashboard. Sibling to Overview / List under
// the Work-mode sidebar; same shell so the sidebar nav stays put as
// the user moves between Work sub-pages.
function AutoModeDashboardLayout() {
  return (
    <>
      <a className="skip-link" href="#auto-mode-page">{t("chatCoreSkipToContent")}</a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <AutoModeDashboardPage />

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeSidebar")} tabIndex={-1} />

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
      <a className="skip-link" href="#work-overview-page">{t("chatCoreSkipToContent")}</a>
      <div id="app" className="page-app projects-app">
        <AppSidebar />
        <main id="work-overview-page" className="work-overview-page-shell" tabIndex={-1}>
          <WorkOverviewPage />
        </main>

        <div id="resize-sidebar" className="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label={t("chatCoreResizeSidebar")} tabIndex={-1} />

        <QuickSwitcher />
      </div>
    </>
  );
}
