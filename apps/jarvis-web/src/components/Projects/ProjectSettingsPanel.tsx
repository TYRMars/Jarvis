// Per-project settings dialog — name, description, instructions,
// workspaces, archive flag. Surfaces the multi-workspace editor so a
// user can curate which folders the chat-side picker will offer for
// this project after it's been created.

import { useEffect, useState } from "react";
import type { Project, ProjectWorkspace } from "../../types/frames";
import { archiveProject, restoreProject, updateProject } from "../../services/projects";
import { Modal } from "../ui/Modal";
import { t } from "../../utils/i18n";
import {
  ProjectWorkspacesEditor,
  compactWorkspaces,
} from "./ProjectWorkspacesEditor";

interface Props {
  project: Project;
  open: boolean;
  onClose: () => void;
}

export function ProjectSettingsPanel({ project, open, onClose }: Props) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.instructions);
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>(
    project.workspaces ?? [],
  );
  const [archived, setArchived] = useState(project.archived);
  const [busy, setBusy] = useState(false);

  // Reset local form when the modal re-opens with a different
  // project, or when the underlying row changes from a refresh.
  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setInstructions(project.instructions);
    setWorkspaces(project.workspaces ?? []);
    setArchived(project.archived);
  }, [
    open,
    project.id,
    project.name,
    project.description,
    project.instructions,
    project.workspaces,
    project.archived,
  ]);

  const trimmedName = name.trim();
  const trimmedInstructions = instructions.trim();
  const canSubmit =
    !busy &&
    trimmedName.length > 0 &&
    trimmedInstructions.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      // Archive flag is its own REST verb (DELETE / restore) so we
      // pipe it through the dedicated helpers when it changed —
      // updateProject can't toggle it on its own when going to true.
      if (archived !== project.archived) {
        if (archived) {
          await archiveProject(project.id);
        } else {
          await restoreProject(project.id);
        }
      }
      await updateProject(project.id, {
        name: trimmedName !== project.name ? trimmedName : undefined,
        description:
          (description.trim() || null) !== (project.description ?? null)
            ? description.trim()
            : undefined,
        instructions:
          trimmedInstructions !== project.instructions
            ? trimmedInstructions
            : undefined,
        workspaces: compactWorkspaces(workspaces),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={t("projectSettingsTitle")}
      size="lg"
      busy={busy}
    >
      <div className="project-settings-body">
        <label className="project-settings-field">
          <span>{t("projectCreateName")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="project-settings-field">
          <span>{t("projectCreateDesc")}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            disabled={busy}
          />
        </label>
        <label className="project-settings-field">
          <span>{t("projectCreateInstructions")}</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            disabled={busy}
          />
          <em className="project-settings-hint">
            {t("projectCreateInstructionsHint")}
          </em>
        </label>
        <div className="project-settings-section">
          <span className="project-settings-section-title">
            {t("projectWorkspacesTitle")}
          </span>
          <p className="project-settings-section-hint">
            {t("projectWorkspacesHint")}
          </p>
          <ProjectWorkspacesEditor
            value={workspaces}
            onChange={setWorkspaces}
            readOnly={busy}
          />
        </div>
        <label className="project-settings-archive">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>{t("projectSettingsArchived")}</strong>
            <em>{t("projectSettingsArchivedHint")}</em>
          </span>
        </label>
      </div>
      <footer className="project-settings-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={onClose}
          disabled={busy}
        >
          {t("projectSettingsClose")}
        </button>
        <button
          type="button"
          className="projects-new-btn"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {busy ? t("projectSettingsSaving") : t("projectSettingsSave")}
        </button>
      </footer>
    </Modal>
  );
}
