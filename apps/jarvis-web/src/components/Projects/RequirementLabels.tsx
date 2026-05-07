// Phase 3.8 — label chip rendering + picker dialog for one
// Requirement.
//
// Two faces:
//
// 1. `<RequirementLabelChips ids />` — read-only inline chip row.
//    Used by the kanban card and the requirement detail header.
//    Looks up labels by id from `services/labels` cache; ids that
//    don't resolve (deleted server-side) render as a muted "?"
//    chip rather than vanishing — operators can still click "edit"
//    and prune the dangling reference.
//
// 2. `<RequirementLabelPicker projectId requirement onChange />` —
//    a popover-style picker that lists every label in the project,
//    pre-checks the ones currently on the requirement, and emits
//    a `next: string[]` when the user clicks Save. Hosting code
//    persists via `updateRequirement(reqId, { label_ids: next })`.
//
// Loads / subscribes via `services/labels` so a rename / recolour
// in the settings panel repaints chips everywhere immediately.

import { useEffect, useMemo, useState } from "react";

import {
  ensureLabelsLoaded,
  getLabel,
  listLabelsForProject,
  loadLabels,
  subscribeAllLabels,
  subscribeLabels,
} from "../../services/labels";
import type { Label } from "../../types/frames";
import { Button } from "../ui";
import { Modal } from "../ui/Modal";
import { t } from "../../utils/i18n";

// ---------- read-only chip row -------------------------------------

export function RequirementLabelChips({
  ids,
  emptyHint,
}: {
  ids: string[] | undefined;
  /// Render this prompt when the row carries no labels. Pass `null`
  /// to render nothing (kanban card uses this; the detail view shows
  /// a "no labels — click to add" affordance via the picker).
  emptyHint?: string | null;
}) {
  // Subscribe to global label cache so renames repaint instantly.
  const [, bump] = useState(0);
  useEffect(() => {
    return subscribeAllLabels(() => bump((n) => n + 1));
  }, []);

  if (!ids || ids.length === 0) {
    if (emptyHint == null) return null;
    return (
      <span className="requirement-label-chip-row requirement-label-chip-empty">
        {emptyHint}
      </span>
    );
  }

  return (
    <span className="requirement-label-chip-row">
      {ids.map((id) => {
        const label = getLabel(id);
        if (!label) {
          return (
            <span
              key={id}
              className="requirement-label-chip requirement-label-chip-missing"
              title={t("labelChipMissing", id.slice(0, 8))}
            >
              ?
            </span>
          );
        }
        return <LabelChip key={id} label={label} />;
      })}
    </span>
  );
}

/// Single chip with the label's colour as the background. The text
/// colour flips between black / white based on perceived luminance
/// so every operator-chosen colour stays readable.
export function LabelChip({ label }: { label: Label }) {
  const fg = textColourFor(label.colour);
  return (
    <span
      className="requirement-label-chip"
      style={{ backgroundColor: label.colour, color: fg }}
      title={label.description ?? label.name}
    >
      {label.name}
    </span>
  );
}

/// W3C-style luminance threshold. Returns black or white depending
/// on which gives more contrast against the chip background.
function textColourFor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Standard relative-luminance approximation.
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.55 ? "#000" : "#fff";
}

// ---------- picker (modal-style multi-select) ----------------------

export function RequirementLabelPicker({
  projectId,
  selected,
  open,
  onClose,
  onSave,
}: {
  projectId: string;
  selected: string[];
  open: boolean;
  onClose: () => void;
  onSave: (nextIds: string[]) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render when label cache updates.
  const [, bump] = useState(0);

  // Reset draft each time the picker opens — otherwise stale draft
  // state from a previous edit would survive cancel/reopen.
  useEffect(() => {
    if (open) {
      setDraft(new Set(selected));
      setError(null);
      void ensureLabelsLoaded(projectId);
    }
  }, [open, projectId, selected]);

  useEffect(() => subscribeLabels(projectId, () => bump((n) => n + 1)), [
    projectId,
  ]);

  const labels = useMemo(() => listLabelsForProject(projectId), [
    projectId,
    // labels list is cached in services/labels — bump triggers re-read
     
    bump,
  ]);

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      // Preserve selection order: existing ids that remain selected
      // keep their position, new ids append at the end. This matches
      // the on-disk semantics of `Requirement.label_ids` (server
      // preserves insertion order).
      const stable = selected.filter((id) => draft.has(id));
      const added = Array.from(draft).filter((id) => !selected.includes(id));
      await onSave(stable.concat(added));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={pending ? () => {} : onClose}
      title={t("labelsPickerTitle")}
    >
      <div className="requirement-label-picker">
        {labels.length === 0 ? (
          <p className="requirement-detail-empty">{t("labelsPickerEmpty")}</p>
        ) : (
          <ul className="requirement-label-picker-list">
            {labels.map((l) => (
              <li key={l.id}>
                <label className="requirement-label-picker-row">
                  <input
                    type="checkbox"
                    checked={draft.has(l.id)}
                    disabled={pending}
                    onChange={() => toggle(l.id)}
                  />
                  <LabelChip label={l} />
                  {l.description && (
                    <span className="requirement-label-picker-desc">
                      {l.description}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="requirement-detail-comment-error" role="alert">
            {error}
          </p>
        )}
        <div className="requirement-label-picker-actions">
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("labelsPickerSave")}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/// Convenience: ensure the labels for a project are hydrated before
/// rendering chips. Mounts an effect; safe to call repeatedly.
export function useEnsureLabels(projectId: string | undefined): void {
  useEffect(() => {
    if (!projectId) return;
    void loadLabels(projectId).catch(() => {
      // Soft-fail — chip lookups will render as "?" until reload.
    });
  }, [projectId]);
}
