// Compact new-session context row above the composer. Workspace is a
// real binding; Project is intentionally a soft reminder that only
// applies when a brand-new persisted session is created.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { sendFrame } from "../services/socket";
import { fetchWorkspace, probeWorkspace, shortenPath, type WorkspaceInfo } from "../services/workspace";
import {
  listRecentWorkspaces,
  touchWorkspace,
  type RecentWorkspace,
} from "../services/workspaces";
import { isLocalProjectId } from "../services/projects";
import { chipColor } from "../utils/chipColor";

type MenuKind = "workspace" | "project" | null;

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
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
        title="Add context"
        onClick={() => setMenu("workspace")}
      >
        <PlusIcon />
      </button>

      {menu === "workspace" ? (
        <div className="session-popover session-popover-workspace" role="menu">
          <button type="button" className="session-menu-row" onClick={() => void pickWorkspace(null)}>
            <FolderIcon />
            <span>
              <strong>Default workspace</strong>
              <em>{baseline ? shortenPath(baseline.root) : "Server startup root"}</em>
            </span>
          </button>
          {recent.map((r) => (
            <button
              key={r.path}
              type="button"
              className="session-menu-row"
              onClick={() => void pickWorkspace(r.path)}
              title={r.path}
              disabled={busy}
            >
              <FolderIcon />
              <span>
                <strong>{r.name}</strong>
                <em>{shortenPath(r.path)}</em>
              </span>
            </button>
          ))}
          <WorkspacePathForm busy={busy} onPick={pickWorkspace} />
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
    </div>
  );
}

function WorkspacePathForm({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (path: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="session-path-form"
      onSubmit={(e) => {
        e.preventDefault();
        const value = draft.trim();
        if (!value || busy) return;
        void onPick(value).then(() => setDraft(""));
      }}
    >
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Open folder…  /path/to/project"
        disabled={busy}
      />
    </form>
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
