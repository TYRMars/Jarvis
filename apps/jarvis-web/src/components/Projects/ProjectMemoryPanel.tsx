import { useEffect, useMemo, useState } from "react";
import type { Project } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  deleteProjectMemoryFile,
  loadProjectMemory,
  saveProjectMemoryFile,
  syncProjectMemory,
  type ProjectMemoryFile,
  type ProjectMemorySnapshot,
} from "../../services/projects";
import { Button, Modal, Textarea, TextField } from "../ui";

export function ProjectMemoryPanel({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ProjectMemorySnapshot | null>(null);
  const [selectedName, setSelectedName] = useState("MEMORY.md");
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    void loadProjectMemory(project.id).then((next) => {
      if (cancelled) return;
      setSnapshot(next);
      const file = pickInitialFile(next, selectedName);
      setSelectedName(file?.name ?? "MEMORY.md");
      setDraft(file?.content ?? "");
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  const selected = useMemo(
    () => snapshot?.files.find((f) => f.name === selectedName) ?? null,
    [snapshot, selectedName],
  );
  const canEdit = !!selected && !selected.generated;
  const canDelete =
    !!selected &&
    !selected.generated &&
    selected.name !== "MEMORY.md" &&
    selected.name.endsWith(".md");

  const selectFile = (file: ProjectMemoryFile) => {
    setSelectedName(file.name);
    setDraft(file.content);
  };

  const replaceSnapshot = (next: ProjectMemorySnapshot | null) => {
    if (!next) return;
    setSnapshot(next);
    const file = pickInitialFile(next, selectedName);
    setSelectedName(file?.name ?? "MEMORY.md");
    setDraft(file?.content ?? "");
  };

  const onSync = async () => {
    setBusy(true);
    replaceSnapshot(await syncProjectMemory(project.id));
    setBusy(false);
  };

  const onSave = async () => {
    if (!selected || !canEdit) return;
    setBusy(true);
    replaceSnapshot(await saveProjectMemoryFile(project.id, selected.name, draft));
    setBusy(false);
  };

  const onCreate = async () => {
    const name = normalizeMemoryName(newName);
    if (!name) return;
    setBusy(true);
    const next = await saveProjectMemoryFile(project.id, name, "");
    if (next) {
      setSnapshot(next);
      setSelectedName(name);
      setDraft("");
      setNewName("");
    }
    setBusy(false);
  };

  const onDelete = async () => {
    if (!selected || !canDelete) return;
    if (!window.confirm(t("projectMemoryDeleteConfirm", selected.name))) return;
    setBusy(true);
    const next = await deleteProjectMemoryFile(project.id, selected.name);
    if (next) {
      setSnapshot(next);
      const file = pickInitialFile(next, "MEMORY.md");
      setSelectedName(file?.name ?? "MEMORY.md");
      setDraft(file?.content ?? "");
    }
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("projectMemoryTitle")}
      size="xl"
      dialogClassName="project-memory-modal"
      busy={busy}
    >
      <div className="project-memory-shell">
        <aside className="project-memory-sidebar">
          <div className="project-memory-path" title={snapshot?.dir ?? ""}>
            {snapshot?.dir ?? t("projectMemoryLoading")}
          </div>
          <div className="project-memory-files" role="listbox">
            {(snapshot?.files ?? []).map((file) => (
              <button
                key={file.name}
                type="button"
                className={
                  "project-memory-file" +
                  (file.name === selectedName ? " active" : "")
                }
                onClick={() => selectFile(file)}
              >
                <span>{file.name}</span>
                {file.generated && <em>{t("projectMemoryGenerated")}</em>}
              </button>
            ))}
          </div>
          <div className="project-memory-new">
            <TextField
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="topic.md"
              aria-label={t("projectMemoryNewFile")}
            />
            <Button size="sm" onClick={onCreate} disabled={busy || !newName.trim()}>
              {t("projectMemoryCreate")}
            </Button>
          </div>
        </aside>

        <section className="project-memory-editor">
          <div className="project-memory-editor-head">
            <div>
              <h3>{selected?.name ?? t("projectMemoryEmpty")}</h3>
              {selected && (
                <span className="project-memory-meta tabular-nums">
                  {selected.bytes} B
                </span>
              )}
            </div>
            <div className="project-memory-actions">
              <Button size="sm" onClick={onSync} disabled={busy}>
                {t("projectMemorySync")}
              </Button>
              {canDelete && (
                <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
                  {t("projectMemoryDelete")}
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                onClick={onSave}
                disabled={busy || !canEdit || draft === selected?.content}
              >
                {busy ? t("projectMemorySaving") : t("projectMemorySave")}
              </Button>
            </div>
          </div>
          <Textarea
            className="project-memory-textarea"
            value={draft}
            readOnly={!canEdit}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={selected?.name ?? t("projectMemoryTitle")}
          />
        </section>
      </div>
    </Modal>
  );
}

function pickInitialFile(
  snapshot: ProjectMemorySnapshot | null,
  preferred: string,
): ProjectMemoryFile | null {
  if (!snapshot) return null;
  return (
    snapshot.files.find((f) => f.name === preferred) ??
    snapshot.files.find((f) => f.name === "MEMORY.md") ??
    snapshot.files[0] ??
    null
  );
}

function normalizeMemoryName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  return name.endsWith(".md") ? name : `${name}.md`;
}
