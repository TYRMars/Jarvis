// Repeating editor for a Project's `workspaces` list. Used by both
// `ProjectCreatePanel` (initial set on create) and the project
// settings panel (post-creation edits). Server-side validation is the
// real safety net (see `harness-server::projects::canonicalise_workspaces`);
// the inline `Probe` button is only an aid that lights up the branch
// + dirty state for the path the user just typed in.

import { useState } from "react";
import type { ProjectWorkspace } from "../../types/frames";
import { probeWorkspace, shortenPath, type WorkspaceInfo } from "../../services/workspace";
import { t } from "../../utils/i18n";

interface Props {
  value: ProjectWorkspace[];
  onChange: (next: ProjectWorkspace[]) => void;
  /// When true, render rows as read-only (used by the locked detail
  /// view inside an active chat session).
  readOnly?: boolean;
}

interface RowProbe {
  status: "idle" | "probing" | "ok" | "error";
  info?: WorkspaceInfo;
  error?: string;
}

export function ProjectWorkspacesEditor({ value, onChange, readOnly }: Props) {
  // Per-row probe results, keyed by row index. We use index because
  // rows mutate in place — keeping a parallel array avoids re-keying
  // a Map every render.
  const [probes, setProbes] = useState<RowProbe[]>([]);

  const ensureProbe = (idx: number): RowProbe =>
    probes[idx] ?? { status: "idle" };

  const setProbe = (idx: number, next: RowProbe) => {
    setProbes((prev) => {
      const out = prev.slice();
      out[idx] = next;
      return out;
    });
  };

  const updateRow = (idx: number, patch: Partial<ProjectWorkspace>) => {
    const next = value.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
    // The probe result is no longer authoritative for the new path.
    if (patch.path !== undefined) setProbe(idx, { status: "idle" });
  };

  const addRow = () => {
    onChange([...value, { path: "", name: null }]);
  };

  const removeRow = (idx: number) => {
    const next = value.slice();
    next.splice(idx, 1);
    onChange(next);
    setProbes((prev) => {
      const out = prev.slice();
      out.splice(idx, 1);
      return out;
    });
  };

  const probe = async (idx: number) => {
    const path = value[idx]?.path?.trim();
    if (!path) {
      setProbe(idx, {
        status: "error",
        error: t("projectWorkspaceProbeEmpty"),
      });
      return;
    }
    setProbe(idx, { status: "probing" });
    try {
      const info = await probeWorkspace(path);
      setProbe(idx, { status: "ok", info });
    } catch (e: any) {
      setProbe(idx, {
        status: "error",
        error: e?.message ?? String(e),
      });
    }
  };

  if (readOnly && value.length === 0) {
    return <p className="project-workspaces-empty">{t("projectWorkspaceNone")}</p>;
  }

  return (
    <div className="project-workspaces-editor" role="group">
      {value.map((row, idx) => {
        const probeResult = ensureProbe(idx);
        return (
          <div className="project-workspace-row" key={idx}>
            <input
              className="project-workspace-path"
              type="text"
              value={row.path}
              placeholder={t("projectWorkspacePathPlaceholder")}
              onChange={(e) => updateRow(idx, { path: e.target.value })}
              disabled={!!readOnly}
              spellCheck={false}
            />
            <input
              className="project-workspace-name"
              type="text"
              value={row.name ?? ""}
              placeholder={t("projectWorkspaceNamePlaceholder")}
              onChange={(e) =>
                updateRow(idx, {
                  name: e.target.value.trim() === "" ? null : e.target.value,
                })
              }
              disabled={!!readOnly}
            />
            {!readOnly ? (
              <>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => void probe(idx)}
                  disabled={probeResult.status === "probing"}
                  title={t("projectWorkspaceProbeHint")}
                >
                  {probeResult.status === "probing"
                    ? t("projectWorkspaceProbing")
                    : t("projectWorkspaceProbe")}
                </button>
                <button
                  type="button"
                  className="settings-btn-danger"
                  onClick={() => removeRow(idx)}
                  aria-label={t("projectWorkspaceRemove")}
                >
                  ×
                </button>
              </>
            ) : null}
            <ProbeReadout result={probeResult} />
          </div>
        );
      })}
      {!readOnly ? (
        <button
          type="button"
          className="settings-btn project-workspace-add"
          onClick={addRow}
        >
          {t("projectWorkspaceAdd")}
        </button>
      ) : null}
    </div>
  );
}

function ProbeReadout({ result }: { result: RowProbe }) {
  if (result.status === "idle" || result.status === "probing") {
    return null;
  }
  if (result.status === "error") {
    return (
      <span className="project-workspace-probe project-workspace-probe-error">
        {result.error}
      </span>
    );
  }
  const info = result.info!;
  if (info.vcs === "git") {
    return (
      <span className="project-workspace-probe">
        <span className="project-workspace-probe-branch">
          {info.branch ?? "(detached)"}
        </span>
        {info.dirty ? (
          <span
            className="session-dirty-dot"
            title="dirty worktree"
            aria-hidden="true"
          />
        ) : null}
        <span className="project-workspace-probe-root">{shortenPath(info.root)}</span>
      </span>
    );
  }
  return (
    <span className="project-workspace-probe project-workspace-probe-novcs">
      {t("projectWorkspaceNoVcs")}
    </span>
  );
}

/// Strip empty rows (path blank) before submitting. Shared by the
/// create panel and the settings panel.
export function compactWorkspaces(rows: ProjectWorkspace[]): ProjectWorkspace[] {
  return rows
    .map((r) => ({
      path: r.path.trim(),
      name: r.name?.trim() ? r.name.trim() : null,
    }))
    .filter((r) => r.path.length > 0);
}
