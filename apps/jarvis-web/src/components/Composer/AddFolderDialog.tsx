// Tiny modal for the `+` chip in `ComposerProjectRail`. Adds a new
// folder to a project's `workspaces[]` (persists via `updateProject`).
//
// Validates the path via `probeWorkspace` before submit so the user
// gets immediate "not a directory" / "doesn't exist" feedback, same
// pattern as `ResourceManagerDialog`'s folder tab uses.
//
// Optional `name` field lets the user override the chip's display
// label; when blank the rail falls back to the folder basename.

import { useEffect, useRef, useState } from "react";
import { probeWorkspace } from "../../services/workspace";
import {
  pickWorkspaceFolder,
  supportsWorkspaceFolderPicker,
} from "../../services/folderPicker";
import { updateProject } from "../../services/projects";
import type { Project, ProjectWorkspace } from "../../types/frames";
import { t } from "../../utils/i18n";
import { samePath } from "./resourceSelection";

interface Props {
  project: Project;
  open: boolean;
  onClose: () => void;
  /// Called after the project is successfully updated. Receives the
  /// canonical path the server stored so the rail can immediately
  /// show the new chip without waiting for a refresh.
  onAdded: (added: ProjectWorkspace) => void;
}

export function AddFolderDialog({ project, open, onClose, onAdded }: Props) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// Multiple absolute-path candidates returned by `findWorkspaceByName`
  /// when the OS-picker basename matches several folders under the
  /// search roots. Renders as an inline disambiguation list right
  /// under the path input. Cleared once the user picks one.
  const [candidates, setCandidates] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const browseSupported = supportsWorkspaceFolderPicker();

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPath("");
    setName("");
    setError(null);
    setCandidates([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  /// "Browse…" — call the system folder picker. Desktop returns an
  /// absolute path directly; browser builds fall back to basename
  /// resolution through the backend.
  const onBrowse = async () => {
    if (!browseSupported) {
      setError(t("composerFolderPickerUnsupported"));
      return;
    }
    setError(null);
    try {
      const picked = await pickWorkspaceFolder();
      if (!picked.path) return;
      setPath(picked.path);
      if (picked.unresolvedName) {
        setError(
          t("composerFolderPickerNoMatch").replace("{0}", picked.unresolvedName),
        );
        setCandidates([]);
      } else if (picked.candidates.length <= 1) {
        setCandidates([]);
      } else {
        setCandidates(picked.candidates);
        // Pre-fill the first candidate so a user who hits Add
        // without picking still gets a sensible value.
      }
    } catch {
      // User cancelled the OS dialog — no-op, no error.
    }
  };

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) {
      setError("Path is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Probe to canonicalise + sanity-check before sending the PUT.
      const info = await probeWorkspace(trimmed);
      const canonical = info.root;
      // Reject duplicates client-side so the user sees "already added"
      // instead of the silent server-side dedupe.
      if ((project.workspaces ?? []).some((w) => samePath(w.path, canonical))) {
        setError("That folder is already in this project");
        setBusy(false);
        return;
      }
      const next: ProjectWorkspace = {
        path: canonical,
        name: name.trim() || null,
      };
      const merged: ProjectWorkspace[] = [...(project.workspaces ?? []), next];
      const updated = await updateProject(project.id, { workspaces: merged });
      if (updated) {
        // Server may have re-canonicalised; pull the matching entry
        // back so we hand the caller the row the server stored.
        const stored =
          updated.workspaces?.find((w) => samePath(w.path, canonical)) ?? next;
        onAdded(stored);
        onClose();
      } else {
        setError("Failed to update project");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <div className="add-folder-modal-backdrop" onClick={onClose}>
      <form
        className="add-folder-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="add-folder-modal-header">
          <strong>Add folder to {project.name}</strong>
        </div>
        <label className="add-folder-modal-field">
          <span>Path</span>
          <div className="add-folder-modal-path-row">
            <input
              ref={inputRef}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/absolute/path/to/repo or ~/code/proj"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            {browseSupported && (
              <button
                type="button"
                className="add-folder-modal-btn"
                onClick={() => void onBrowse()}
                disabled={busy}
              >
                {t("composerFolderPickerBrowse")}
              </button>
            )}
          </div>
        </label>
        {candidates.length > 1 && (
          <div className="add-folder-modal-candidates">
            <p className="add-folder-modal-candidates-hint">
              {t("composerFolderPickerMultiHint")}
            </p>
            <ul>
              {candidates.map((c) => (
                <li key={c}>
                  <button
                    type="button"
                    onClick={() => {
                      setPath(c);
                      setCandidates([]);
                    }}
                    data-active={c === path ? "true" : undefined}
                  >
                    <code>{c}</code>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="add-folder-modal-field">
          <span>Display name (optional)</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="defaults to folder name"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        {error ? <div className="add-folder-modal-error">{error}</div> : null}
        <div className="add-folder-modal-actions">
          <button
            type="button"
            className="add-folder-modal-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="add-folder-modal-btn"
            data-primary="true"
            disabled={busy || !path.trim()}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
