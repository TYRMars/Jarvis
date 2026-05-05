// Multi-workspace git status row, shown above the composer input
// when the bound project has 2+ workspace folders. Renders one chip
// per workspace with the active workspace highlighted; inactive
// workspaces are visible but visually muted so the active one reads
// first.
//
// Used in two places:
//   1. ComposerSessionContext (new-session chip row): replaces the
//      single-branch chip when applicable.
//   2. AppChatPane / ComposerShoulder area (in-session): renders as
//      its own row directly above `.input-wrapper` so the user can
//      see all of their bound workspaces' git status throughout the
//      conversation, not just on the new-session screen.
//
// The component owns its own data fetch (per-render `useEffect` keyed
// off `draftProjectId`) so callers don't have to pre-fetch anything;
// the underlying `fetchProjectWorkspaceStatuses` service caches for 5s
// so multiple instances that mount around the same time only hit the
// server once.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/appStore";
import {
  fetchProjectWorkspaceStatuses,
  isLocalProjectId,
  type ProjectWorkspaceStatus,
} from "../../services/projects";
import { samePath, folderNameFromPath } from "./resourceSelection";

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

interface Props {
  /// When provided, overrides the active-workspace highlight target.
  /// Useful when the caller has a more authoritative pin (e.g.
  /// `socketWorkspace`) than the draft. Defaults to the store's
  /// `draftWorkspacePath`.
  activePathOverride?: string | null;
}

export function MultiGitRail({ activePathOverride }: Props) {
  const activeId = useAppStore((s) => s.activeId);
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const projectsById = useAppStore((s) => s.projectsById);
  const [statuses, setStatuses] = useState<ProjectWorkspaceStatus[] | null>(
    null,
  );

  // Fetch per-workspace git status whenever the bound project changes.
  // The service caches for 5s so this is cheap to run on every mount.
  useEffect(() => {
    if (!draftProjectId || isLocalProjectId(draftProjectId)) {
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
  }, [draftProjectId]);

  // Draft state is now owned by `ComposerProjectRail` (interactive
  // chip row with project picker + per-folder branch popover + add
  // folder). MultiGitRail stays the in-session read-only view.
  if (!activeId) return null;
  if (!draftProjectId) return null;
  const project = projectsById?.[draftProjectId];
  const workspaces = project?.workspaces ?? [];
  if (workspaces.length <= 1) return null; // single-workspace fallback

  const statusByPath = new Map<string, ProjectWorkspaceStatus>();
  for (const r of statuses ?? []) statusByPath.set(r.path, r);
  const activePath = activePathOverride ?? socketWorkspace ?? draftWorkspacePath;

  return (
    <div className="session-branch-rail multi-git-rail" role="list">
      {workspaces.map((w) => {
        const status = statusByPath.get(w.path);
        const vcs = status?.vcs ?? "unknown";
        const branchLabel =
          vcs === "git"
            ? status?.branch ?? "(detached)"
            : vcs === "none"
              ? "—"
              : "…";
        const dirty = !!status?.dirty;
        const active = !!activePath && samePath(w.path, activePath);
        const label = w.name?.trim() || folderNameFromPath(w.path);
        return (
          <span
            key={w.path}
            role="listitem"
            className={
              "session-chip session-chip-branch" +
              (active ? " is-active" : " is-inactive")
            }
            title={`${label} — ${w.path}`}
          >
            <BranchIcon />
            <span className="session-branch-rail-name">{label}</span>
            <span className="session-branch-rail-branch">{branchLabel}</span>
            {vcs === "git" && dirty ? (
              <span className="session-dirty-dot" title="dirty worktree" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
