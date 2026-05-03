// Compact new-session context row above the composer. Workspace is a
// real binding; Project is intentionally a soft reminder that only
// applies when a brand-new persisted session is created.

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
import { isLocalProjectId } from "../services/projects";
import { chipColor } from "../utils/chipColor";

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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  // Pick rows that the keyboard cursor can land on, in render order.
  const navRows: Array<{ kind: "open"; value: string } | { kind: "row"; row: WorkspaceRow }> =
    useMemo(() => {
      const out: Array<{ kind: "open"; value: string } | { kind: "row"; row: WorkspaceRow }> = [];
      if (showOpenRow) out.push({ kind: "open", value: trimmedFilter });
      for (const row of filteredRows) out.push({ kind: "row", row });
      return out;
    }, [showOpenRow, trimmedFilter, filteredRows]);

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
    setBusy(true);
    setError(null);
    try {
      if (!path) {
        setDraftWorkspace?.(null, null);
        if (activeId) sendFrame({ type: "set_workspace", path: null });
        setMenu(null);
        return;
      }
      const canonical = await touchWorkspace(path);
      const info = await probeWorkspace(canonical);
      setDraftWorkspace?.(canonical, info);
      setRecent((rows) => promoteRecent(rows, canonical));
      if (activeId) sendFrame({ type: "set_workspace", path: canonical });
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
      if (target.kind === "open") void pickWorkspace(target.value);
      else void pickWorkspace(target.row.path);
    }
  };

  const pickProject = (id: string | null) => {
    setDraftProjectId?.(id);
    setMenu(null);
  };

  return (
    <div className="session-context" ref={wrapRef}>
      <button type="button" className="session-chip session-chip-static" title="Local runtime">
        <LaptopIcon />
        <span>Local</span>
      </button>

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

      {menu === "workspace" ? (
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
              placeholder="Filter or type /path/to/project"
              disabled={busy}
            />
          </div>
          <div className="session-popover-list">
            {navRows.length === 0 ? (
              <div className="session-menu-empty">No matches</div>
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
                      <strong>Open <code>{row.value}</code></strong>
                      <em>Add as workspace</em>
                    </span>
                  </button>
                );
              }
              const r = row.row;
              const active = isActiveRow(r);
              return (
                <button
                  key={r.kind === "default" ? "__default__" : r.path!}
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
              );
            })}
          </div>
          {error ? <div className="session-popover-error">{error}</div> : null}
        </div>
      ) : null}

      {menu === "project" ? (
        <div className="session-popover session-popover-project" role="menu">
          <button type="button" className="session-menu-row" onClick={() => pickProject(null)}>
            <span className="session-muted-square" aria-hidden="true" />
            <span>
              <strong>Free chat</strong>
              <em>No project instructions</em>
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
              </button>
            ))
          ) : (
            <div className="session-menu-empty">No projects yet</div>
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

function LaptopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  );
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
