// Modal editor for a project's kanban columns.
//
// Editing rules (mirror the server-side validator in
// `crates/harness-server/src/projects.rs::validate_columns`):
//  - 1–32 columns
//  - id: lowercase ASCII / digits / `_` / `-`, 1–64 bytes; auto-derived
//    from the label until the user touches the id field
//  - label: any non-blank string (rendered verbatim, no i18n)
//  - kind: optional dropdown — drives the column's icon. `""` here
//    means "custom column, neutral dot"; serialised as `null` on
//    the wire
//  - reorder via ↑/↓ buttons (no DnD here — keeps the editor's surface
//    area small; the board itself uses dnd-kit for cards)
//
// Saving sends the full column list to PUT `/v1/projects/:id_or_slug`
// via `updateProject`. The server re-checks shape + uniqueness; any
// rejection surfaces as a `showError` toast and a banner inside the
// modal, and the modal stays open so the user can fix the problem in
// place.

import { useMemo, useState } from "react";
import type { KanbanColumn, Project } from "../../types/frames";
import { t } from "../../utils/i18n";
import { updateProject } from "../../services/projects";
import {
  defaultColumnsForSave,
  type ColumnKind,
} from "./columns";
import { Button, Modal, Select } from "../ui";

interface Props {
  project: Project;
  onClose: () => void;
}

// Local editor row. `key` is a stable react identity so reorder /
// add / remove don't lose focus state mid-edit; `idEdited` tracks
// whether the user has touched the id field — until they have, typing
// in the label keeps the id auto-derived (matches how the docs editor
// seeds slugs).
interface Row {
  key: number;
  id: string;
  label: string;
  kind: ColumnKind | "" /* "" = custom / no-kind */;
  idEdited: boolean;
}

const KIND_VALUES: Array<ColumnKind | ""> = [
  "",
  "backlog",
  "in_progress",
  "review",
  "done",
];

export function ColumnEditor({ project, onClose }: Props) {
  // Seed from the saved columns when present, otherwise the four
  // built-in defaults. `idEdited: true` for these initial rows so
  // editing the label doesn't clobber the user's existing id.
  const seed = useMemo<Row[]>(() => {
    const src = project.columns ?? defaultColumnsForSave();
    return src.map((c, i) => ({
      key: i,
      id: c.id,
      label: c.label,
      kind: c.kind ?? "",
      idEdited: true,
    }));
  }, [project.columns]);

  const [rows, setRows] = useState<Row[]>(seed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic key generator — collisions would only matter visually
  // (lost focus on add/remove) but a counter is bullet-proof.
  const [nextKey, setNextKey] = useState(seed.length);

  const kindOptions = useMemo(
    () =>
      KIND_VALUES.map((value) => ({
        value,
        label:
          value === ""
            ? t("columnEditorKindCustom")
            : value === "backlog"
            ? t("colBacklog")
            : value === "in_progress"
            ? t("colInProgress")
            : value === "review"
            ? t("colReview")
            : t("colDone"),
      })),
    [],
  );

  const localValidation = useMemo(() => validateRows(rows), [rows]);
  const canSave = !busy && localValidation === null;

  const setLabel = (key: number, label: string) => {
    setRows((rs) =>
      rs.map((r) =>
        r.key === key
          ? {
              ...r,
              label,
              // Auto-derive id from the label while it hasn't been
              // touched. Once the user edits the id manually, label
              // changes stop propagating.
              id: r.idEdited ? r.id : slugifyForId(label),
            }
          : r,
      ),
    );
  };

  const setId = (key: number, id: string) => {
    setRows((rs) =>
      rs.map((r) => (r.key === key ? { ...r, id, idEdited: true } : r)),
    );
  };

  const setKind = (key: number, kind: ColumnKind | "") => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, kind } : r)));
  };

  const remove = (key: number) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
  };

  const move = (key: number, delta: -1 | 1) => {
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.key === key);
      const targetIdx = idx + delta;
      if (idx < 0 || targetIdx < 0 || targetIdx >= rs.length) return rs;
      const out = rs.slice();
      const [item] = out.splice(idx, 1);
      out.splice(targetIdx, 0, item);
      return out;
    });
  };

  const addRow = () => {
    setRows((rs) => [
      ...rs,
      {
        key: nextKey,
        id: "",
        label: "",
        kind: "",
        idEdited: false,
      },
    ]);
    setNextKey((k) => k + 1);
  };

  const reset = () => {
    const defaults = defaultColumnsForSave();
    setRows(
      defaults.map((c, i) => ({
        key: nextKey + i,
        id: c.id,
        label: c.label,
        kind: c.kind ?? "",
        idEdited: true,
      })),
    );
    setNextKey((k) => k + defaults.length);
    setError(null);
  };

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const wire: KanbanColumn[] = rows.map((r) => ({
        id: r.id.trim(),
        label: r.label.trim(),
        kind: r.kind === "" ? null : r.kind,
      }));
      // Server will re-validate; any failure surfaces as a 400 with
      // a `{error}` body that `updateProject` shows via `showError`.
      // We also catch the null result so the modal stays open if the
      // PATCH itself failed (network / 5xx) — the user keeps their
      // work and can adjust + retry.
      const updated = await updateProject(project.id, { columns: wire });
      if (!updated) {
        setError("save failed — see notification");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={t("columnEditorTitle")}
      size="lg"
      busy={busy}
    >
      <p className="column-editor-hint">{t("columnEditorHint")}</p>
      {(error || localValidation) && (
        <div className="column-editor-error" role="alert">
          {error ?? localValidation}
        </div>
      )}
      <div className="column-editor-rows">
        {rows.map((r, idx) => (
          <div className="column-editor-row" key={r.key}>
            {/* Reorder handle column — two stacked icon-buttons.
                The existing `.column-editor-row` grid reserves the
                first track for this handle so the layout matches
                the modal-design CSS without modification. */}
            <div className="column-editor-handle">
              <button
                type="button"
                className="ghost-icon"
                onClick={() => move(r.key, -1)}
                disabled={idx === 0}
                aria-label={t("columnEditorMoveUp")}
                title={t("columnEditorMoveUp")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m18 15-6-6-6 6" />
                </svg>
              </button>
              <button
                type="button"
                className="ghost-icon"
                onClick={() => move(r.key, 1)}
                disabled={idx === rows.length - 1}
                aria-label={t("columnEditorMoveDown")}
                title={t("columnEditorMoveDown")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>

            <label className="column-editor-field column-editor-field-label">
              <span>{t("columnEditorLabel")}</span>
              <input
                type="text"
                value={r.label}
                onChange={(e) => setLabel(r.key, e.target.value)}
                placeholder="Backlog"
                autoFocus={idx === rows.length - 1 && r.label === ""}
              />
            </label>

            <label className="column-editor-field column-editor-field-id">
              <span>{t("columnEditorId")}</span>
              <input
                type="text"
                value={r.id}
                onChange={(e) => setId(r.key, e.target.value)}
                placeholder="backlog"
                spellCheck={false}
              />
            </label>

            <div className="column-editor-field column-editor-field-kind">
              <span>{t("columnEditorKind")}</span>
              <Select<ColumnKind | "">
                value={r.kind}
                onChange={(v) => setKind(r.key, v)}
                options={kindOptions}
                ariaLabel={t("columnEditorKind")}
              />
            </div>

            <button
              type="button"
              className="ghost-icon"
              onClick={() => remove(r.key)}
              disabled={rows.length <= 1}
              aria-label={t("columnEditorRemoveRow")}
              title={t("columnEditorRemoveRow")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <p className="column-editor-hint">{t("columnEditorIdHint")}</p>
      <div className="column-editor-tools">
        <Button
          variant="ghost"
          onClick={addRow}
          disabled={busy || rows.length >= 32}
        >
          + {t("columnEditorAddRow")}
        </Button>
        <Button variant="ghost" onClick={reset} disabled={busy}>
          {t("columnEditorReset")}
        </Button>
      </div>
      <div className="column-editor-actions">
        <Button variant="default" onClick={onClose} disabled={busy}>
          {t("columnEditorCancel")}
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSave}
        >
          {busy ? t("columnEditorBusy") : t("columnEditorSave")}
        </Button>
      </div>
    </Modal>
  );
}

/// Convert a free-form label into a candidate id using the same
/// charset as `validate_column_id` on the server. Mirrors the
/// derive-slug logic but allows underscore (since column ids do).
function slugifyForId(input: string): string {
  let out = "";
  let prevSep = true;
  for (const ch of input.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      prevSep = false;
    } else if (!prevSep) {
      out += "_";
      prevSep = true;
    }
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 64);
}

/// Local validation. Returns `null` when the row set is shippable;
/// otherwise an i18n string explaining the first problem so the user
/// can fix it inline. The server re-runs the same checks, but
/// running them in the browser keeps the Save button accurate.
function validateRows(rows: Row[]): string | null {
  if (rows.length === 0) return t("columnEditorTooFew");
  if (rows.length > 32) return t("columnEditorTooMany");
  const seen = new Set<string>();
  const idShape = /^[a-z0-9_-]{1,64}$/;
  for (const r of rows) {
    if (!r.label.trim()) return t("columnEditorBlankLabel");
    if (!idShape.test(r.id)) return t("columnEditorBadId");
    if (seen.has(r.id)) return t("columnEditorDuplicateId");
    seen.add(r.id);
  }
  return null;
}
