// Branch + worktree picker popover for one project workspace.
//
// Anchored to a folder chip in `ComposerProjectRail`. Lists local /
// remote branches via `fetchProjectWorkspaceBranches`, supports
// search-as-you-type filter, and a `[ worktree ][ checkout ]`
// segmented control at the bottom selects how the chosen branch is
// applied. Default mode is `worktree` (safe — never mutates the
// user's main checkout); `checkout` runs `git checkout` in-place
// and surfaces a confirm dialog when the workspace is dirty (the
// server's 409 response carries the dirty file list).
//
// Closes on: outside-click, Escape, or after a successful switch.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DirtyWorkspaceError,
  fetchProjectWorkspaceBranches,
  switchProjectWorkspace,
  type ProjectWorkspaceBranches,
  type SwitchWorkspaceMode,
  type SwitchWorkspaceResult,
} from "../../services/projects";
import { folderNameFromPath } from "./resourceSelection";

interface Props {
  projectId: string;
  workspacePath: string;
  /// Branch the chip is currently displaying. We highlight this row
  /// in the list and pre-select the segmented control's matching
  /// mode (worktree if the active path differs from the workspace
  /// path, checkout otherwise).
  currentBranch?: string | null;
  /// Called after a successful switch with the server's response so
  /// the rail can stash it in `draftFolderRefs`.
  onSwitched: (result: SwitchWorkspaceResult) => void;
  onClose: () => void;
}

export function BranchPopover({
  projectId,
  workspacePath,
  currentBranch,
  onSwitched,
  onClose,
}: Props) {
  const [data, setData] = useState<ProjectWorkspaceBranches | null>(null);
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SwitchWorkspaceMode>("worktree");
  const [dirtyConfirm, setDirtyConfirm] = useState<{
    branch: string;
    files: string[];
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load branches once when the popover mounts. The endpoint is
  // uncached so subsequent opens re-fetch (operator may have created
  // a new branch in their terminal between opens).
  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchProjectWorkspaceBranches(projectId, workspacePath)
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workspacePath]);

  // Outside-click + Escape dismiss.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = data?.branches ?? [];
    if (!q) return all;
    return all.filter((b) => b.name.toLowerCase().includes(q));
  }, [data, filter]);

  // Clamp highlight whenever the list shrinks.
  useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, highlight]);

  const folderLabel = folderNameFromPath(workspacePath);

  const apply = async (branch: string, force = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await switchProjectWorkspace(
        projectId,
        workspacePath,
        branch,
        mode,
        { force },
      );
      onSwitched(result);
      setDirtyConfirm(null);
      onClose();
    } catch (e: unknown) {
      if (e instanceof DirtyWorkspaceError) {
        setDirtyConfirm({ branch, files: e.dirtyFiles });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[highlight];
      if (target) void apply(target.name);
    }
  };

  return (
    <div className="branch-popover" role="dialog" ref={wrapRef}>
      <div className="branch-popover-header">
        <strong>{folderLabel}</strong>
        <span className="branch-popover-path" title={workspacePath}>
          {workspacePath}
        </span>
      </div>
      <div className="branch-popover-search">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onInputKey}
          placeholder="Search branches…"
          disabled={busy}
        />
      </div>
      <div className="branch-popover-list">
        {data === null && error === null ? (
          <div className="branch-popover-empty">Loading…</div>
        ) : null}
        {data !== null && filtered.length === 0 ? (
          <div className="branch-popover-empty">
            {data.branches.length === 0
              ? "Not a git repo"
              : "No matching branches"}
          </div>
        ) : null}
        {filtered.map((b, i) => {
          const isCurrent = b.name === (currentBranch ?? data?.current);
          return (
            <button
              key={b.name}
              type="button"
              className="branch-popover-row"
              data-highlighted={i === highlight ? "true" : undefined}
              data-current={isCurrent ? "true" : undefined}
              data-remote={b.is_remote ? "true" : undefined}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => void apply(b.name)}
              disabled={busy}
              title={b.name}
            >
              <span className="branch-popover-row-name">
                {b.is_remote ? <span className="branch-popover-remote-prefix">remote</span> : null}
                {b.name}
              </span>
              {isCurrent ? <span className="branch-popover-check" aria-hidden="true">✓</span> : null}
            </button>
          );
        })}
      </div>
      <div className="branch-popover-mode" role="radiogroup" aria-label="Switch mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === "worktree"}
          className="branch-popover-mode-btn"
          data-active={mode === "worktree" ? "true" : undefined}
          onClick={() => setMode("worktree")}
          disabled={busy}
          title="Mint a fresh worktree (safe — leaves the main checkout untouched)"
        >
          worktree
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "checkout"}
          className="branch-popover-mode-btn"
          data-active={mode === "checkout" ? "true" : undefined}
          onClick={() => setMode("checkout")}
          disabled={busy}
          title="git checkout in the workspace itself (refuses if dirty)"
        >
          checkout
        </button>
      </div>
      {error ? <div className="branch-popover-error">{error}</div> : null}
      {dirtyConfirm ? (
        <div className="branch-popover-dirty">
          <p>
            Workspace has {dirtyConfirm.files.length} uncommitted change
            {dirtyConfirm.files.length === 1 ? "" : "s"}. Force checkout
            anyway? Local edits will be overwritten by branch contents.
          </p>
          <ul className="branch-popover-dirty-files">
            {dirtyConfirm.files.slice(0, 6).map((f) => (
              <li key={f}>{f}</li>
            ))}
            {dirtyConfirm.files.length > 6 ? (
              <li>… and {dirtyConfirm.files.length - 6} more</li>
            ) : null}
          </ul>
          <div className="branch-popover-dirty-actions">
            <button
              type="button"
              className="branch-popover-mode-btn"
              onClick={() => setDirtyConfirm(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="branch-popover-mode-btn"
              data-danger="true"
              onClick={() => void apply(dirtyConfirm.branch, true)}
              disabled={busy}
            >
              Force checkout
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
