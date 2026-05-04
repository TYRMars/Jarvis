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
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { t } from "../utils/i18n";
import { chipColor } from "../utils/chipColor";
import {
  setDocScope,
  useDocScope,
  sameScope,
  type DocScope,
} from "../services/docScope";
import { listDocProjects, subscribeDocs } from "../services/docs";
import type { DocKind } from "../types/frames";
import { kindLabel, KIND_ORDER, KindIcon } from "./Docs/KindIcon";

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
    // Direct URL nav — `/projects/:projectId` is a real route now, so
    // browser back, bookmarks, and reload all preserve the selection.
    // No window event roundtrip needed.
    void navigate(`/projects/${id}`);
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
          to="/projects"
          end
          className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
            <path d="M3 10h18" />
          </svg>
          <span>{t("sidebarNavProjectList")}</span>
        </NavLink>
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
  const location = useLocation();
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const scope = useDocScope();

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

  const onScope = (next: DocScope) => {
    setDocScope(next);
    if (!location.pathname.startsWith("/docs")) {
      void navigate("/docs");
    }
  };

  const openNew = () => {
    void navigate("/docs");
    window.setTimeout(() => {
      window.dispatchEvent(new Event("jarvis:new-doc"));
    }, 0);
  };

  return (
    <>
      <nav className="nav-list" aria-label={t("sidebarModeDoc")}>
        <button type="button" className="nav-item" onClick={openNew}>
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

      <div className="sidebar-section mode-sidebar-section docs-rail-section">
        <div className="section-label">{t("docsScopeKindHeader") || "Kind"}</div>
        {KIND_ORDER.map((k) => (
          <DocScopeRow
            key={k}
            label={kindLabel(k)}
            count={counts.kinds[k] ?? 0}
            active={sameScope(scope, { type: "kind", kind: k })}
            onClick={() => onScope({ type: "kind", kind: k })}
            kind={k}
          />
        ))}
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
  kind?: DocKind;
  icon?: string;
  monospace?: boolean;
}

function DocScopeRow({
  label,
  count,
  active,
  onClick,
  kind,
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
        {kind ? (
          <span className="docs-scope-row-kind">
            <KindIcon kind={kind} size={13} />
          </span>
        ) : icon ? (
          <span aria-hidden>{icon}</span>
        ) : null}
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
  kinds: Record<DocKind, number>;
  tags: Map<string, number>;
}

function computeCounts(projects: ReturnType<typeof listDocProjects>): DocCounts {
  const counts: DocCounts = {
    all: 0,
    pinned: 0,
    archived: 0,
    kinds: { note: 0, research: 0, report: 0, design: 0, guide: 0 },
    tags: new Map(),
  };
  for (const p of projects) {
    if (p.archived) {
      counts.archived += 1;
      continue;
    }
    counts.all += 1;
    if (p.pinned) counts.pinned += 1;
    counts.kinds[p.kind] = (counts.kinds[p.kind] ?? 0) + 1;
    for (const tag of p.tags ?? []) {
      counts.tags.set(tag, (counts.tags.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

// Suppress unused warnings for hooks pulled in for the docs body but
// not always reached; React only invokes them in `doc` mode.
void useState;
void useEffect;
