// Phase 3.8 — Settings page section to manage project Labels.
//
// One section per process; the project to edit is picked via a
// dropdown at the top so the URL routing stays simple. New labels
// are added through an inline form (name / colour / optional
// description). Existing labels render as live chips with rename
// / recolour-in-place plus a per-row delete.
//
// Validation duplicates the server's rules client-side so users get
// instant feedback (32-char name cap, `#rrggbb` colour, no control
// chars) — but the server is still the source of truth and any
// disagreement (e.g. case-insensitive uniqueness) surfaces as a
// 409 toast.

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../store/appStore";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  createLabel,
  deleteLabel,
  listLabelsForProject,
  loadLabels,
  subscribeLabels,
  updateLabel,
} from "../../../services/labels";
import { LabelChip } from "../../Projects/RequirementLabels";
import type { Label } from "../../../types/frames";
import { Button, TextField } from "../../ui";

const DEFAULT_COLOUR = "#7280f5";

function isValidHex(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s.trim());
}

export function LabelsSettingsSection({ embedded }: { embedded?: boolean } = {}) {
  const projects = useAppStore((s) => s.projects);
  const projectsAvailable = useAppStore((s) => s.projectsAvailable);
  const [projectId, setProjectId] = useState<string>("");
  const [storeAvailable, setStoreAvailable] = useState<boolean | null>(null);
  const [, bump] = useState(0);
  const [topError, setTopError] = useState<string | null>(null);

  // Pick the first non-archived project on first mount.
  useEffect(() => {
    if (!projectId && projects.length > 0) {
      const first = projects.find((p) => !p.archived) ?? projects[0];
      if (first) setProjectId(first.id);
    }
  }, [projects, projectId]);

  // Re-fetch + re-subscribe when the picker flips.
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setStoreAvailable(null);
    setTopError(null);
    void loadLabels(projectId)
      .then((rows) => {
        if (!alive) return;
        setStoreAvailable(rows !== null);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setTopError(e.message);
        setStoreAvailable(true); // store is configured, just transient error
      });
    const unsub = subscribeLabels(projectId, () => bump((n) => n + 1));
    return () => {
      alive = false;
      unsub();
    };
  }, [projectId]);

  const labels = useMemo(
    () => (projectId ? listLabelsForProject(projectId) : []),
    [projectId, bump],
  );

  if (!projectsAvailable) {
    return (
      <Section
        id="labels"
        titleKey="labelsSettingsHeading"
        titleFallback="Labels"
        descKey="labelsSettingsDesc"
        descFallback="Project-scoped tags for kanban cards."
        embedded={embedded}
      >
        <p className="settings-empty">
          {t("settingsServerNotConfigured")}
        </p>
      </Section>
    );
  }

  return (
    <Section
      id="labels"
      titleKey="labelsSettingsHeading"
      titleFallback="Labels"
      descKey="labelsSettingsDesc"
      descFallback="Project-scoped tags for kanban cards."
      embedded={embedded}
    >
      <div className="settings-row">
        <div className="settings-row-label">
          <div>{t("labelsSettingsProjectLabel")}</div>
        </div>
        <div className="settings-row-control">
          <select
            className="ui-select"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {storeAvailable === false ? (
        <p className="settings-empty">
          {t("labelsSettingsServiceUnavailable")}
        </p>
      ) : (
        <>
          {projectId && (
            <NewLabelForm
              projectId={projectId}
              onError={(m) => setTopError(m)}
            />
          )}

          {topError && (
            <p className="requirement-detail-comment-error" role="alert">
              {t("labelsSettingsErrorPrefix")}: {topError}
            </p>
          )}

          {labels.length === 0 ? (
            <p className="settings-empty">{t("labelsSettingsListEmpty")}</p>
          ) : (
            <ul className="labels-settings-list">
              {labels.map((l) => (
                <LabelSettingsRow
                  key={l.id}
                  label={l}
                  onError={(m) => setTopError(m)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

// ---------- new-label inline form -----------------------------------

function NewLabelForm({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState(DEFAULT_COLOUR);
  const [desc, setDesc] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (!isValidHex(colour)) {
      onError(t("labelsSettingsInvalidColour"));
      return;
    }
    setPending(true);
    onError("");
    try {
      await createLabel(projectId, {
        name: trimmedName,
        colour,
        description: desc.trim() || undefined,
      });
      setName("");
      setDesc("");
      setColour(DEFAULT_COLOUR);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="labels-settings-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label={t("labelsSettingsAddName")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={pending}
        maxLength={32}
      />
      <label className="labels-settings-colour">
        <span>{t("labelsSettingsAddColour")}</span>
        <input
          type="color"
          value={colour}
          onChange={(e) => setColour(e.target.value)}
          disabled={pending}
        />
        <code>{colour}</code>
      </label>
      <TextField
        label={t("labelsSettingsAddDesc")}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        disabled={pending}
        maxLength={256}
      />
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={pending || name.trim().length === 0}
      >
        {t("labelsSettingsAddSubmit")}
      </Button>
    </form>
  );
}

// ---------- one row in the existing labels list ---------------------

function LabelSettingsRow({
  label,
  onError,
}: {
  label: Label;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(label.name);
  const [colour, setColour] = useState(label.colour);
  const [desc, setDesc] = useState(label.description ?? "");
  const [pending, setPending] = useState(false);

  // Sync local state if the row was renamed/recoloured elsewhere
  // (multi-tab scenario, future WS frame).
  useEffect(() => {
    setName(label.name);
    setColour(label.colour);
    setDesc(label.description ?? "");
  }, [label.name, label.colour, label.description]);

  const dirty =
    name.trim() !== label.name ||
    colour !== label.colour ||
    (desc.trim() || undefined) !== label.description;

  const save = async () => {
    if (!isValidHex(colour)) {
      onError(t("labelsSettingsInvalidColour"));
      return;
    }
    setPending(true);
    onError("");
    try {
      await updateLabel(label.id, {
        name: name.trim(),
        colour,
        description: desc.trim(),
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("labelsSettingsConfirmDelete"))) return;
    setPending(true);
    onError("");
    try {
      await deleteLabel(label.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="labels-settings-row">
      <LabelChip label={label} />
      <input
        className="labels-settings-input labels-settings-input-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={pending}
        maxLength={32}
      />
      <input
        type="color"
        value={colour}
        onChange={(e) => setColour(e.target.value)}
        disabled={pending}
      />
      <input
        className="labels-settings-input labels-settings-input-desc"
        value={desc}
        placeholder={t("labelsSettingsAddDesc")}
        onChange={(e) => setDesc(e.target.value)}
        disabled={pending}
        maxLength={256}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={pending || !dirty || name.trim().length === 0}
        onClick={() => void save()}
      >
        {t("commentsSave")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => void remove()}
      >
        {t("labelsSettingsRemove")}
      </Button>
    </li>
  );
}
