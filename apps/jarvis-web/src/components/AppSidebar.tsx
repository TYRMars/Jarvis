// Left rail: topbar (toggle + open quick search), mode row,
// nav-list (New session + Routines/Customize stubs), conversation
// list, sidebar footer with the account chip + connection status.
//
// Mode-row / Routines+Customize are still UI placeholders (no real
// action yet) — kept so the visual frame matches the design while we
// land the rest of the app, not because they do anything.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../store/appStore";
import { ConnectionStatus } from "./ConnectionStatus";
import { ConvoList } from "./Sidebar/ConvoList";
import { NewConvoButton } from "./Sidebar/NewConvoButton";
import { AccountMenu } from "./Settings/AccountMenu";
import {
  NavLink,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { t } from "../utils/i18n";
import { chipColor } from "../utils/chipColor";

/// Translate the i18n key when present, fall back to the supplied
/// literal otherwise. Used for sidebar entries whose i18n keys
/// haven't been seeded into every locale yet.
function translateOrFallback(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}
import {
  setDocScope,
  useDocScope,
  sameScope,
  type DocScope,
} from "../services/docScope";
import {
  createDocProject,
  listDocProjects,
  subscribeDocs,
} from "../services/docs";
import { applyDocFilter } from "./Docs/useDocFilter";
import { updateProject } from "../services/projects";

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
        <NavLink to="/projects/overview" className={({ isActive }) => "mode-tab" + (isActive ? " active" : "")}>
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
  // `/diagnostics` is operationally part of Work — it surfaces
  // RequirementRun forensics + worktree cleanup, not chat or docs.
  // Without this, the sidebar would flip to chat-mode after a user
  // clicks the 诊断 nav link, hiding the link they just used.
  if (pathname.startsWith("/projects") || pathname.startsWith("/diagnostics")) {
    return "work";
  }
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
        <NavLink
          to="/conversations"
          className={({ isActive }) =>
            "nav-item" + (isActive ? " active" : "")
          }
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <path d="M9 21V9" />
          </svg>
          <span>{t("sidebarNavConversationsArchive")}</span>
        </NavLink>
        <NavLink
          to="/customize"
          className={({ isActive }) =>
            "nav-item" + (isActive ? " active" : "")
          }
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v3" />
            <path d="M12 18v3" />
            <path d="M5.6 5.6l2.1 2.1" />
            <path d="M16.3 16.3l2.1 2.1" />
            <path d="M3 12h3" />
            <path d="M18 12h3" />
            <path d="M5.6 18.4l2.1-2.1" />
            <path d="M16.3 7.7l2.1-2.1" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>{translateOrFallback("sidebarNavCustomize", "能力市场")}</span>
        </NavLink>
      </nav>
      <ConvoList />
    </>
  );
}

function WorkSidebarBody() {
  const projects = useAppStore((s) => s.projects).filter((p) => !p.archived);
  const [pendingAuto, setPendingAuto] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();

  const openNewProject = () => {
    void navigate("/projects/list");
    window.setTimeout(() => {
      window.dispatchEvent(new Event("jarvis:new-project"));
    }, 0);
  };

  const openProject = (id: string) => {
    // Direct URL nav — `/projects/:projectId` is a real route now, so
    // browser back, bookmarks, and reload all preserve the selection.
    // No window event roundtrip needed.
    void navigate(`/projects/${id}`);
  };

  const toggleProjectAuto = async (project: (typeof projects)[number]) => {
    if (pendingAuto[project.id]) return;
    const enabled = project.automation?.auto_mode_enabled ?? true;
    setPendingAuto((prev) => ({ ...prev, [project.id]: true }));
    try {
      await updateProject(project.id, {
        automation: {
          ...(project.automation ?? {}),
          auto_mode_enabled: !enabled,
        },
      });
    } finally {
      setPendingAuto((prev) => ({ ...prev, [project.id]: false }));
    }
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
        <NavLink
          to="/projects/overview"
          className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
          </svg>
          <span>{t("sidebarNavWorkOverview")}</span>
        </NavLink>
        <NavLink
          to="/projects/list"
          className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 6h13" />
            <path d="M8 12h13" />
            <path d="M8 18h13" />
            <path d="M3 6h.01" />
            <path d="M3 12h.01" />
            <path d="M3 18h.01" />
          </svg>
          <span>{t("sidebarNavProjectList")}</span>
        </NavLink>
      </nav>

      <div className="sidebar-section mode-sidebar-section">
        <div className="section-label">{t("projectsTitle")}</div>
        {projects.length === 0 ? (
          <p className="mode-sidebar-empty">{t("sidebarNoProjects")}</p>
        ) : (
          <ul className="mode-sidebar-list">
            {projects.map((p) => (
              <li key={p.id} className="mode-sidebar-project-item">
                <button type="button" className="mode-sidebar-row" onClick={() => openProject(p.id)}>
                  <span className="project-dot" style={{ background: chipColor(p.slug) }} aria-hidden="true" />
                  <span>{p.name}</span>
                </button>
                <button
                  type="button"
                  className={
                    "project-auto-switch mode-sidebar-auto-switch" +
                    ((p.automation?.auto_mode_enabled ?? true) ? " is-on" : "") +
                    (pendingAuto[p.id] ? " is-pending" : "")
                  }
                  onClick={() => void toggleProjectAuto(p)}
                  disabled={!!pendingAuto[p.id]}
                  aria-pressed={p.automation?.auto_mode_enabled ?? true}
                  aria-label={`${p.name} ${(p.automation?.auto_mode_enabled ?? true) ? t("projectAutoOn") : t("projectAutoOff")}`}
                  title={
                    (p.automation?.auto_mode_enabled ?? true)
                      ? t("projectAutoOnHint")
                      : t("projectAutoOffHint")
                  }
                >
                  <span className="project-auto-switch-track" aria-hidden="true">
                    <span className="project-auto-switch-knob" />
                  </span>
                  <span className="sr-only">
                    {(p.automation?.auto_mode_enabled ?? true)
                      ? t("projectAutoOn")
                      : t("projectAutoOff")}
                  </span>
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
  const location = useLocation();
  const params = useParams<{ id?: string }>();
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const scope = useDocScope();
  const [query, setQuery] = useState("");

  // Subscribe to the docs cache so counts stay live as docs are
  // created / deleted / pinned / archived from anywhere.
  const cacheVersion = useSyncExternalStore(
    (cb) => subscribeDocs(cb),
    () => docsVersionTick(),
    () => 0,
  );
  const projects = useMemo(
    () => listDocProjects(socketWorkspace ?? ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [socketWorkspace, cacheVersion],
  );
  const counts = useMemo(() => computeCounts(projects), [projects]);
  const tagsSorted = useMemo(
    () => Array.from(counts.tags.entries()).sort((a, b) => b[1] - a[1]),
    [counts.tags],
  );

  // The list inside the sidebar mirrors the same scope+search rules
  // the page used to apply in its standalone list column.
  const filtered = useMemo(
    () =>
      applyDocFilter({
        projects,
        filter: { scope, sort: "updated", query },
      }),
    [projects, scope, query],
  );

  const onScope = (next: DocScope) => {
    setDocScope(next);
    if (!location.pathname.startsWith("/docs")) {
      void navigate("/docs");
    }
  };

  const openNew = async () => {
    // Mint a fresh doc immediately and navigate to it. No inline
    // form anymore — the editor's title input doubles as the
    // rename-on-create surface.
    const project = await createDocProject({
      title: t("docsCreateUntitled") || "Untitled",
      kind: "note",
      ...(socketWorkspace ? { workspace: socketWorkspace } : {}),
    });
    if (project) {
      void navigate(`/docs/${project.id}`);
    } else {
      // Backend offline: fall back to the docs root so the page
      // shows its empty state instead of leaving the user stuck on
      // the previous route.
      void navigate("/docs");
    }
  };

  return (
    <>
      <nav className="nav-list" aria-label={t("sidebarModeDoc")}>
        <button
          type="button"
          className="nav-item"
          onClick={() => void openNew()}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          <span>{t("sidebarNewPage")}</span>
        </button>
      </nav>

      <div className="sidebar-section mode-sidebar-section docs-rail-section">
        <DocScopeRow
          label={t("docsScopeAll") || "All docs"}
          count={counts.all}
          active={sameScope(scope, { type: "all" })}
          onClick={() => onScope({ type: "all" })}
        />
        <DocScopeRow
          label={t("docsScopePinned") || "Pinned"}
          icon="★"
          count={counts.pinned}
          active={sameScope(scope, { type: "pinned" })}
          onClick={() => onScope({ type: "pinned" })}
        />
      </div>

      <div className="sidebar-section mode-sidebar-section docs-rail-search">
        <label className="docs-rail-search-input">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20.5 20.5-3.7-3.7" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("docsSearchPlaceholder") || "Search…"}
            aria-label={t("docsSearchAria") || "Search docs"}
          />
        </label>
      </div>

      <div className="sidebar-section mode-sidebar-section docs-rail-list">
        {filtered.length === 0 ? (
          <p className="mode-sidebar-empty">
            {query
              ? t("docsListNoMatch") || "No matching docs"
              : t("docsListEmpty") || "No docs yet"}
          </p>
        ) : (
          <ul className="docs-rail-rows">
            {filtered.map(({ project }) => (
              <li key={project.id}>
                <NavLink
                  to={`/docs/${project.id}`}
                  className={({ isActive }) =>
                    "docs-rail-row" +
                    (isActive || params.id === project.id
                      ? " is-active"
                      : "") +
                    (project.archived ? " is-archived" : "")
                  }
                >
                  {project.pinned ? (
                    <span className="docs-rail-row-pin" aria-hidden>
                      ★
                    </span>
                  ) : null}
                  <span className="docs-rail-row-title">
                    {project.title || t("docsUntitled") || "Untitled"}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      {tagsSorted.length > 0 ? (
        <div className="sidebar-section mode-sidebar-section docs-rail-section">
          <div className="section-label">{t("docsScopeTagsHeader") || "Tags"}</div>
          {tagsSorted.slice(0, 24).map(([tag, n]) => (
            <DocScopeRow
              key={tag}
              label={`#${tag}`}
              count={n}
              active={sameScope(scope, { type: "tag", tag })}
              onClick={() => onScope({ type: "tag", tag })}
              monospace
            />
          ))}
        </div>
      ) : null}

      <div className="sidebar-section mode-sidebar-section docs-rail-section">
        <DocScopeRow
          label={t("docsScopeArchive") || "Archive"}
          count={counts.archived}
          active={sameScope(scope, { type: "archived" })}
          onClick={() => onScope({ type: "archived" })}
        />
      </div>
    </>
  );
}

interface DocScopeRowProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: string;
  monospace?: boolean;
}

function DocScopeRow({
  label,
  count,
  active,
  onClick,
  icon,
  monospace,
}: DocScopeRowProps) {
  return (
    <button
      type="button"
      className={"docs-scope-row" + (active ? " is-active" : "")}
      onClick={onClick}
    >
      <span className={"docs-scope-row-label" + (monospace ? " is-mono" : "")}>
        {icon ? <span aria-hidden>{icon}</span> : null}
        <span className="docs-scope-row-text">{label}</span>
      </span>
      <span className="docs-scope-row-count">{count}</span>
    </button>
  );
}

// `useSyncExternalStore` needs a stable "snapshot" that bumps on
// every cache change. We don't surface the actual array — `projects`
// is read separately — but a monotonic counter is enough to trigger
// re-renders.
let _docsTick = 0;
let _docsTickWired = false;
function docsVersionTick(): number {
  if (!_docsTickWired) {
    _docsTickWired = true;
    subscribeDocs(() => {
      _docsTick += 1;
    });
  }
  return _docsTick;
}

interface DocCounts {
  all: number;
  pinned: number;
  archived: number;
  tags: Map<string, number>;
}

function computeCounts(projects: ReturnType<typeof listDocProjects>): DocCounts {
  const counts: DocCounts = {
    all: 0,
    pinned: 0,
    archived: 0,
    tags: new Map(),
  };
  for (const p of projects) {
    if (p.archived) {
      counts.archived += 1;
      continue;
    }
    counts.all += 1;
    if (p.pinned) counts.pinned += 1;
    for (const tag of p.tags ?? []) {
      counts.tags.set(tag, (counts.tags.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

// Suppress unused-import warnings for hooks the docs body owns but
// React only invokes in `doc` mode.
void useEffect;
