// Left rail: topbar (toggle + open quick search), mode row,
// nav-list (New session + Routines/Customize stubs), conversation
// list, sidebar footer with the account chip + connection status.
//
// Mode-row / Routines+Customize are still UI placeholders (no real
// action yet) — kept so the visual frame matches the design while we
// land the rest of the app, not because they do anything.

import { useAppStore } from "../store/appStore";
import { ConnectionStatus } from "./ConnectionStatus";
import { ConvoList } from "./Sidebar/ConvoList";
import { NewConvoButton } from "./Sidebar/NewConvoButton";
import { AccountMenu } from "./Settings/AccountMenu";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { t } from "../utils/i18n";
import { chipColor } from "../utils/chipColor";

export function AppSidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setQuickOpen = useAppStore((s) => s.setQuickOpen);
  const location = useLocation();
  // The topbar magnifier button opens the QuickSwitcher modal —
  // unified surface for "find a chat" (title match) plus deep
  // full-text search across message bodies. The inline sidebar
  // input keeps doing instant title-prefix filtering on the visible
  // list; both exist so quick at-a-glance narrowing doesn't have to
  // pop a modal.
  const openQuickSwitcher = () => setQuickOpen(true);

  return (
    <aside id="sidebar" aria-label={t("sidebarAriaConversations")}>
      <div className="sidebar-topbar">
        <button
          id="toggle-sidebar"
          type="button"
          className="ghost-icon"
          title={t("sidebarToggle")}
          aria-label={t("sidebarToggle")}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M9 5v14" />
          </svg>
        </button>
        <button
          id="open-quick-search"
          type="button"
          className="ghost-icon"
          title={t("sidebarSearch")}
          aria-label={t("sidebarSearch")}
          onClick={openQuickSwitcher}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
      </div>

      <div className="mode-row" role="tablist" aria-label={t("sidebarModeAria")}>
        <NavLink to="/" end className={({ isActive }) => "mode-tab" + (isActive ? " active" : "")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7" />
            <path d="M17 8h.01" />
            <path d="M21 8h.01" />
          </svg>
          <span>{t("sidebarModeChat")}</span>
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => "mode-tab" + (isActive ? " active" : "")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m16 18 6-6-6-6" />
            <path d="m8 6-6 6 6 6" />
          </svg>
          <span>{t("sidebarModeWork")}</span>
        </NavLink>
        <NavLink to="/docs" className={({ isActive }) => "mode-tab" + (isActive ? " active" : "")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" />
            <path d="M14 3v4h4" />
            <path d="M9 12h6" />
            <path d="M9 16h6" />
          </svg>
          <span>{t("sidebarModeDoc")}</span>
        </NavLink>
      </div>

      <ModeSidebarBody mode={modeForPath(location.pathname)} />

      <div className="sidebar-footer">
        <AccountMenu />
        <ConnectionStatus />
      </div>
    </aside>
  );
}

function modeForPath(pathname: string): "chat" | "work" | "doc" {
  if (pathname.startsWith("/docs")) return "doc";
  if (pathname.startsWith("/projects")) return "work";
  return "chat";
}

function ModeSidebarBody({ mode }: { mode: "chat" | "work" | "doc" }) {
  if (mode === "work") return <WorkSidebarBody />;
  if (mode === "doc") return <DocSidebarBody />;
  return <ChatSidebarBody />;
}

function ChatSidebarBody() {
  return (
    <>
      <nav className="nav-list" aria-label={t("sidebarModeChat")}>
        <NewConvoButton />
      </nav>
      <ConvoList />
    </>
  );
}

function WorkSidebarBody() {
  const projects = useAppStore((s) => s.projects).filter((p) => !p.archived);
  const navigate = useNavigate();

  const openNewProject = () => {
    void navigate("/projects");
    window.setTimeout(() => {
      window.dispatchEvent(new Event("jarvis:new-project"));
    }, 0);
  };

  const openProject = (id: string) => {
    void navigate("/projects");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("jarvis:open-project", { detail: id }));
    }, 0);
  };

  return (
    <>
      <nav className="nav-list" aria-label={t("sidebarModeWork")}>
        <button type="button" className="nav-item" onClick={openNewProject}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span>{t("projectsNewBtn")}</span>
        </button>
        <NavLink to="/projects" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
            <path d="M3 10h18" />
          </svg>
          <span>{t("settingsNavProjects")}</span>
        </NavLink>
      </nav>

      <div className="sidebar-section mode-sidebar-section">
        <div className="section-label">{t("projectsTitle")}</div>
        {projects.length === 0 ? (
          <p className="mode-sidebar-empty">{t("sidebarNoProjects")}</p>
        ) : (
          <ul className="mode-sidebar-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className="mode-sidebar-row" onClick={() => openProject(p.id)}>
                  <span className="project-dot" style={{ background: chipColor(p.slug) }} aria-hidden="true" />
                  <span>{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DocSidebarBody() {
  const navigate = useNavigate();
  const openNewPage = () => {
    void navigate("/docs");
    window.setTimeout(() => {
      window.dispatchEvent(new Event("jarvis:new-doc-page"));
    }, 0);
  };

  return (
    <>
      <nav className="nav-list" aria-label={t("sidebarModeDoc")}>
        <button type="button" className="nav-item" onClick={openNewPage}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span>{t("sidebarNewPage")}</span>
        </button>
        <NavLink to="/docs" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3h9l3 3v15H6z" />
            <path d="M14 3v4h4" />
            <path d="M9 12h6" />
            <path d="M9 16h6" />
          </svg>
          <span>{t("sidebarLlmWiki")}</span>
        </NavLink>
      </nav>

      <div className="sidebar-section mode-sidebar-section">
        <div className="section-label">{t("sidebarPages")}</div>
        <p className="mode-sidebar-empty">{t("sidebarNoWikiPages")}</p>
      </div>
    </>
  );
}
