// Sidebar conversation rail. The rail mirrors Codex's two-section
// shape: project-bound conversations and free conversations are peers,
// each with the same organize menu.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { convoGroupLabel } from "../../utils/time";
import type { ConvoListRow, Project } from "../../types/frames";
import { newConversation, resumeConversation } from "../../services/conversations";
import { EmptyState } from "../shared/EmptyState";
import { ConvoRow } from "./ConvoRow";
import type { ConversationRunStatus, ConversationSurfaceSnapshot } from "../../store/types";
import type {
  ConvoAutoFilter,
  ConvoLayoutMode,
  ConvoSortBy,
  ConvoVisibility,
} from "../../store/persistence";

const PROJECT_GROUP_LIMIT = 5;
const CONVERSATION_GROUP_LIMIT = 5;

type SectionKind = "projects" | "conversations";

export function ConvoList() {
  const rows = useAppStore((s) => s.convoRows);
  const pinned = useAppStore((s) => s.pinned);
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const activeId = useAppStore((s) => s.activeId);
  const quickOpen = useAppStore((s) => s.quickOpen);
  const conversationRuns = useAppStore((s) => s.conversationRuns);
  const conversationSurfaces = useAppStore((s) => s.conversationSurfaces);
  const convoAutoFilter = useAppStore((s) => s.convoAutoFilter);
  const projects = useAppStore((s) => s.projects);
  const projectsById = useAppStore((s) => s.projectsById);
  const conversationUnread = useAppStore((s) => s.conversationUnread);
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const layoutMode = useAppStore((s) => s.convoLayoutMode);
  const setLayoutMode = useAppStore((s) => s.setConvoLayoutMode);
  const sortBy = useAppStore((s) => s.convoSortBy);
  const setSortBy = useAppStore((s) => s.setConvoSortBy);
  const visibility = useAppStore((s) => s.convoVisibility);
  const setVisibility = useAppStore((s) => s.setConvoVisibility);
  const sectionOrder = useAppStore((s) => s.convoSectionOrder);
  const setSectionOrder = useAppStore((s) => s.setConvoSectionOrder);
  const navigate = useNavigate();
  const location = useLocation();
  const railRef = useRef<HTMLDivElement | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [conversationsExpanded, setConversationsExpanded] = useState(false);
  const [openMenu, setOpenMenu] = useState<SectionKind | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<SectionKind, boolean>>({
    projects: false,
    conversations: false,
  });

  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const runningEntries = Object.entries(conversationRuns)
    .filter(([, runtime]) => isRunActive(runtime.status))
    .sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0));
  const runningRows = runningEntries.map(
    ([id]) => rowsById.get(id) ?? makeFallbackRow(id, conversationSurfaces[id]),
  );
  const allRows = sortRows(uniqueRows([...rows, ...runningRows]), sortBy);
  const pinnedRows = allRows.filter((r) => pinned.has(r.id));
  const recentRows = allRows.filter((r) => !pinned.has(r.id));
  const filteredRows = applyVisibilityFilter(
    filterRows(recentRows, convoAutoFilter),
    visibility,
    {
      activeRow: activeId ? allRows.find((r) => r.id === activeId) ?? null : null,
      activeProjectFilter,
      draftProjectId,
      socketWorkspace,
      draftWorkspacePath,
    },
  );
  const projectRows = filteredRows.filter((r) => !!r.project_id);
  const conversationRows = filteredRows.filter((r) => !r.project_id);
  const projectGroups = buildProjectGroups({
    rows: projectRows,
    projects,
    projectsById,
    activeId,
    expandedGroups,
    layoutMode,
    sortBy,
  });
  const conversationList = makeLimitedList({
    rows: conversationRows,
    activeId,
    expanded: conversationsExpanded,
    limit: CONVERSATION_GROUP_LIMIT,
  });
  const sectionKinds: SectionKind[] =
    sectionOrder === "projectsFirst"
      ? ["projects", "conversations"]
      : ["conversations", "projects"];
  const visibleRows = uniqueRows([
    ...pinnedRows,
    ...sectionKinds.flatMap((kind) =>
      collapsedSections[kind]
        ? []
        : kind === "projects"
        ? layoutMode === "time"
          ? projectRows
          : projectGroups.flatMap((g) => g.visibleRows)
        : conversationList.visibleRows,
    ),
  ]);

  const toggleSection = (kind: SectionKind) => {
    setOpenMenu(null);
    setCollapsedSections((prev) => ({ ...prev, [kind]: !prev[kind] }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      // Router-aware path: under the desktop HashRouter `window.location.pathname`
      // is always "/" (the route lives in the hash), so read react-router's
      // location instead — otherwise the guard never trips and arrow keys hijack
      // conversation-switching on every desktop page (#398).
      if (location.pathname !== "/" && !location.pathname.startsWith("/sessions/")) return;
      if (quickOpen || openMenu) return;
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;
      if (visibleRows.length === 0) return;
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const idx = visibleRows.findIndex((r) => r.id === activeId);
      const nextIdx =
        idx < 0
          ? direction === 1
            ? 0
            : visibleRows.length - 1
          : (idx + direction + visibleRows.length) % visibleRows.length;
      void resumeConversation(visibleRows[nextIdx].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, openMenu, quickOpen, visibleRows, location.pathname]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const status: "" | "disabled" | "empty" = !persistEnabled
    ? "disabled"
    : rows.length === 0 && projects.length === 0
    ? "empty"
    : "";
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const moveSection = () => {
    setSectionOrder(sectionOrder === "projectsFirst" ? "conversationsFirst" : "projectsFirst");
    setOpenMenu(null);
  };
  const openNewConversation = () => {
    const store = useAppStore.getState();
    void navigate("/");
    newConversation({
      projectId: activeProjectFilter ?? store.draftProjectId ?? null,
      workspacePath: store.draftWorkspacePath ?? null,
    });
    window.setTimeout(() => document.getElementById("input")?.focus(), 0);
  };
  const openNewProject = () => {
    void navigate("/projects/list");
    window.setTimeout(() => {
      window.dispatchEvent(new Event("jarvis:new-project"));
    }, 0);
  };

  return (
    <>
      <div
        className={
          "sidebar-section pinned-section" +
          (pinnedRows.length === 0 ? " hidden" : "")
        }
        id="pinned-section"
      >
        <div className="section-label">{t("pinned")}</div>
        <ul id="pinned-list">
          {pinnedRows.map((r) => (
            <ConvoRow
              key={r.id}
              row={r}
              isPinned={true}
              unreadCount={conversationUnread[r.id] ?? 0}
            />
          ))}
        </ul>
      </div>

      <div className="convo-rail-sections" ref={railRef}>
        <ConvoStatus kind={status} />
        {sectionKinds.map((kind, index) =>
          kind === "projects" ? (
            <ProjectsSection
              key="projects"
              index={index}
              open={openMenu === "projects"}
              collapsed={collapsedSections.projects}
              layoutMode={layoutMode}
              sortBy={sortBy}
              visibility={visibility}
              rows={projectRows}
              groups={projectGroups}
              unread={conversationUnread}
              onOpen={() => setOpenMenu(openMenu === "projects" ? null : "projects")}
              onLayout={(mode) => { setLayoutMode(mode); setOpenMenu(null); }}
              onSort={(mode) => { setSortBy(mode); setOpenMenu(null); }}
              onVisibility={(mode) => { setVisibility(mode); setOpenMenu(null); }}
              onMove={moveSection}
              onNew={openNewProject}
              onToggleCollapse={() => toggleSection("projects")}
              onToggleGroup={toggleGroup}
            />
          ) : (
            <ConversationsSection
              key="conversations"
              index={index}
              open={openMenu === "conversations"}
              collapsed={collapsedSections.conversations}
              layoutMode={layoutMode}
              sortBy={sortBy}
              visibility={visibility}
              list={conversationList}
              unread={conversationUnread}
              onOpen={() => setOpenMenu(openMenu === "conversations" ? null : "conversations")}
              onLayout={(mode) => { setLayoutMode(mode); setOpenMenu(null); }}
              onSort={(mode) => { setSortBy(mode); setOpenMenu(null); }}
              onVisibility={(mode) => { setVisibility(mode); setOpenMenu(null); }}
              onMove={moveSection}
              onNew={openNewConversation}
              onToggleCollapse={() => toggleSection("conversations")}
              onToggle={() => setConversationsExpanded((v) => !v)}
            />
          ),
        )}
      </div>
    </>
  );
}

function ProjectsSection({
  index,
  open,
  collapsed,
  layoutMode,
  sortBy,
  visibility,
  rows,
  groups,
  unread,
  onOpen,
  onLayout,
  onSort,
  onVisibility,
  onMove,
  onNew,
  onToggleCollapse,
  onToggleGroup,
}: {
  index: number;
  open: boolean;
  collapsed: boolean;
  layoutMode: ConvoLayoutMode;
  sortBy: ConvoSortBy;
  visibility: ConvoVisibility;
  rows: ConvoListRow[];
  groups: ProjectConvoGroup[];
  unread: Record<string, number>;
  onOpen: () => void;
  onLayout: (mode: ConvoLayoutMode) => void;
  onSort: (mode: ConvoSortBy) => void;
  onVisibility: (mode: ConvoVisibility) => void;
  onMove: () => void;
  onNew: () => void;
  onToggleCollapse: () => void;
  onToggleGroup: (key: string) => void;
}) {
  return (
    <div className={"sidebar-section recents-section convo-section convo-section-projects" + (collapsed ? " collapsed" : "")}>
      <ConvoSectionHeader
        title={t("projectSectionTitle")}
        section="projects"
        index={index}
        open={open}
        collapsed={collapsed}
        layoutMode={layoutMode}
        sortBy={sortBy}
        visibility={visibility}
        onOpen={onOpen}
        onLayout={onLayout}
        onSort={onSort}
        onVisibility={onVisibility}
        onMove={onMove}
        onNew={onNew}
        onToggleCollapse={onToggleCollapse}
      />
      {!collapsed && (
        <ul id="project-convo-list" className="convo-section-list">
          {layoutMode === "time"
            ? renderGroupedByDate(rows).map((entry) =>
                entry.kind === "group" ? (
                  <li
                    key={`project-date:${entry.label}`}
                    className="convo-group-label is-date"
                    role="presentation"
                  >
                    <span>{entry.label}</span>
                  </li>
                ) : (
                  <ConvoRow
                    key={entry.row.id}
                    row={entry.row}
                    isPinned={false}
                    unreadCount={unread[entry.row.id] ?? 0}
                  />
                ),
              )
            : groups.map((group) => (
                <ProjectConversationGroup
                  key={group.key}
                  group={group}
                  unread={unread}
                  onToggle={() => onToggleGroup(group.key)}
                />
              ))}
        </ul>
      )}
    </div>
  );
}

function ConversationsSection({
  index,
  open,
  collapsed,
  layoutMode,
  sortBy,
  visibility,
  list,
  unread,
  onOpen,
  onLayout,
  onSort,
  onVisibility,
  onMove,
  onNew,
  onToggleCollapse,
  onToggle,
}: {
  index: number;
  open: boolean;
  collapsed: boolean;
  layoutMode: ConvoLayoutMode;
  sortBy: ConvoSortBy;
  visibility: ConvoVisibility;
  list: LimitedList;
  unread: Record<string, number>;
  onOpen: () => void;
  onLayout: (mode: ConvoLayoutMode) => void;
  onSort: (mode: ConvoSortBy) => void;
  onVisibility: (mode: ConvoVisibility) => void;
  onMove: () => void;
  onNew: () => void;
  onToggleCollapse: () => void;
  onToggle: () => void;
}) {
  return (
    <div className={"sidebar-section recents-section convo-section convo-section-conversations" + (collapsed ? " collapsed" : "")}>
      <ConvoSectionHeader
        title={t("conversationsGroupFree")}
        section="conversations"
        index={index}
        open={open}
        collapsed={collapsed}
        layoutMode={layoutMode}
        sortBy={sortBy}
        visibility={visibility}
        onOpen={onOpen}
        onLayout={onLayout}
        onSort={onSort}
        onVisibility={onVisibility}
        onMove={onMove}
        onNew={onNew}
        onToggleCollapse={onToggleCollapse}
      />
      {!collapsed && (
        <ul id="convo-list" className="convo-section-list">
          {list.visibleRows.length === 0 ? (
            <li className="convo-group-empty">{t("groupEmpty")}</li>
          ) : (
            list.visibleRows.map((row) => (
              <ConvoRow
                key={row.id}
                row={row}
                isPinned={false}
                unreadCount={unread[row.id] ?? 0}
              />
            ))
          )}
        </ul>
      )}
      {!collapsed && list.canExpand && (
        <button type="button" className="convo-group-expand" onClick={onToggle}>
          {list.isExpanded ? t("groupCollapse") : t("groupExpand")}
        </button>
      )}
    </div>
  );
}

function ConvoSectionHeader({
  title,
  section,
  index,
  open,
  collapsed,
  layoutMode,
  sortBy,
  visibility,
  onOpen,
  onLayout,
  onSort,
  onVisibility,
  onMove,
  onNew,
  onToggleCollapse,
}: {
  title: string;
  section: SectionKind;
  index: number;
  open: boolean;
  collapsed: boolean;
  layoutMode: ConvoLayoutMode;
  sortBy: ConvoSortBy;
  visibility: ConvoVisibility;
  onOpen: () => void;
  onLayout: (mode: ConvoLayoutMode) => void;
  onSort: (mode: ConvoSortBy) => void;
  onVisibility: (mode: ConvoVisibility) => void;
  onMove: () => void;
  onNew: () => void;
  onToggleCollapse: () => void;
}) {
  const menuId = `convo-organize-menu-${section}`;
  const moveLabel = index === 0 ? t("moveDown") : t("moveUp");
  return (
    <div className="convo-section-header">
      <button
        type="button"
        className="convo-section-title"
        aria-expanded={!collapsed}
        onClick={onToggleCollapse}
      >
        <span>{title}</span>
        <ChevronIcon collapsed={collapsed} />
      </button>
      <div className="convo-section-actions">
        <button
          type="button"
          className={"convo-section-icon" + (open ? " active" : "")}
          aria-label={t("organize")}
          title={t("organize")}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={onOpen}
        >
          <SortIcon />
        </button>
        <button
          type="button"
          className="convo-section-icon"
          aria-label={section === "projects" ? t("newProject") : t("newConversation")}
          title={section === "projects" ? t("newProject") : t("newConversation")}
          onClick={onNew}
        >
          {section === "projects" ? <FolderPlusIcon /> : <ComposeIcon />}
        </button>
      </div>
      {open && (
        <ConvoOrganizeMenu
          id={menuId}
          align={index === 0 ? "down" : "up"}
          layoutMode={layoutMode}
          sortBy={sortBy}
          visibility={visibility}
          moveLabel={moveLabel}
          onLayout={onLayout}
          onSort={onSort}
          onVisibility={onVisibility}
          onMove={onMove}
        />
      )}
    </div>
  );
}

function ConvoOrganizeMenu({
  id,
  align,
  layoutMode,
  sortBy,
  visibility,
  moveLabel,
  onLayout,
  onSort,
  onVisibility,
  onMove,
}: {
  id: string;
  align: "up" | "down";
  layoutMode: ConvoLayoutMode;
  sortBy: ConvoSortBy;
  visibility: ConvoVisibility;
  moveLabel: string;
  onLayout: (mode: ConvoLayoutMode) => void;
  onSort: (mode: ConvoSortBy) => void;
  onVisibility: (mode: ConvoVisibility) => void;
  onMove: () => void;
}) {
  return (
    <div id={id} className={`convo-organize-menu align-${align}`} role="menu">
      <div className="convo-menu-heading">{t("organize")}</div>
      <ConvoMenuRadio
        icon={<FolderIcon />}
        label={t("layoutByProject")}
        active={layoutMode === "project"}
        onClick={() => onLayout("project")}
      />
      <ConvoMenuRadio
        icon={<FolderIcon />}
        label={t("layoutRecentProjects")}
        active={layoutMode === "recentProjects"}
        onClick={() => onLayout("recentProjects")}
      />
      <ConvoMenuRadio
        icon={<ClockIcon />}
        label={t("layoutByTime")}
        active={layoutMode === "time"}
        onClick={() => onLayout("time")}
      />
      <button type="button" className="convo-menu-item" role="menuitem" onClick={onMove}>
        <MoveIcon direction={moveLabel === t("moveUp") ? "up" : "down"} />
        <span>{moveLabel}</span>
        <span className="convo-menu-check" aria-hidden="true" />
      </button>
      <div className="convo-menu-divider" />
      <div className="convo-menu-heading">{t("sortCriteria")}</div>
      <ConvoMenuRadio
        icon={<CreatedIcon />}
        label={t("sortCreated")}
        active={sortBy === "created"}
        onClick={() => onSort("created")}
      />
      <ConvoMenuRadio
        icon={<UpdatedIcon />}
        label={t("sortUpdated")}
        active={sortBy === "updated"}
        onClick={() => onSort("updated")}
      />
      <div className="convo-menu-divider" />
      <div className="convo-menu-heading">{t("display")}</div>
      <ConvoMenuRadio
        icon={<AllConversationsIcon />}
        label={t("displayAllConversations")}
        active={visibility === "all"}
        onClick={() => onVisibility("all")}
      />
      <ConvoMenuRadio
        icon={<StarIcon />}
        label={t("displayRelated")}
        active={visibility === "related"}
        onClick={() => onVisibility("related")}
      />
    </div>
  );
}

function ConvoMenuRadio({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="convo-menu-item"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      <span className="convo-menu-check" aria-hidden="true">
        {active ? "✓" : ""}
      </span>
    </button>
  );
}

function ConvoStatus({ kind }: { kind: "" | "disabled" | "empty" }) {
  if (!kind) return null;
  if (kind === "empty") return null;
  if (kind === "disabled") {
    return (
      <EmptyState
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        }
        title={t("persistenceDisabled")}
      />
    );
  }
  return null;
}

type RenderEntry =
  | { kind: "group"; label: string }
  | { kind: "row"; row: ConvoListRow };

function renderGroupedByDate(rows: ConvoListRow[]): RenderEntry[] {
  const out: RenderEntry[] = [];
  let currentGroup = "";
  for (const row of rows) {
    const group = convoGroupLabel(row);
    if (group !== currentGroup) {
      currentGroup = group;
      out.push({ kind: "group", label: group });
    }
    out.push({ kind: "row", row });
  }
  return out;
}

interface ProjectConvoGroup {
  key: string;
  label: string;
  rows: ConvoListRow[];
  visibleRows: ConvoListRow[];
  isExpanded: boolean;
  canExpand: boolean;
  updatedAt: number;
}

interface LimitedList {
  rows: ConvoListRow[];
  visibleRows: ConvoListRow[];
  isExpanded: boolean;
  canExpand: boolean;
}

function ProjectConversationGroup({
  group,
  unread,
  onToggle,
}: {
  group: ProjectConvoGroup;
  unread: Record<string, number>;
  onToggle: () => void;
}) {
  return (
    <li className="convo-project-group">
      <div className="convo-group-label is-project" role="presentation">
        <FolderIcon />
        <span>{group.label}</span>
      </div>
      {group.visibleRows.length === 0 ? (
        <div className="convo-group-empty">{t("groupEmpty")}</div>
      ) : (
        <ul className="convo-group-rows">
          {group.visibleRows.map((row) => (
            <ConvoRow
              key={row.id}
              row={row}
              isPinned={false}
              unreadCount={unread[row.id] ?? 0}
            />
          ))}
        </ul>
      )}
      {group.canExpand && (
        <button type="button" className="convo-group-expand" onClick={onToggle}>
          {group.isExpanded ? t("groupCollapse") : t("groupExpand")}
        </button>
      )}
    </li>
  );
}

function buildProjectGroups({
  rows,
  projects,
  projectsById,
  activeId,
  expandedGroups,
  layoutMode,
  sortBy,
}: {
  rows: ConvoListRow[];
  projects: Project[];
  projectsById: Record<string, Project>;
  activeId: string | null;
  expandedGroups: Record<string, boolean>;
  layoutMode: ConvoLayoutMode;
  sortBy: ConvoSortBy;
}): ProjectConvoGroup[] {
  const activeProjects = projects.filter((p) => !p.archived);
  const rowsByProject = new Map<string, ConvoListRow[]>();
  for (const row of rows) {
    const pid = row.project_id;
    if (!pid) continue;
    const bucket = rowsByProject.get(pid) ?? [];
    bucket.push(row);
    rowsByProject.set(pid, bucket);
  }

  const knownProjectIds = new Set(activeProjects.map((p) => p.id));
  const groups = [
    ...activeProjects.map((project) =>
      makeProjectGroup({
        key: project.id,
        label: project.name,
        rows: rowsByProject.get(project.id) ?? [],
        projectTime: parseTime(sortBy === "created" ? project.created_at : project.updated_at),
        activeId,
        expandedGroups,
        sortBy,
      }),
    ),
    ...Array.from(rowsByProject.entries())
      .filter(([pid]) => !knownProjectIds.has(pid))
      .map(([pid, projectRows]) =>
        makeProjectGroup({
          key: pid,
          label: projectsById[pid]?.name ?? pid,
          rows: projectRows,
          projectTime: parseTime(
            sortBy === "created"
              ? projectsById[pid]?.created_at
              : projectsById[pid]?.updated_at,
          ),
          activeId,
          expandedGroups,
          sortBy,
        }),
      ),
  ].filter((group) => layoutMode === "project" || group.rows.length > 0);

  return groups.sort((a, b) => {
    if (a.rows.length > 0 && b.rows.length === 0) return -1;
    if (a.rows.length === 0 && b.rows.length > 0) return 1;
    return b.updatedAt - a.updatedAt || a.label.localeCompare(b.label);
  });
}

function makeProjectGroup({
  key,
  label,
  rows,
  projectTime,
  activeId,
  expandedGroups,
  sortBy,
}: {
  key: string;
  label: string;
  rows: ConvoListRow[];
  projectTime: number;
  activeId: string | null;
  expandedGroups: Record<string, boolean>;
  sortBy: ConvoSortBy;
}): ProjectConvoGroup {
  const sortedRows = sortRows(rows, sortBy);
  const activeIndex = activeId ? sortedRows.findIndex((r) => r.id === activeId) : -1;
  const isExpanded =
    !!expandedGroups[key] ||
    (activeIndex >= PROJECT_GROUP_LIMIT && sortedRows.length > PROJECT_GROUP_LIMIT);
  return {
    key,
    label,
    rows: sortedRows,
    visibleRows: isExpanded ? sortedRows : sortedRows.slice(0, PROJECT_GROUP_LIMIT),
    isExpanded,
    canExpand: sortedRows.length > PROJECT_GROUP_LIMIT,
    updatedAt: Math.max(projectTime, ...sortedRows.map((r) => rowTime(r, sortBy))),
  };
}

function makeLimitedList({
  rows,
  activeId,
  expanded,
  limit,
}: {
  rows: ConvoListRow[];
  activeId: string | null;
  expanded: boolean;
  limit: number;
}): LimitedList {
  const activeIndex = activeId ? rows.findIndex((r) => r.id === activeId) : -1;
  const isExpanded = expanded || (activeIndex >= limit && rows.length > limit);
  return {
    rows,
    visibleRows: isExpanded ? rows : rows.slice(0, limit),
    isExpanded,
    canExpand: rows.length > limit,
  };
}

function applyVisibilityFilter(
  rows: ConvoListRow[],
  visibility: ConvoVisibility,
  context: {
    activeRow: ConvoListRow | null;
    activeProjectFilter: string | null;
    draftProjectId: string | null;
    socketWorkspace: string | null;
    draftWorkspacePath: string | null;
  },
): ConvoListRow[] {
  if (visibility === "all") return rows;
  const projectId =
    context.activeRow?.project_id ??
    context.activeProjectFilter ??
    context.draftProjectId ??
    null;
  const workspace =
    context.activeRow?.workspace_path ??
    context.socketWorkspace ??
    context.draftWorkspacePath ??
    null;
  if (!projectId && !workspace) return rows;
  return rows.filter((row) => {
    if (projectId && row.project_id === projectId) return true;
    if (workspace && !row.project_id && row.workspace_path === workspace) return true;
    if (!projectId && workspace && row.workspace_path === workspace) return true;
    return false;
  });
}

function filterRows(rows: ConvoListRow[], mode: ConvoAutoFilter): ConvoListRow[] {
  if (mode === "all") return rows;
  return rows.filter((r) => {
    const isAuto = r.source === "requirement" || !!r.requirement_title;
    return mode === "auto" ? isAuto : !isAuto;
  });
}

function sortRows(rows: ConvoListRow[], sortBy: ConvoSortBy): ConvoListRow[] {
  return rows.slice().sort((a, b) => rowTime(b, sortBy) - rowTime(a, sortBy));
}

function rowTime(row: ConvoListRow, sortBy: ConvoSortBy): number {
  return parseTime(sortBy === "created" ? row.created_at : row.updated_at ?? row.created_at);
}

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function isRunActive(status?: ConversationRunStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_hitl";
}

function makeFallbackRow(
  id: string,
  surface?: ConversationSurfaceSnapshot,
): ConvoListRow {
  const lastUser = [...(surface?.messages ?? [])].reverse().find((m) => m.kind === "user");
  const now = new Date().toISOString();
  return {
    id,
    title: lastUser?.kind === "user" ? lastUser.content.slice(0, 80) : "#" + id.slice(0, 8),
    message_count: surface?.messages?.length ?? 0,
    created_at: now,
    updated_at: now,
  };
}

function uniqueRows(rows: ConvoListRow[]): ConvoListRow[] {
  const seen = new Set<string>();
  const out: ConvoListRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={collapsed ? "collapsed" : ""}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h10" />
      <path d="M4 12h7" />
      <path d="M4 17h4" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11v5" />
      <path d="M9.5 13.5h5" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function MoveIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {direction === "up" ? (
        <>
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </>
      ) : (
        <>
          <path d="M12 5v14" />
          <path d="m19 12-7 7-7-7" />
        </>
      )}
    </svg>
  );
}

function CreatedIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

function UpdatedIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

function AllConversationsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 15a4 4 0 0 1 0-8" />
      <path d="M17 7a4 4 0 0 1 0 8" />
      <path d="M7 15h10" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9Z" />
    </svg>
  );
}
