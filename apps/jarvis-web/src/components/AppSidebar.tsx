// Left rail: topbar (toggle + open quick search), mode row,
// nav-list (New session + Routines/Customize stubs), conversation
// list, sidebar footer with the account chip + connection status.
//
// Mode-row / Routines+Customize are still UI placeholders (no real
// action yet) — kept so the visual frame matches the design while we
// land the rest of the app, not because they do anything.

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
import {
  setDocScope,
  useDocScope,
  sameScope,
  type DocScope,
} from "../services/docScope";
import {
  createDocProject,
  getDocDraft,
  listDocProjects,
  loadDocDraft,
  subscribeDocs,
} from "../services/docs";
import { applyDocFilter } from "./Docs/useDocFilter";
import { updateProject } from "../services/projects";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Icon,
  LayoutDashboard,
  List,
  Clock,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Blocks,
  Star,
} from "./ui";

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
  const goBack = () => window.history.back();
  const goForward = () => window.history.forward();

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
          <Icon icon={PanelLeft} size={17} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ghost-icon sidebar-history-btn"
          title={t("sidebarBack")}
          aria-label={t("sidebarBack")}
          onClick={goBack}
        >
          <Icon icon={ArrowLeft} size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="ghost-icon sidebar-history-btn"
          title={t("sidebarForward")}
          aria-label={t("sidebarForward")}
          onClick={goForward}
        >
          <Icon icon={ArrowRight} size={16} strokeWidth={1.8} />
        </button>
      </div>

      <PrimaryNav onSearch={openQuickSwitcher} />

      <ModeSidebarBody mode={modeForPath(location.pathname)} />

      <div className="sidebar-footer">
        <AccountMenu />
        <ConnectionStatus />
      </div>
    </aside>
  );
}

function PrimaryNav({ onSearch }: { onSearch: () => void }) {
  return (
    <nav className="primary-nav" aria-label={t("sidebarModeAria")}>
      <NewConvoButton />
      <button
        id="open-quick-search"
        type="button"
        className="nav-item primary-nav-item"
        title={t("sidebarSearch")}
        aria-label={t("sidebarSearch")}
        onClick={onSearch}
      >
        <Icon icon={Search} size={17} strokeWidth={1.85} />
        <span>{t("sidebarSearch")}</span>
        <kbd className="nav-shortcut" aria-hidden="true">⌘G</kbd>
      </button>
      <NavLink
        to="/customize"
        className={({ isActive }) =>
          "nav-item primary-nav-item" + (isActive ? " active" : "")
        }
      >
        <Icon icon={Blocks} size={17} strokeWidth={1.85} />
        <span>{t("customizeNavPlugins")}</span>
      </NavLink>
      <NavLink
        to="/projects/auto-mode"
        className={({ isActive }) =>
          "nav-item primary-nav-item" + (isActive ? " active" : "")
        }
      >
        <Icon icon={Clock} size={17} strokeWidth={1.85} />
        <span>{t("projectAutoOn")}</span>
      </NavLink>
      <NavLink
        to="/docs"
        className={({ isActive }) =>
          "nav-item primary-nav-item sidebar-docs-link" + (isActive ? " active" : "")
        }
      >
        <Icon icon={FileText} size={17} strokeWidth={1.85} />
        <span>{t("sidebarModeDoc")}</span>
      </NavLink>
    </nav>
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
          <Icon icon={Plus} size={17} strokeWidth={1.9} />
          <span>{t("projectsNewBtn")}</span>
        </button>
        <NavLink
          to="/projects/overview"
          className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
        >
          <Icon icon={LayoutDashboard} size={17} strokeWidth={1.9} />
          <span>{t("sidebarNavWorkOverview")}</span>
        </NavLink>
        <NavLink
          to="/projects/list"
          className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
        >
          <Icon icon={List} size={17} strokeWidth={1.9} />
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
  const params = useParams<{ id?: string }>();
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const scope = useDocScope();
  const [query, setQuery] = useState("");
  const [draftSearchBodies, setDraftSearchBodies] = useState<
    Map<string, string | null>
  >(() => new Map());

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
  const searchableDrafts = useMemo(() => {
    const next = new Map(draftSearchBodies);
    for (const project of projects) {
      const draft = getDocDraft(project.id);
      if (draft) next.set(project.id, draft.content);
    }
    return next;
  }, [projects, draftSearchBodies]);

  // The list inside the sidebar mirrors the same scope+search rules
  // the page used to apply in its standalone list column.
  const filtered = useMemo(
    () =>
      applyDocFilter({
        projects,
        filter: { scope, sort: "updated", query },
        drafts: searchableDrafts,
      }),
    [projects, scope, query, searchableDrafts],
  );

  const onScope = (next: DocScope) => {
    setDocScope(next);
    const first = applyDocFilter({
      projects,
      filter: { scope: next, sort: "updated", query: "" },
    })[0]?.project;
    void navigate(first ? `/docs/${first.id}` : "/docs");
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const ids = applyDocFilter({
      projects,
      filter: { scope, sort: "updated", query: "" },
    }).map(({ project }) => project.id);
    const missing = ids.filter((id) => !draftSearchBodies.has(id));
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missing.map(async (id) => {
        const draft = (await loadDocDraft(id)) ?? getDocDraft(id);
        return [id, draft?.content ?? null] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDraftSearchBodies((prev) => {
        const next = new Map(prev);
        for (const [id, content] of entries) next.set(id, content);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projects, scope, query, draftSearchBodies]);

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
      setDocScope({ type: "all" });
      setQuery("");
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
          <Icon icon={Plus} size={17} strokeWidth={1.9} />
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
          icon={<Icon icon={Star} size={13} strokeWidth={1.8} />}
          count={counts.pinned}
          active={sameScope(scope, { type: "pinned" })}
          onClick={() => onScope({ type: "pinned" })}
        />
      </div>

      <div className="sidebar-section mode-sidebar-section docs-rail-search">
        <label className="docs-rail-search-input">
          <Icon icon={Search} size={13} strokeWidth={2} />
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
              : emptyDocScopeText(scope)}
          </p>
        ) : (
          <ul className="docs-rail-rows">
            {filtered.map(({ project, snippet }) => (
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
                      <Icon icon={Pin} size={11} fill="currentColor" strokeWidth={1.8} />
                    </span>
                  ) : null}
                  <span className="docs-rail-row-main">
                    <span className="docs-rail-row-title">
                      {project.title || t("docsUntitled") || "Untitled"}
                    </span>
                    {snippet ? (
                      <span
                        className="docs-rail-row-snippet"
                        aria-label={t("docsSnippetAria") || "Search match"}
                      >
                        {snippet}
                      </span>
                    ) : null}
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

function emptyDocScopeText(scope: DocScope): string {
  if (scope.type === "all") return t("docsListEmpty") || "No docs yet";
  return t("docsListEmptyTitle", docScopeLabel(scope));
}

function docScopeLabel(scope: DocScope): string {
  switch (scope.type) {
    case "all":
      return t("docsScopeAll") || "All docs";
    case "pinned":
      return t("docsScopePinned") || "Pinned";
    case "archived":
      return t("docsScopeArchive") || "Archive";
    case "tag":
      return `#${scope.tag}`;
  }
}

interface DocScopeRowProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
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
