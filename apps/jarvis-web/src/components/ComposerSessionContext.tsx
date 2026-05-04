// Compact new-session context row above the composer. Project AND
// workspace are bound at session start (the `new` WS frame ships
// both); after the server's `started` echo we treat the session as
// locked and the chips become read-only "info" cards. The escape
// hatch is "New chat" — same flow as Claude Code desktop.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { sendFrame } from "../services/socket";
import { fetchWorkspace, probeWorkspace, shortenPath, type WorkspaceInfo } from "../services/workspace";
import {
  forgetWorkspace,
  listRecentWorkspaces,
  touchWorkspace,
  type RecentWorkspace,
} from "../services/workspaces";
import {
  fetchProjectWorkspaceStatuses,
  isLocalProjectId,
  type ProjectWorkspaceStatus,
} from "../services/projects";
import { newConversation } from "../services/conversations";
import { chipColor } from "../utils/chipColor";
import { t } from "../utils/i18n";

type MenuKind = "workspace" | "project" | "context-add" | null;

interface WorkspaceRow {
  kind: "default" | "recent";
  path: string | null;       // null only for `default`
  name: string;
  hint: string;              // path or "Server startup root"
  recent?: RecentWorkspace;  // present only for `recent`
}

export function ComposerSessionContext() {
  const activeId = useAppStore((s) => s.activeId);
  const projects = useAppStore((s) => s.projects).filter((p) => !p.archived);
  const projectsAvailable = useAppStore((s) => s.projectsAvailable);
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const draftWorkspaceInfo = useAppStore((s) => s.draftWorkspaceInfo);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const socketWorkspaceInfo = useAppStore((s) => s.socketWorkspaceInfo);
  const setDraftProjectId = useAppStore((s) => s.setDraftProjectId);
  const setDraftWorkspace = useAppStore((s) => s.setDraftWorkspace);
  const [baseline, setBaseline] = useState<WorkspaceInfo | null>(null);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Live Git status for the currently-selected project's workspaces.
  // Fetched lazily when the workspace popover opens; null while
  // unsuspended or while no project is selected.
  const [projectWorkspaces, setProjectWorkspaces] =
    useState<ProjectWorkspaceStatus[] | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Once the session has started (the WS handler populates `activeId`
  // from the `started` frame), project + workspace are locked. The
  // chips remain visible and can be opened to inspect the binding,
  // but switching is only possible via "New chat".
  const sessionLocked = !!activeId;

  useEffect(() => {
    void fetchWorkspace().then((state) => {
      if (state.kind === "ready") setBaseline(state.info);
    });
    void listRecentWorkspaces().then(setRecent).catch(() => setRecent([]));
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Reset filter / highlight whenever the workspace popover toggles, and
  // pull focus to the search input so the user can start typing or
  // arrow-key immediately.
  useEffect(() => {
    if (menu === "workspace") {
      setFilter("");
      setHighlight(0);
      // Defer focus to next paint so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [menu]);

  // Fetch live Git status for the currently-bound project when the
  // workspace popover opens. The service caches for 5s, so re-opening
  // the popover quickly doesn't re-shell out to git.
  useEffect(() => {
    if (menu !== "workspace" || sessionLocked) {
      setProjectWorkspaces(null);
      return;
    }
    const projectId = draftProjectId;
    if (!projectId || isLocalProjectId(projectId)) {
      setProjectWorkspaces(null);
      return;
    }
    let cancelled = false;
    void fetchProjectWorkspaceStatuses(projectId).then((rows) => {
      if (!cancelled) setProjectWorkspaces(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [menu, draftProjectId, sessionLocked]);

  const workspaceInfo = draftWorkspaceInfo ?? socketWorkspaceInfo ?? baseline;
  const workspacePath = draftWorkspacePath ?? socketWorkspace ?? baseline?.root ?? null;
  const workspaceName = workspacePath ? lastPathSegment(workspacePath) : "Local";
  const branch = workspaceInfo?.vcs === "git"
    ? workspaceInfo.branch ?? "(detached)"
    : workspaceInfo
      ? "worktree"
      : "checking";
  const project = draftProjectId && !isLocalProjectId(draftProjectId)
    ? projects.find((p) => p.id === draftProjectId)
    : null;

  // Build the list of rows, filter, and decide whether the user's input
  // should also offer a "Open <path>" candidate.
  const allRows: WorkspaceRow[] = useMemo(() => {
    const rows: WorkspaceRow[] = [
      {
        kind: "default",
        path: null,
        name: "Default workspace",
        hint: baseline ? shortenPath(baseline.root) : "Server startup root",
      },
      ...recent.map<WorkspaceRow>((r) => ({
        kind: "recent",
        path: r.path,
        name: r.name,
        hint: shortenPath(r.path),
        recent: r,
      })),
    ];
    return rows;
  }, [baseline, recent]);

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.hint.toLowerCase().includes(q) ||
      (r.path ?? "").toLowerCase().includes(q),
    );
  }, [allRows, filter]);

  const trimmedFilter = filter.trim();
  // Treat input as a literal "open this path" candidate when:
  //   - it looks path-like (absolute or `~/…`)
  //   - and no recent row exactly matches it
  const looksLikePath = trimmedFilter.startsWith("/") || trimmedFilter.startsWith("~/");
  const showOpenRow =
    looksLikePath && !filteredRows.some((r) => r.path === trimmedFilter);

  // The "Project workspaces" group sits at the top of the popover
  // when a non-local project is selected and has at least one
  // workspace. We render the project's own list (so users see paths
  // even before the live status fetch resolves) and overlay
  // branch/dirty info from `projectWorkspaces` when available.
  const projectWorkspaceRows = useMemo(() => {
    if (!project || !project.workspaces?.length) return [];
    const liveByPath = new Map(
      (projectWorkspaces ?? []).map((r) => [r.path, r]),
    );
    const q = filter.trim().toLowerCase();
    return project.workspaces
      .map((w) => {
        const live = liveByPath.get(w.path);
        return {
          path: w.path,
          name: w.name ?? lastPathSegment(w.path),
          status: live ?? null,
        };
      })
      .filter((r) => {
        if (!q) return true;
        return (
          r.name.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q)
        );
      });
  }, [project, projectWorkspaces, filter]);

  // De-duplicate recents that already appear in the project group
  // (path-based) so the same folder doesn't render twice.
  const filteredRowsDeduped = useMemo(() => {
    if (projectWorkspaceRows.length === 0) return filteredRows;
    const projectPaths = new Set(projectWorkspaceRows.map((r) => r.path));
    return filteredRows.filter(
      (r) => r.kind !== "recent" || !projectPaths.has(r.path ?? ""),
    );
  }, [filteredRows, projectWorkspaceRows]);

  type NavRow =
    | { kind: "open"; value: string }
    | { kind: "row"; row: WorkspaceRow }
    | { kind: "project-row"; row: typeof projectWorkspaceRows[number] };

  // Pick rows that the keyboard cursor can land on, in render order.
  const navRows: NavRow[] = useMemo(() => {
    const out: NavRow[] = [];
    if (showOpenRow) out.push({ kind: "open", value: trimmedFilter });
    for (const row of projectWorkspaceRows) out.push({ kind: "project-row", row });
    for (const row of filteredRowsDeduped) out.push({ kind: "row", row });
    return out;
  }, [showOpenRow, trimmedFilter, projectWorkspaceRows, filteredRowsDeduped]);

  // Clamp highlight to navRows bounds whenever the list changes.
  useEffect(() => {
    if (highlight >= navRows.length) setHighlight(Math.max(0, navRows.length - 1));
  }, [navRows.length, highlight]);

  const isActiveRow = (row: WorkspaceRow): boolean => {
    if (row.kind === "default") {
      // The default row is "active" when the session is on the server's
      // default root, i.e. no override AND the baseline path matches the
      // resolved workspacePath (or there's no override and no baseline yet).
      if (!workspacePath) return true;
      return baseline?.root === workspacePath;
    }
    return row.path === workspacePath;
  };

  const pickWorkspace = async (path: string | null) => {
    // Hard-stop once the session is locked. The chip's popover is
    // information-only at that point — switching workspace
    // mid-conversation would silently re-root tools, which is
    // exactly the foot-gun this refactor removes.
    if (sessionLocked) return;
    setBusy(true);
    setError(null);
    try {
      if (!path) {
        setDraftWorkspace?.(null, null);
        setMenu(null);
        return;
      }
      const canonical = await touchWorkspace(path);
      const info = await probeWorkspace(canonical);
      setDraftWorkspace?.(canonical, info);
      setRecent((rows) => promoteRecent(rows, canonical));
      setMenu(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    e.preventDefault();
    // Optimistic: drop locally first; if server fails, restore.
    const prev = recent;
    setRecent((rows) => rows.filter((r) => r.path !== path));
    try {
      await forgetWorkspace(path);
    } catch (err) {
      setRecent(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(navRows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = navRows[highlight];
      if (!target) return;
      if (target.kind === "open") {
        void pickWorkspace(target.value);
      } else if (target.kind === "project-row") {
        void pickWorkspace(target.row.path);
      } else {
        void pickWorkspace(target.row.path);
      }
    }
  };

  const pickProject = (id: string | null) => {
    if (sessionLocked) return;
    setDraftProjectId?.(id);
    setMenu(null);
    // Auto-pick the first workspace of the chosen project, but ONLY
    // when the user hasn't already settled on one — switching
    // projects shouldn't yank a workspace the user explicitly chose.
    if (!id) return;
    const next = projects.find((p) => p.id === id);
    const first = next?.workspaces?.[0]?.path;
    if (
      first &&
      !draftWorkspacePath &&
      !socketWorkspace
    ) {
      void pickWorkspace(first);
    }
  };

  return (
    <div className="session-context" ref={wrapRef}>
      <button
        type="button"
        className="session-chip"
        title={workspacePath ?? "Pick workspace"}
        aria-haspopup="menu"
        aria-expanded={menu === "workspace"}
        onClick={() => setMenu(menu === "workspace" ? null : "workspace")}
      >
        <FolderIcon />
        <span>{workspaceName}</span>
      </button>

      <span className="session-chip session-chip-branch" title={workspaceInfo?.root ?? workspacePath ?? ""}>
        <BranchIcon />
        <span>{branch}</span>
        {workspaceInfo?.vcs === "git" && workspaceInfo.dirty ? (
          <span className="session-dirty-dot" title="dirty worktree" />
        ) : null}
      </span>

      <button
        type="button"
        className="session-chip session-chip-project"
        aria-haspopup="menu"
        aria-expanded={menu === "project"}
        title={project ? project.name : "Project context is optional"}
        onClick={() => setMenu(menu === "project" ? null : "project")}
      >
        {project ? (
          <span className="project-dot" style={{ background: chipColor(project.slug) }} aria-hidden="true" />
        ) : (
          <span className="session-muted-square" aria-hidden="true" />
        )}
        <span>{project ? project.name : "Free chat"}</span>
      </button>

      <button
        type="button"
        className="session-chip session-chip-add"
        aria-label="Add context"
        aria-haspopup="menu"
        aria-expanded={menu === "context-add"}
        title="Add context"
        onClick={() => setMenu(menu === "context-add" ? null : "context-add")}
      >
        <PlusIcon />
      </button>

      {menu === "workspace" && sessionLocked ? (
        <LockedSessionPopover
          kind="workspace"
          workspacePath={workspacePath}
          workspaceInfo={workspaceInfo ?? null}
          project={project ?? null}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {menu === "workspace" && !sessionLocked ? (
        <div className="session-popover session-popover-workspace" role="menu">
          <div className="session-popover-search">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onInputKey}
              placeholder={t("sessionWorkspaceFilterPlaceholder")}
              disabled={busy}
            />
          </div>
          <div className="session-popover-list">
            {navRows.length === 0 ? (
              <div className="session-menu-empty">{t("sessionWorkspaceNoMatches")}</div>
            ) : null}
            {projectWorkspaceRows.length > 0 ? (
              <div
                className="session-popover-section-label"
                title={project?.name}
              >
                {t("sessionWorkspaceProjectGroup")}
              </div>
            ) : null}
            {navRows.map((row, i) => {
              if (row.kind === "open") {
                return (
                  <button
                    key={`__open__${row.value}`}
                    type="button"
                    className="session-menu-row session-menu-row-open"
                    data-highlighted={i === highlight ? "true" : undefined}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void pickWorkspace(row.value)}
                    disabled={busy}
                    title={`Open ${row.value}`}
                  >
                    <PlusIcon />
                    <span>
                      <strong>{t("sessionWorkspaceOpenLiteral", row.value)}</strong>
                      <em>{t("sessionWorkspaceAddAs")}</em>
                    </span>
                  </button>
                );
              }
              if (row.kind === "project-row") {
                const pr = row.row;
                const active = pr.path === workspacePath;
                const status = pr.status;
                const branchLabel =
                  status?.vcs === "git"
                    ? status.branch ?? "(detached)"
                    : status?.vcs === "none"
                      ? t("projectWorkspaceNoVcs")
                      : status?.error
                        ? t("sessionWorkspaceUnreachable")
                        : null;
                // Insert a divider+label right before the first
                // recent/default row, only after the last project row.
                return (
                  <button
                    key={`__pw__${pr.path}`}
                    type="button"
                    className="session-menu-row session-menu-row-project"
                    data-highlighted={i === highlight ? "true" : undefined}
                    data-active={active ? "true" : undefined}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void pickWorkspace(pr.path)}
                    title={pr.path}
                    disabled={busy}
                  >
                    <FolderIcon />
                    <span>
                      <strong>{pr.name}</strong>
                      <em>{shortenPath(pr.path)}</em>
                    </span>
                    <span className="row-status" aria-hidden="true">
                      {branchLabel ? (
                        <span className="row-status-branch">{branchLabel}</span>
                      ) : null}
                      {status?.vcs === "git" && status.dirty ? (
                        <span
                          className="session-dirty-dot"
                          title="dirty worktree"
                        />
                      ) : null}
                      {active ? <CheckIcon /> : null}
                    </span>
                  </button>
                );
              }
              const r = row.row;
              const active = isActiveRow(r);
              const isFirstNonProject =
                projectWorkspaceRows.length > 0 &&
                navRows.findIndex((n) => n.kind === "row") === i;
              return (
                <span
                  key={r.kind === "default" ? "__default__" : r.path!}
                >
                  {isFirstNonProject ? (
                    <div className="session-popover-section-label">
                      {t("sessionWorkspaceOtherGroup")}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="session-menu-row"
                    data-highlighted={i === highlight ? "true" : undefined}
                    data-active={active ? "true" : undefined}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void pickWorkspace(r.path)}
                    title={r.path ?? r.hint}
                    disabled={busy}
                  >
                    <FolderIcon />
                    <span>
                      <strong>{r.name}</strong>
                      <em>{r.hint}</em>
                    </span>
                    <span className="row-actions" aria-hidden="true">
                      {active ? <CheckIcon /> : null}
                      {r.kind === "recent" ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`Remove ${r.name} from recent`}
                          title="Remove from recent"
                          className="row-remove"
                          onClick={(e) => void handleRemove(e, r.path!)}
                        >
                          <CloseIcon />
                        </span>
                      ) : null}
                    </span>
                  </button>
                </span>
              );
            })}
          </div>
          {error ? <div className="session-popover-error">{error}</div> : null}
        </div>
      ) : null}

      {menu === "project" && sessionLocked ? (
        <LockedSessionPopover
          kind="project"
          workspacePath={workspacePath}
          workspaceInfo={workspaceInfo ?? null}
          project={project ?? null}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {menu === "project" && !sessionLocked ? (
        <div className="session-popover session-popover-project" role="menu">
          <button type="button" className="session-menu-row" onClick={() => pickProject(null)}>
            <span className="session-muted-square" aria-hidden="true" />
            <span>
              <strong>{t("sessionProjectFreeChat")}</strong>
              <em>{t("sessionProjectFreeChatHint")}</em>
            </span>
          </button>
          {projectsAvailable && projects.length > 0 ? (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="session-menu-row"
                onClick={() => pickProject(p.id)}
                title={p.description ?? p.name}
              >
                <span className="project-dot" style={{ background: chipColor(p.slug) }} aria-hidden="true" />
                <span>
                  <strong>{p.name}</strong>
                  <em>{p.description || p.slug}</em>
                </span>
                {p.workspaces && p.workspaces.length > 0 ? (
                  <span className="row-status" aria-hidden="true">
                    <span className="row-status-count" title={t("sessionProjectWorkspaceCount", p.workspaces.length)}>
                      {p.workspaces.length}
                    </span>
                  </span>
                ) : null}
              </button>
            ))
          ) : (
            <div className="session-menu-empty">{t("sessionProjectNoProjects")}</div>
          )}
        </div>
      ) : null}

      {menu === "context-add" ? (
        <div className="session-popover session-popover-context-add" role="menu">
          <button
            type="button"
            className="session-menu-row"
            onClick={() => setMenu("workspace")}
          >
            <FolderIcon />
            <span>
              <strong>Switch workspace</strong>
              <em>Pick the folder Jarvis will read and edit</em>
            </span>
          </button>
          <button
            type="button"
            className="session-menu-row"
            onClick={() => setMenu("project")}
          >
            <span className="session-muted-square" aria-hidden="true" />
            <span>
              <strong>Set project</strong>
              <em>Attach project instructions to this session</em>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Read-only "info" popover used after the session has started.
// Both the workspace and project chips render this rather than a
// picker — switching mid-conversation would silently re-root tools,
// so the only way out is "New chat".
function LockedSessionPopover({
  kind,
  workspacePath,
  workspaceInfo,
  project,
  onClose,
}: {
  kind: "workspace" | "project";
  workspacePath: string | null;
  workspaceInfo: WorkspaceInfo | null;
  project: { id: string; slug: string; name: string; description?: string | null } | null;
  onClose: () => void;
}) {
  const onNewChat = () => {
    onClose();
    newConversation();
  };

  const className =
    kind === "workspace"
      ? "session-popover session-popover-locked session-popover-locked-workspace"
      : "session-popover session-popover-locked session-popover-locked-project";

  return (
    <div className={className} role="dialog" aria-live="polite">
      <div className="session-locked-summary">
        {kind === "workspace" ? (
          <>
            <FolderIcon />
            <div className="session-locked-text">
              <strong>{workspacePath ? lastPathSegment(workspacePath) : t("sessionLockedNoWorkspace")}</strong>
              <em>{workspacePath ?? t("sessionLockedDefaultRoot")}</em>
              {workspaceInfo?.vcs === "git" ? (
                <span className="session-locked-git">
                  <BranchIcon />
                  <span>{workspaceInfo.branch ?? "(detached)"}</span>
                  {workspaceInfo.dirty ? (
                    <span className="session-dirty-dot" title="dirty worktree" />
                  ) : null}
                  {workspaceInfo.head ? (
                    <code>{workspaceInfo.head}</code>
                  ) : null}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {project ? (
              <span
                className="project-dot"
                style={{ background: chipColor(project.slug) }}
                aria-hidden="true"
              />
            ) : (
              <span className="session-muted-square" aria-hidden="true" />
            )}
            <div className="session-locked-text">
              <strong>{project ? project.name : t("sessionProjectFreeChat")}</strong>
              <em>{project?.description ?? project?.slug ?? t("sessionProjectFreeChatHint")}</em>
            </div>
          </>
        )}
      </div>
      <div className="session-locked-explainer">
        <LockIcon />
        <span>{t("sessionLockedExplain")}</span>
      </div>
      <button
        type="button"
        className="session-locked-newchat"
        onClick={onNewChat}
      >
        {t("sessionLockedNewChat")}
      </button>
    </div>
  );
}

function promoteRecent(rows: RecentWorkspace[], path: string): RecentWorkspace[] {
  const filtered = rows.filter((r) => r.path !== path);
  return [
    {
      path,
      name: lastPathSegment(path),
      last_used_at: new Date().toISOString(),
    },
    ...filtered,
  ];
}

function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
