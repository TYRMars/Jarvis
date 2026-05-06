// Draft-only composer chip row. Replaces `ComposerSessionContext`'s
// project picker + the (draft-time) `MultiGitRail` render with a
// single interactive surface:
//
//   [ project picker ] [ folder · branch ]* [ + add folder ]
//
// • Project picker chip: empty state → click opens project list
//   popover; selected state → dashed border + green dot, ✕ clears.
// • One folder chip per `project.workspaces[]`, each shows folder
//   name + current branch + dirty dot. Clicking opens
//   `<BranchPopover>` to pick a branch and apply it as a worktree
//   (default) or in-place checkout. Successful switches stash the
//   resolved `active_path` into `draftFolderRefs[path]` so the rail
//   shows the user's pending choice immediately.
// • `+` chip: opens `<AddFolderDialog>`, which persists the new
//   folder into `project.workspaces[]` via PUT /v1/projects/:id.
//
// Component renders nothing in mid-session (`activeId != null`); the
// in-session view is owned by the existing `MultiGitRail` /
// `ComposerShoulder` / `ChatHeader` chain (left untouched in this
// redesign). See plan: "Draft / In-session 边界 (本次的硬约束)".

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import {
  fetchProjectWorkspaceStatuses,
  isLocalProjectId,
  type ProjectWorkspaceStatus,
} from "../../services/projects";
import { chipColor } from "../../utils/chipColor";
import { folderNameFromPath, samePath } from "./resourceSelection";
import { BranchPopover } from "./BranchPopover";
import { AddFolderDialog } from "./AddFolderDialog";
import { ProjectCreatePanel } from "../Projects/ProjectList";
import { t } from "../../utils/i18n";
import type { ProjectWorkspace } from "../../types/frames";

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
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
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function ComposerProjectRail() {
  const activeId = useAppStore((s) => s.activeId);
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const projects = useAppStore((s) => s.projects);
  const projectsById = useAppStore((s) => s.projectsById);
  const projectsAvailable = useAppStore((s) => s.projectsAvailable);
  const setDraftProjectId = useAppStore((s) => s.setDraftProjectId);
  const setDraftWorkspace = useAppStore((s) => s.setDraftWorkspace);
  const draftFolderRefs = useAppStore((s) => s.draftFolderRefs);
  const setDraftFolderRef = useAppStore((s) => s.setDraftFolderRef);

  const [statuses, setStatuses] = useState<ProjectWorkspaceStatus[] | null>(
    null,
  );
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [branchPopoverFor, setBranchPopoverFor] = useState<string | null>(null);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  // Drives the shared ProjectCreatePanel opened from "+ 新建项目" in
  // the project picker popover. This is intentionally the same
  // creation flow used by the Projects page.
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);

  // Project + workspaces are derived inside the body so the hook
  // dependency arrays can reference them. Hooks run unconditionally
  // every render — early returns happen *after* every hook below.
  const project = draftProjectId && !isLocalProjectId(draftProjectId)
    ? projectsById[draftProjectId] ?? null
    : null;
  const workspaces: ProjectWorkspace[] = project?.workspaces ?? [];

  // Fetch git status whenever the bound project changes. Service
  // caches for 5s so multiple mounts coalesce. Always-on hook;
  // bails early when there's no project so it's a no-op for the
  // free-chat case.
  useEffect(() => {
    if (!draftProjectId || isLocalProjectId(draftProjectId) || workspaces.length === 0) {
      setStatuses(null);
      return;
    }
    let cancelled = false;
    void fetchProjectWorkspaceStatuses(draftProjectId).then((rows) => {
      if (!cancelled) setStatuses(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [draftProjectId, workspaces.length]);

  // Outside-click + Escape close project menu.
  useEffect(() => {
    if (!projectMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!projectMenuRef.current?.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [projectMenuOpen]);

  // ---- Conditional renders (after all hooks) ----
  // Draft-only. In-session is owned by MultiGitRail / ChatHeader and
  // explicitly out of scope per the user's redesign brief.
  if (activeId) return null;
  if (!projectsAvailable) return null;

  const statusByPath = new Map<string, ProjectWorkspaceStatus>();
  for (const r of statuses ?? []) statusByPath.set(r.path, r);
  const activePath = socketWorkspace ?? draftWorkspacePath;

  const visibleProjects = projects.filter((p) => !p.archived);

  const onPickProject = (id: string) => {
    setDraftProjectId(id);
    setProjectMenuOpen(false);
    // Auto-pin the first workspace as active when the user hasn't
    // already made a workspace choice; mirrors the existing flow in
    // `ComposerSessionContext.pickProject` (line 380).
    const next = projectsById[id];
    const first = next?.workspaces?.[0]?.path;
    if (first && !draftWorkspacePath && !socketWorkspace) {
      setDraftWorkspace(first, null);
    }
  };

  const onClearProject = () => {
    setDraftProjectId(null);
    setBranchPopoverFor(null);
    setAddFolderOpen(false);
  };

  return (
    <div className="composer-project-rail" ref={wrapRef} role="toolbar" aria-label="Project, folders, branches">
      {/* ===== Project picker chip ===== */}
      <div className="composer-project-rail-anchor" ref={projectMenuRef}>
        <button
          type="button"
          className={
            "session-chip composer-project-chip" +
            (project ? " is-selected" : "")
          }
          aria-haspopup="menu"
          aria-expanded={projectMenuOpen}
          title={project ? project.name : t("sessionChipProjectOptional")}
          onClick={() => setProjectMenuOpen((v) => !v)}
        >
          {project ? (
            <span
              className="project-dot"
              style={{ background: chipColor(project.slug) }}
              aria-hidden="true"
            />
          ) : (
            <FolderIcon />
          )}
          <span className="composer-project-chip-name">
            {project ? project.name : t("sessionChipFreeChat")}
          </span>
        </button>
        {project ? (
          <button
            type="button"
            className="composer-project-chip-clear"
            aria-label="Clear project"
            title="Clear project"
            onClick={onClearProject}
          >
            <CloseIcon />
          </button>
        ) : null}

        {projectMenuOpen ? (
          <div className="session-popover composer-project-popover" role="menu">
            {/* No "free chat" row — not picking a project IS free
                chat. Listing it here was redundant and slightly
                misleading; users who clicked it expected something
                more than "the same as not clicking at all". */}
            {visibleProjects.length === 0 ? (
              <div className="session-menu-empty">{t("composerRailNoProjects")}</div>
            ) : null}
            {visibleProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="session-menu-row"
                data-active={p.id === draftProjectId ? "true" : undefined}
                onClick={() => onPickProject(p.id)}
              >
                <span
                  className="project-dot"
                  style={{ background: chipColor(p.slug) }}
                  aria-hidden="true"
                />
                <span>{p.name}</span>
              </button>
            ))}
            {/* Separator + "+ 新建项目" entry. Opens the same shared
                create dialog used by the Projects page so both
                surfaces collect name / description / workspace
                folders consistently. */}
            <div className="composer-project-popover-divider" aria-hidden="true" />
            <button
              type="button"
              className="session-menu-row composer-project-popover-create"
              onClick={() => {
                setProjectMenuOpen(false);
                setNewProjectDialogOpen(true);
              }}
            >
              <PlusIcon />
              <span>{t("composerRailNewProject")}</span>
            </button>
          </div>
        ) : null}
      </div>

      {/* ===== Folder chips (one per project.workspaces) ===== */}
      {workspaces.map((w) => {
        const ref = draftFolderRefs[w.path];
        const status = statusByPath.get(w.path);
        const branchFromStatus =
          status?.vcs === "git"
            ? status.branch ?? "(detached)"
            : status?.vcs === "none"
              ? "—"
              : "…";
        const branchLabel = ref?.branch ?? branchFromStatus;
        const dirty = !ref && status?.vcs === "git" && !!status.dirty;
        const isActive =
          activePath != null && samePath(ref?.active_path ?? w.path, activePath);
        const label = w.name?.trim() || folderNameFromPath(w.path);
        const popoverOpen = branchPopoverFor === w.path;
        return (
          <div key={w.path} className="composer-project-rail-anchor">
            <button
              type="button"
              className={
                "session-chip session-chip-branch composer-folder-chip" +
                (isActive ? " is-active" : " is-inactive")
              }
              title={`${label} — ${w.path}${ref ? ` (${ref.mode})` : ""}`}
              onClick={() => {
                setBranchPopoverFor(popoverOpen ? null : w.path);
                // Picking a folder also activates it as the draft
                // workspace so the user's chip click reads as both
                // "show branches" and "use this folder for next run".
                if (!popoverOpen) {
                  setDraftWorkspace(ref?.active_path ?? w.path, null);
                }
              }}
              disabled={!project}
            >
              <BranchIcon />
              <span className="session-branch-rail-name">{label}</span>
              <span className="session-branch-rail-branch">{branchLabel}</span>
              {ref ? (
                <span
                  className="composer-folder-chip-mode"
                  title={`Branch applied as ${ref.mode}`}
                >
                  {ref.mode === "worktree" ? "wt" : "ck"}
                </span>
              ) : null}
              {dirty ? (
                <span className="session-dirty-dot" title="dirty worktree" />
              ) : null}
            </button>
            {popoverOpen && project ? (
              <BranchPopover
                projectId={project.id}
                workspacePath={w.path}
                currentBranch={branchLabel}
                onClose={() => setBranchPopoverFor(null)}
                onSwitched={(result) => {
                  setDraftFolderRef(w.path, {
                    active_path: result.active_path,
                    branch: result.branch,
                    mode: result.mode,
                  });
                  setDraftWorkspace(result.active_path, null);
                }}
              />
            ) : null}
          </div>
        );
      })}

      {/* ===== "+" add folder chip ===== */}
      {project ? (
        <>
          <button
            type="button"
            className="session-chip session-chip-add composer-add-folder-chip"
            aria-label="Add folder to project"
            title="Add folder to project"
            onClick={() => setAddFolderOpen(true)}
          >
            <PlusIcon />
          </button>
          <AddFolderDialog
            project={project}
            open={addFolderOpen}
            onClose={() => setAddFolderOpen(false)}
            onAdded={(added) => {
              // Make the just-added folder the active workspace so the
              // user can immediately click it to pick a branch.
              setDraftWorkspace(added.path, null);
            }}
          />
        </>
      ) : null}

      {newProjectDialogOpen ? (
        <ProjectCreatePanel
          onDone={(created) => {
            setNewProjectDialogOpen(false);
            if (!created) return;
            setDraftProjectId(created.id);
            setDraftWorkspace(created.workspaces?.[0]?.path ?? null, null);
          }}
        />
      ) : null}
    </div>
  );
}
