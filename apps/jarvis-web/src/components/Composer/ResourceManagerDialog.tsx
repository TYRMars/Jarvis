// One-stop dialog that replaces the workspace + project + `+` popovers
// in the new-session composer. The user picks a project AND/OR a
// workspace folder; the dialog shapes the result into a
// `NewSessionResourceSelection` that the composer turns into store
// updates and (for the `new_project_from_folder` variant) a
// `POST /v1/projects` call.
//
// Spec: `docs/proposals/new-session-resource-manager.zh-CN.md`.
//
// First-pass UX trade-offs:
//  - Read-only data: projects come from the store cache; recent
//    workspaces from `/v1/workspaces`; per-project workspace status
//    is fetched lazily on selection so we don't spam the server.
//  - The dialog never mutates state directly. On Confirm it calls
//    `onConfirm(selection)` and hands control back to the composer,
//    which decides whether to create a project, link a workspace,
//    or just stash the draft.
//  - Same-name folders are rendered with a `compactResourceLabel`
//    subtitle and deduped by canonical path.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { t } from "../../utils/i18n";
import {
  fetchProjectWorkspaceStatuses,
  refreshProjects,
  type ProjectWorkspaceStatus,
} from "../../services/projects";
import {
  listRecentWorkspaces,
  type RecentWorkspace,
} from "../../services/workspaces";
import {
  probeWorkspace,
  type WorkspaceInfo,
} from "../../services/workspace";
import {
  pickWorkspaceFolder,
  supportsWorkspaceFolderPicker,
} from "../../services/folderPicker";
import { useAppStore } from "../../store/appStore";
import {
  compactResourceLabel,
  dedupeByPath,
  deriveProjectDraftFromWorkspace,
  deriveProjectDraftFromWorkspaces,
  folderNameFromPath,
  matchProjectsForWorkspace,
  resolveDefaultWorkspaceForProject,
  type WorkspaceMatch,
} from "./resourceSelection";
import type {
  NewSessionResourceSelection,
  ResourceDialogTab,
} from "./resourceSelectionTypes";
import type { Project } from "../../types/frames";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (selection: NewSessionResourceSelection) => void;
  initialTab?: ResourceDialogTab;
  /// Server-startup root, used as the fallback workspace when the
  /// user picks a Project that has no `workspaces` of its own.
  baselineWorkspacePath?: string | null;
}

export function ResourceManagerDialog({
  open,
  onClose,
  onConfirm,
  // Default to the Projects tab — projects are the primary unit, and
  // they own their workspace folders. Callers that want a different
  // landing tab (e.g. the composer's "Add context" → folders) pass
  // `initialTab` explicitly.
  initialTab = "projects",
  baselineWorkspacePath,
}: Props) {
  const projects = useAppStore((s) => s.projects).filter((p) => !p.archived);
  const [tab, setTab] = useState<ResourceDialogTab>(initialTab);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<
    string | null
  >(null);
  const [folderInput, setFolderInput] = useState("");
  const [probedFolder, setProbedFolder] = useState<WorkspaceInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  // Extra-folder rows for the Folders tab. The primary input
  // (`folderInput` above) is row 0 conceptually; these are rows 1..N
  // the user added via "+ Add folder". When the array is empty (most
  // common path) the Folders tab behaves exactly as before. Each row
  // has its own probe state so per-row error / match badges are
  // independent.
  type ExtraFolderRow = {
    key: number;
    input: string;
    probed: WorkspaceInfo | null;
    error: string | null;
    probing: boolean;
  };
  const [extraFolderRows, setExtraFolderRows] = useState<ExtraFolderRow[]>([]);
  const [nextExtraKey, setNextExtraKey] = useState(1);
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [projectWorkspaces, setProjectWorkspaces] = useState<
    ProjectWorkspaceStatus[] | null
  >(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset selection state on every open so the dialog never carries
  // a stale draft from the previous interaction.
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelectedProjectId(null);
    setSelectedWorkspacePath(null);
    setFolderInput("");
    setProbedFolder(null);
    setProbeError(null);
    setExtraFolderRows([]);
    setNextExtraKey(1);
    setSearch("");
    setProjectWorkspaces(null);
    void refreshProjects().catch(() => {});
    void listRecentWorkspaces().then(setRecents).catch(() => setRecents([]));
  }, [open, initialTab]);

  // Pull live git status for the selected project's workspaces. The
  // `null` sentinel means "no project picked"; `[]` means "fetched,
  // empty". Cache lives in the projects service; repeated selects
  // hit the cache so this is cheap.
  useEffect(() => {
    if (!selectedProjectId) {
      setProjectWorkspaces(null);
      return;
    }
    void fetchProjectWorkspaceStatuses(selectedProjectId)
      .then(setProjectWorkspaces)
      .catch(() => setProjectWorkspaces([]));
  }, [selectedProjectId]);

  const selectedProject = useMemo<Project | null>(() => {
    if (!selectedProjectId) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const trimmedFolder = folderInput.trim();
  const looksLikePath =
    trimmedFolder.startsWith("/") || trimmedFolder.startsWith("~/");

  const probe = async () => {
    if (!trimmedFolder) return;
    setProbing(true);
    setProbeError(null);
    try {
      const info = await probeWorkspace(trimmedFolder);
      setProbedFolder(info);
      setSelectedWorkspacePath(info.root);
    } catch (e: unknown) {
      setProbeError(errorMessage(e));
      setProbedFolder(null);
    } finally {
      setProbing(false);
    }
  };

  const probeExtraRow = async (key: number) => {
    const row = extraFolderRows.find((r) => r.key === key);
    if (!row || !row.input.trim()) return;
    setExtraFolderRows((rows) =>
      rows.map((r) =>
        r.key === key ? { ...r, probing: true, error: null } : r,
      ),
    );
    try {
      const info = await probeWorkspace(row.input.trim());
      setExtraFolderRows((rows) =>
        rows.map((r) =>
          r.key === key
            ? { ...r, probed: info, probing: false, error: null }
            : r,
        ),
      );
    } catch (e: unknown) {
      setExtraFolderRows((rows) =>
        rows.map((r) =>
          r.key === key
            ? {
                ...r,
                probed: null,
                probing: false,
                error: errorMessage(e),
              }
            : r,
        ),
      );
    }
  };

  // Auto-probe when the user submits the field via Enter — no need
  // for an explicit "Probe" button below the input.
  const onFolderKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void probe();
    }
  };

  /// "Browse…" handler shared between the primary input and each
  /// extra-folder row. Desktop returns an absolute path directly;
  /// browser builds fall back to basename resolution. When multiple
  /// matches come back, the first wins — rows already let the user
  /// adjust by hand.
  const browseFolder = async (
    setOnResolved: (path: string) => void,
  ): Promise<void> => {
    if (!supportsWorkspaceFolderPicker()) {
      setProbeError(t("composerFolderPickerUnsupported"));
      return;
    }
    try {
      const picked = await pickWorkspaceFolder();
      if (!picked.path) return;
      setOnResolved(picked.path);
      if (picked.unresolvedName) {
        setProbeError(
          t("composerFolderPickerNoMatch").replace("{0}", picked.unresolvedName),
        );
      }
    } catch {
      // User cancelled — no-op.
    }
  };
  const browseSupported = supportsWorkspaceFolderPicker();

  const folderMatch: WorkspaceMatch = useMemo(() => {
    if (!probedFolder) return { kind: "none" };
    const basename = folderNameFromPath(probedFolder.root);
    return matchProjectsForWorkspace(projects, probedFolder.root, basename);
  }, [projects, probedFolder]);

  // Probed folders from the extra-rows editor. When the user has
  // added one or more "+ Add folder" rows AND probed them, this is
  // the list of `{root}` they want bundled into a new project.
  const extraProbedRoots = useMemo(
    () =>
      extraFolderRows
        .filter((r) => r.probed !== null)
        .map((r) => r.probed!.root),
    [extraFolderRows],
  );
  // Total folder count = primary (if probed) + extra (probed). Drives
  // the "1-folder vs N-folder" branching in `buildSelection`.
  const totalProbedFolders = useMemo(() => {
    const roots: string[] = [];
    if (probedFolder) roots.push(probedFolder.root);
    roots.push(...extraProbedRoots);
    // Dedup in case the user pasted the same path twice.
    return Array.from(new Set(roots));
  }, [probedFolder, extraProbedRoots]);

  // Confirm enabled when:
  //  - existing project + (any) workspace path resolved;
  //  - single probed folder, with a non-ambiguous match;
  //  - 2+ probed folders, in which case we always create a new project.
  // Ambiguous-match still disables Confirm until the user clicks one row.
  const canConfirm =
    !!selectedProject ||
    (totalProbedFolders.length >= 2) ||
    (probedFolder !== null && folderMatch.kind !== "name_match_ambiguous");

  const buildSelection = (): NewSessionResourceSelection | null => {
    if (selectedProject) {
      const path =
        selectedWorkspacePath ??
        resolveDefaultWorkspaceForProject(
          selectedProject,
          baselineWorkspacePath ?? null,
        );
      return {
        mode: "existing_project",
        projectId: selectedProject.id,
        workspacePath: path,
      };
    }
    // Multi-folder fast path. When the user has bundled 2+ probed
    // folders, we always create a fresh project containing all of
    // them — match logic doesn't apply cleanly to a multi-folder set
    // (folder A might match project X while folder B matches Y).
    // The first folder drives the project name + slug; instructions
    // enumerate every workspace.
    if (totalProbedFolders.length >= 2) {
      return {
        mode: "new_project_from_folder",
        projectDraft: deriveProjectDraftFromWorkspaces(totalProbedFolders),
        workspacePaths: totalProbedFolders,
      };
    }
    if (probedFolder) {
      if (folderMatch.kind === "path_match") {
        return {
          mode: "existing_project",
          projectId: folderMatch.project.id,
          workspacePath: folderMatch.workspace.path,
        };
      }
      if (folderMatch.kind === "name_match_unique") {
        return {
          mode: "existing_project",
          projectId: folderMatch.project.id,
          workspacePath: probedFolder.root,
        };
      }
      if (folderMatch.kind === "name_match_ambiguous") return null; // user must disambiguate
      return {
        mode: "new_project_from_folder",
        projectDraft: deriveProjectDraftFromWorkspace({
          root: probedFolder.root,
          branch: probedFolder.branch ?? null,
        }),
        workspacePaths: [probedFolder.root],
      };
    }
    return null;
  };

  const onConfirmClick = () => {
    const sel = buildSelection();
    if (!sel) return;
    setBusy(true);
    try {
      onConfirm(sel);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // ---------------- Rendering ----------------

  const filteredProjects = projects.filter((p) =>
    !search.trim()
      ? true
      : p.name.toLowerCase().includes(search.trim().toLowerCase()) ||
        p.slug.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const recentRows = dedupeByPath(recents.map((r) => ({ path: r.path, recent: r })));

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={t("resourceDialogTitle")}
      size="lg"
      busy={busy}
    >
      {/* Subtitle gives users a one-liner about what each tab does so
          the dialog reads as a "start here" surface, not a settings
          form. Lives inside the modal body (not the title area) so the
          existing modal chrome stays untouched. */}
      <p className="resource-dialog-subtitle">{t("resourceDialogSubtitle")}</p>
      <div className="resource-dialog-body">
        <input
          type="search"
          className="resource-dialog-search"
          placeholder={t("resourceDialogSearch")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="resource-dialog-tabs" role="tablist">
          {(["recent", "projects", "folders"] as ResourceDialogTab[]).map(
            (k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={"resource-dialog-tab" + (tab === k ? " active" : "")}
                onClick={() => setTab(k)}
              >
                {tabLabel(k)}
              </button>
            ),
          )}
        </div>

        <div className="resource-dialog-grid">
          <div className="resource-dialog-list">
            {tab === "recent" && (
              <RecentList
                rows={recentRows}
                selected={selectedWorkspacePath}
                onSelect={(path) => {
                  setSelectedWorkspacePath(path);
                  setFolderInput(path);
                  void probeWorkspace(path)
                    .then(setProbedFolder)
                    .catch(() => setProbedFolder(null));
                }}
              />
            )}
            {tab === "projects" && (
              <ProjectsList
                projects={filteredProjects}
                selectedId={selectedProjectId}
                onSelect={(p) => {
                  setSelectedProjectId(p.id);
                  setSelectedWorkspacePath(
                    resolveDefaultWorkspaceForProject(
                      p,
                      baselineWorkspacePath ?? null,
                    ),
                  );
                  setProbedFolder(null);
                  setFolderInput("");
                }}
              />
            )}
            {tab === "folders" && (
              <FolderTab
                folderInput={folderInput}
                onFolderInput={setFolderInput}
                onKeyDown={onFolderKeyDown}
                onProbe={() => void probe()}
                onBrowse={
                  browseSupported
                    ? () => void browseFolder(setFolderInput)
                    : undefined
                }
                probing={probing}
                probedFolder={probedFolder}
                probeError={probeError}
                looksLikePath={looksLikePath}
                folderMatch={folderMatch}
                onPickAmbiguous={(p) => {
                  setSelectedProjectId(p.id);
                  setSelectedWorkspacePath(probedFolder?.root ?? null);
                }}
                extraRows={extraFolderRows}
                onAddExtraRow={() => {
                  setExtraFolderRows((rows) => [
                    ...rows,
                    {
                      key: nextExtraKey,
                      input: "",
                      probed: null,
                      error: null,
                      probing: false,
                    },
                  ]);
                  setNextExtraKey((k) => k + 1);
                }}
                onExtraRowInput={(key, value) => {
                  setExtraFolderRows((rows) =>
                    rows.map((r) =>
                      r.key === key ? { ...r, input: value } : r,
                    ),
                  );
                }}
                onExtraRowRemove={(key) => {
                  setExtraFolderRows((rows) =>
                    rows.filter((r) => r.key !== key),
                  );
                }}
                onExtraRowProbe={(key) => void probeExtraRow(key)}
                totalProbedCount={totalProbedFolders.length}
                onExtraRowBrowse={
                  browseSupported
                    ? (key) =>
                        void browseFolder((path) => {
                          setExtraFolderRows((rows) =>
                            rows.map((r) =>
                              r.key === key ? { ...r, input: path } : r,
                            ),
                          );
                        })
                    : undefined
                }
              />
            )}
          </div>

          <aside className="resource-dialog-preview">
            <SelectionPreview
              project={selectedProject}
              projectWorkspaces={projectWorkspaces}
              selectedWorkspacePath={selectedWorkspacePath}
              onPickWorkspace={setSelectedWorkspacePath}
              probedFolder={probedFolder}
              folderMatch={folderMatch}
            />
          </aside>
        </div>
      </div>

      {/* Footer: Cancel (escape hatch) + primary Confirm. Free-chat
          mode lives on a separate composer chip, so this dialog stays
          a pure picker — there's no need for a tertiary action here.
          Cancel just closes; the user keeps whatever binding they had
          before opening the dialog. */}
      <footer className="resource-dialog-footer">
        <button
          type="button"
          className="resource-dialog-btn"
          onClick={onClose}
          disabled={busy}
        >
          {t("resourceDialogCancel")}
        </button>
        <span className="resource-dialog-footer-spacer" />
        <button
          type="button"
          className="resource-dialog-btn primary"
          onClick={onConfirmClick}
          disabled={busy || !canConfirm}
        >
          {t("resourceDialogConfirm")}
        </button>
      </footer>
    </Modal>
  );
}

// ---- subviews ------------------------------------------------------

function tabLabel(k: ResourceDialogTab): string {
  switch (k) {
    case "recent":
      return t("resourceDialogTabRecent");
    case "projects":
      return t("resourceDialogTabProjects");
    case "folders":
      return t("resourceDialogTabFolders");
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function RecentList({
  rows,
  selected,
  onSelect,
}: {
  rows: { path: string; recent: RecentWorkspace }[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="resource-dialog-empty">
        {t("resourceDialogRecentEmpty")}
      </p>
    );
  }
  return (
    <ul className="resource-dialog-rows">
      {rows.map((r) => {
        const name = folderNameFromPath(r.path);
        return (
          <li
            key={r.path}
            className={
              "resource-dialog-row" + (selected === r.path ? " selected" : "")
            }
          >
            <button
              type="button"
              className="resource-dialog-row-button"
              onClick={() => onSelect(r.path)}
            >
              <strong className="resource-dialog-row-title">{name}</strong>
              <span className="resource-dialog-row-sub">
                {compactResourceLabel(r.path)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectsList({
  projects,
  selectedId,
  onSelect,
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (p: Project) => void;
}) {
  if (projects.length === 0) {
    return (
      <p className="resource-dialog-empty">
        {t("resourceDialogProjectsEmpty")}
      </p>
    );
  }
  return (
    <ul className="resource-dialog-rows">
      {projects.map((p) => {
        const folders = p.workspaces?.length ?? 0;
        const sub =
          folders === 0
            ? t("resourceDialogProjectNoFoldersInline").replace("{0}", p.slug)
            : (folders === 1
                ? t("resourceDialogProjectFolderCount")
                : t("resourceDialogProjectFolderCountPlural")
              )
                .replace("{0}", String(folders))
                .replace("{1}", p.slug);
        return (
          <li
            key={p.id}
            className={
              "resource-dialog-row" + (selectedId === p.id ? " selected" : "")
            }
          >
            <button
              type="button"
              className="resource-dialog-row-button"
              onClick={() => onSelect(p)}
            >
              <strong className="resource-dialog-row-title">{p.name}</strong>
              <span className="resource-dialog-row-sub">{sub}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FolderTab({
  folderInput,
  onFolderInput,
  onKeyDown,
  onProbe,
  onBrowse,
  probing,
  probedFolder,
  probeError,
  looksLikePath,
  folderMatch,
  onPickAmbiguous,
  extraRows,
  onAddExtraRow,
  onExtraRowInput,
  onExtraRowRemove,
  onExtraRowProbe,
  onExtraRowBrowse,
  totalProbedCount,
}: {
  folderInput: string;
  onFolderInput: (s: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onProbe: () => void;
  /// `undefined` when `window.showDirectoryPicker` isn't available
  /// (Safari / Firefox). The Browse button is hidden in that case.
  onBrowse?: () => void;
  probing: boolean;
  probedFolder: WorkspaceInfo | null;
  probeError: string | null;
  looksLikePath: boolean;
  folderMatch: WorkspaceMatch;
  onPickAmbiguous: (p: Project) => void;
  extraRows: Array<{
    key: number;
    input: string;
    probed: WorkspaceInfo | null;
    error: string | null;
    probing: boolean;
  }>;
  onAddExtraRow: () => void;
  onExtraRowInput: (key: number, value: string) => void;
  onExtraRowRemove: (key: number) => void;
  onExtraRowProbe: (key: number) => void;
  /// Same gate as `onBrowse`: undefined hides the per-row Browse
  /// button on browsers without the OS picker API.
  onExtraRowBrowse?: (key: number) => void;
  totalProbedCount: number;
}) {
  return (
    <div className="resource-dialog-folder-tab">
      <label className="resource-dialog-folder-label">
        {t("resourceDialogFoldersLabel")}
        <input
          type="text"
          className="resource-dialog-folder-input"
          placeholder={t("resourceDialogFoldersPlaceholder")}
          value={folderInput}
          onChange={(e) => onFolderInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="resource-dialog-folder-actions">
        {onBrowse && (
          <button
            type="button"
            className="resource-dialog-btn"
            onClick={onBrowse}
            disabled={probing}
          >
            {t("composerFolderPickerBrowse")}
          </button>
        )}
        <button
          type="button"
          className="resource-dialog-btn"
          onClick={onProbe}
          disabled={probing || !looksLikePath}
        >
          {probing ? t("resourceDialogProbeBusy") : t("resourceDialogProbeBtn")}
        </button>
      </div>
      {probeError && (
        <p className="resource-dialog-error">
          {t("resourceDialogProbeError").replace("{0}", probeError)}
        </p>
      )}
      {probedFolder && (
        <div className="resource-dialog-probed">
          <p>
            <code>{probedFolder.root}</code>
          </p>
          {probedFolder.vcs === "git" && (
            <p>
              {t("resourceDialogVcsGit")
                .replace(
                  "{0}",
                  probedFolder.branch ?? t("resourceDialogVcsBranchDetached"),
                )
                .replace(
                  "{1}",
                  probedFolder.dirty
                    ? t("resourceDialogVcsDirty")
                    : t("resourceDialogVcsClean"),
                )}
            </p>
          )}
          {folderMatch.kind === "path_match" && (
            <p>
              {t("resourceDialogMatchPath").replace(
                "{0}",
                folderMatch.project.name,
              )}
            </p>
          )}
          {folderMatch.kind === "name_match_unique" && (
            <p>
              {t("resourceDialogMatchName").replace(
                "{0}",
                folderMatch.project.name,
              )}
            </p>
          )}
          {folderMatch.kind === "name_match_ambiguous" && (
            <div>
              <p>{t("resourceDialogMatchAmbiguous")}</p>
              <ul className="resource-dialog-rows">
                {folderMatch.projects.map((p) => (
                  <li key={p.id} className="resource-dialog-row">
                    <button
                      type="button"
                      className="resource-dialog-row-button"
                      onClick={() => onPickAmbiguous(p)}
                    >
                      <strong>{p.name}</strong>
                      <span className="resource-dialog-row-sub">
                        {p.slug}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {folderMatch.kind === "none" && (
            <p>
              {t("resourceDialogMatchNone").replace(
                "{0}",
                folderNameFromPath(probedFolder.root),
              )}
            </p>
          )}
        </div>
      )}

      {/* Extra-folder rows. The first input above is always row 0;
          everything in `extraRows` is rendered as additional rows
          (each with its own input, Probe button, remove button, and
          per-row error / status). The "+ Add folder" button always
          appears so the user can grow the list at any point. */}
      {extraRows.length > 0 && (
        <ul className="resource-dialog-folder-rows">
          {extraRows.map((row) => {
            const trimmed = row.input.trim();
            const looksOk = trimmed.startsWith("/") || trimmed.startsWith("~/");
            return (
              <li key={row.key} className="resource-dialog-folder-row">
                <input
                  type="text"
                  className="resource-dialog-folder-input"
                  placeholder={t("resourceDialogFoldersPlaceholder")}
                  value={row.input}
                  onChange={(e) => onExtraRowInput(row.key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onExtraRowProbe(row.key);
                    }
                  }}
                />
                {onExtraRowBrowse && (
                  <button
                    type="button"
                    className="resource-dialog-btn"
                    onClick={() => onExtraRowBrowse(row.key)}
                    disabled={row.probing}
                  >
                    {t("composerFolderPickerBrowse")}
                  </button>
                )}
                <button
                  type="button"
                  className="resource-dialog-btn"
                  onClick={() => onExtraRowProbe(row.key)}
                  disabled={row.probing || !looksOk}
                >
                  {row.probing
                    ? t("resourceDialogProbeBusy")
                    : t("resourceDialogProbeBtn")}
                </button>
                <button
                  type="button"
                  className="resource-dialog-btn ghost"
                  onClick={() => onExtraRowRemove(row.key)}
                  aria-label={t("resourceDialogFolderRemove")}
                  title={t("resourceDialogFolderRemove")}
                >
                  ×
                </button>
                {row.error && (
                  <p className="resource-dialog-error resource-dialog-folder-row-status">
                    {t("resourceDialogProbeError").replace("{0}", row.error)}
                  </p>
                )}
                {row.probed && (
                  <p className="resource-dialog-folder-row-status">
                    <code>{row.probed.root}</code>
                    {row.probed.vcs === "git" && (
                      <>
                        {" · "}
                        {t("resourceDialogVcsGit")
                          .replace(
                            "{0}",
                            row.probed.branch ??
                              t("resourceDialogVcsBranchDetached"),
                          )
                          .replace(
                            "{1}",
                            row.probed.dirty
                              ? t("resourceDialogVcsDirty")
                              : t("resourceDialogVcsClean"),
                          )}
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        className="resource-dialog-btn ghost resource-dialog-folder-addrow"
        onClick={onAddExtraRow}
      >
        {t("resourceDialogFolderAddRow")}
      </button>

      {totalProbedCount >= 2 && (
        <p className="resource-dialog-folder-multihint">
          {t("resourceDialogWillCreateMulti")
            .replace(
              "{0}",
              folderNameFromPath(probedFolder?.root ?? "") || "untitled",
            )
            .replace("{1}", String(totalProbedCount))}
        </p>
      )}
    </div>
  );
}

function SelectionPreview({
  project,
  projectWorkspaces,
  selectedWorkspacePath,
  onPickWorkspace,
  probedFolder,
  folderMatch,
}: {
  project: Project | null;
  projectWorkspaces: ProjectWorkspaceStatus[] | null;
  selectedWorkspacePath: string | null;
  onPickWorkspace: (path: string) => void;
  probedFolder: WorkspaceInfo | null;
  folderMatch: WorkspaceMatch;
}) {
  if (project) {
    const workspaces =
      projectWorkspaces ??
      (project.workspaces?.map<ProjectWorkspaceStatus>((w) => ({
        path: w.path,
        name: w.name ?? null,
        vcs: "unknown",
      })) ??
        []);
    return (
      <div>
        <h4 className="resource-dialog-preview-heading">
          {t("resourceDialogPreviewProject")}
        </h4>
        <p className="resource-dialog-preview-body">
          <strong>{project.name}</strong>
          <br />
          <span>{project.slug}</span>
        </p>
        {workspaces.length === 0 ? (
          <p className="resource-dialog-empty">
            {t("resourceDialogProjectNoFolders")}
          </p>
        ) : (
          <ul className="resource-dialog-rows">
            {dedupeByPath(workspaces).map((w) => (
              <li
                key={w.path}
                className={
                  "resource-dialog-row" +
                  (selectedWorkspacePath === w.path ? " selected" : "")
                }
              >
                <button
                  type="button"
                  className="resource-dialog-row-button"
                  onClick={() => onPickWorkspace(w.path)}
                >
                  <strong>{folderNameFromPath(w.path)}</strong>
                  <span className="resource-dialog-row-sub">
                    {compactResourceLabel(w.path)}
                    {w.vcs === "git" && w.branch && (
                      <>
                        {" · "}
                        {w.branch}
                        {w.dirty ? " · dirty" : ""}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (probedFolder) {
    return (
      <div>
        <h4 className="resource-dialog-preview-heading">
          {t("resourceDialogPreviewFolder")}
        </h4>
        <p className="resource-dialog-preview-body">
          <code>{probedFolder.root}</code>
        </p>
        <p className="resource-dialog-preview-body">
          {folderMatch.kind === "path_match" &&
            t("resourceDialogReuseProject").replace(
              "{0}",
              folderMatch.project.name,
            )}
          {folderMatch.kind === "name_match_unique" &&
            t("resourceDialogAddFolderTo").replace(
              "{0}",
              folderMatch.project.name,
            )}
          {folderMatch.kind === "name_match_ambiguous" &&
            t("resourceDialogPickProject")}
          {folderMatch.kind === "none" &&
            t("resourceDialogWillCreate").replace(
              "{0}",
              folderNameFromPath(probedFolder.root),
            )}
        </p>
      </div>
    );
  }
  return (
    <p className="resource-dialog-empty">{t("resourceDialogPickHint")}</p>
  );
}
