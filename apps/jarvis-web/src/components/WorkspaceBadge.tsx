// Chat-header workspace badge — shows the resolved workspace root
// and git state at a glance, click to refresh, hover for the full
// path.
//
// Data comes from `GET /v1/workspace`. Refreshes on mount and on
// click. Doesn't poll — the badge is a snapshot, not a live ticker;
// branch / dirty changes show on next click. If we ever care about
// "auto-refresh after a tool turn ends", subscribe to `done` in
// `frames.ts` and re-fetch.

import { useEffect, useState } from "react";
import { fetchWorkspace, shortenPath } from "../services/workspace";
import type { WorkspaceState } from "../services/workspace";

export function WorkspaceBadge() {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const refresh = () => {
    setState({ kind: "loading" });
    fetchWorkspace().then(setState);
  };
  useEffect(() => {
    refresh();
    // No deps — fetch once on mount. The user can click the badge
    // to re-fetch; we deliberately don't poll because every click
    // boots a `git status --porcelain` and that's not free on
    // larger trees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === "loading") {
    return (
      <button
        type="button"
        className="workspace-badge workspace-badge-loading"
        title="loading workspace"
        disabled
      >
        <BadgeIcon />
        <span>…</span>
      </button>
    );
  }
  if (state.kind === "unconfigured") {
    return (
      <button
        type="button"
        className="workspace-badge workspace-badge-error"
        title="server didn't pin a workspace root — check JARVIS_FS_ROOT or --workspace"
        onClick={refresh}
      >
        <BadgeIcon />
        <span>no workspace</span>
      </button>
    );
  }
  if (state.kind === "error") {
    return (
      <button
        type="button"
        className="workspace-badge workspace-badge-error"
        title={`workspace lookup failed: ${state.message}`}
        onClick={refresh}
      >
        <BadgeIcon />
        <span>retry</span>
      </button>
    );
  }
  const { info } = state;
  const short = shortenPath(info.root);
  // Build the inline label: "~/code/myrepo · main●" (dirty) or
  // "~/code/myrepo · main" (clean). Non-git: just the path.
  const branch = info.vcs === "git" ? info.branch ?? "(detached)" : null;
  const dirty = info.vcs === "git" && info.dirty === true;
  const tooltip =
    info.vcs === "git"
      ? `${info.root}\n${info.branch ?? "(detached)"} (${info.head ?? "?"})${dirty ? " · dirty" : " · clean"}`
      : info.root;
  return (
    <button
      type="button"
      className={`workspace-badge${dirty ? " workspace-badge-dirty" : ""}`}
      title={tooltip}
      onClick={refresh}
    >
      <BadgeIcon />
      <span className="workspace-badge-path">{short}</span>
      {branch && (
        <>
          <span className="workspace-badge-sep">·</span>
          <span className="workspace-badge-branch">
            {branch}
            {dirty && <span className="workspace-badge-dot" aria-label="dirty">●</span>}
          </span>
        </>
      )}
    </button>
  );
}

function BadgeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
