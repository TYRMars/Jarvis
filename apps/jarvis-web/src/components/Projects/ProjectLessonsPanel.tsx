// Row-shaped project memory drawer.
//
// Distinct from the sibling `ProjectMemoryPanel`, which manages the
// file-backed `MEMORY.md` / `kanban.md` / `calendar.md` snapshot
// system. This panel is for the structured per-run memory store
// (see `harness_core::ProjectMemory`): rows captured from failed
// auto-runs plus operator-authored lessons, displayed newest-first
// with a small "add lesson" form so the operator can curate.
//
// REST surface (see `crates/harness-server/src/projects.rs`):
//   GET    /v1/projects/:id_or_slug/memories
//   POST   /v1/projects/:id_or_slug/memories
//   DELETE /v1/projects/:id_or_slug/memories/:memory_id

import { useEffect, useState } from "react";
import type { Project } from "../../types/frames";
import { t } from "../../utils/i18n";
import {
  createProjectMemoryRow,
  deleteProjectMemoryRow,
  listProjectMemoryRows,
  type ProjectMemoryRow,
} from "../../services/projects";
import { Button, Modal, Textarea, TextField } from "../ui";

type DraftKind = "lesson" | "gotcha" | "context";
const DRAFT_KINDS: DraftKind[] = ["lesson", "gotcha", "context"];

export function ProjectLessonsPanel({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ProjectMemoryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [draftKind, setDraftKind] = useState<DraftKind>("lesson");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setComposerOpen(false);
    void listProjectMemoryRows(project.id).then((next) => {
      if (cancelled) return;
      setRows(next);
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  const refresh = async () => {
    setBusy(true);
    setRows(await listProjectMemoryRows(project.id));
    setBusy(false);
  };

  const onCreate = async () => {
    const title = draftTitle.trim();
    const body = draftBody.trim();
    if (!title || !body) return;
    setBusy(true);
    const created = await createProjectMemoryRow(project.id, {
      kind: draftKind,
      title,
      body,
    });
    if (created) {
      resetDraft();
      setComposerOpen(false);
      setRows((prev) => [created, ...prev]);
    }
    setBusy(false);
  };

  const resetDraft = () => {
    setDraftKind("lesson");
    setDraftTitle("");
    setDraftBody("");
  };

  const onDelete = async (row: ProjectMemoryRow) => {
    if (!window.confirm(t("projectLessonDeleteConfirm", row.title))) return;
    setBusy(true);
    const ok = await deleteProjectMemoryRow(project.id, row.id);
    if (ok) setRows((prev) => prev.filter((r) => r.id !== row.id));
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("projectLessonsTitle")}
      size="xl"
      dialogClassName="project-lessons-modal"
      busy={busy}
    >
      <div className="project-lessons-shell">
        <header className="project-lessons-toolbar">
          <div>
            <h3>
              {t("projectLessonsListTitle")}
              <span className="project-lessons-count tabular-nums">
                {rows.length}
              </span>
            </h3>
          </div>
          <div className="project-lessons-toolbar-actions">
            <Button size="sm" onClick={refresh} disabled={busy}>
              {t("projectLessonsRefresh")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setComposerOpen(true)}
              disabled={busy || composerOpen}
            >
              {t("projectLessonsAdd")}
            </Button>
          </div>
        </header>

        {composerOpen && (
          <section className="project-lessons-composer">
            <div
              className="project-lessons-kind-tabs"
              role="group"
              aria-label={t("projectLessonKind")}
            >
              {DRAFT_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={
                    "project-lessons-kind-tab" +
                    (draftKind === kind ? " active" : "")
                  }
                  aria-pressed={draftKind === kind}
                  onClick={() => setDraftKind(kind)}
                >
                  {kindLabel(kind)}
                </button>
              ))}
            </div>
            <div className="project-lessons-title-field">
              <TextField
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder={t("projectLessonTitlePlaceholder")}
                aria-label={t("projectLessonTitle")}
                maxLength={200}
              />
            </div>
            <div className="project-lessons-body-field">
              <Textarea
                className="project-lessons-body"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                placeholder={t("projectLessonBodyPlaceholder")}
                aria-label={t("projectLessonBody")}
                maxLength={4000}
              />
            </div>
            <div className="project-lessons-create-actions">
              <Button
                size="sm"
                onClick={() => {
                  resetDraft();
                  setComposerOpen(false);
                }}
                disabled={busy}
              >
                {t("projectLessonsCancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={onCreate}
                disabled={busy || !draftTitle.trim() || !draftBody.trim()}
              >
                {busy ? t("projectLessonsAdding") : t("projectLessonsAdd")}
              </Button>
            </div>
          </section>
        )}

        <section className="project-lessons-list">
          {rows.length === 0 ? (
            <div className="project-lessons-empty">
              <strong>{t("projectLessonsEmptyTitle")}</strong>
              <span>{t("projectLessonsEmpty")}</span>
              {!composerOpen && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setComposerOpen(true)}
                  disabled={busy}
                >
                  {t("projectLessonsAdd")}
                </Button>
              )}
            </div>
          ) : (
            <ul className="project-lessons-rows">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className={`project-lessons-row kind-${row.kind}`}
                >
                  <header>
                    <span className={`project-lessons-tag tag-${row.kind}`}>
                      {kindLabel(row.kind)}
                    </span>
                    <strong>{row.title}</strong>
                    <button
                      type="button"
                      className="project-lessons-delete"
                      onClick={() => onDelete(row)}
                      disabled={busy}
                      aria-label={t("projectLessonDelete")}
                      title={t("projectLessonDelete")}
                    >
                      ×
                    </button>
                  </header>
                  <pre className="project-lessons-body-display">{row.body}</pre>
                  <footer>
                    <span className="tabular-nums">
                      {formatTimestamp(row.updated_at)}
                    </span>
                    {row.source_run_id ? (
                      <span title={row.source_run_id}>
                        {t("projectLessonSourceRun")}{" "}
                        <code>{row.source_run_id.slice(0, 8)}</code>
                      </span>
                    ) : null}
                    {row.source_requirement_id ? (
                      <span title={row.source_requirement_id}>
                        {t("projectLessonSourceReq")}{" "}
                        <code>{row.source_requirement_id.slice(0, 8)}</code>
                      </span>
                    ) : null}
                  </footer>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

function kindLabel(kind: DraftKind): string {
  switch (kind) {
    case "lesson":
      return t("projectLessonKindLesson");
    case "gotcha":
      return t("projectLessonKindGotcha");
    case "context":
      return t("projectLessonKindContext");
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
