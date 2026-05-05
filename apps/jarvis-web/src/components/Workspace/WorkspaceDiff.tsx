// Right-rail "Code Review" card. Mirrors the Claude Code worktree
// review surface: branch crumb (`base ← branch`), aggregate +/- and
// file-count badges, ahead/behind counts, an uncommitted-changes
// warning, plus a scrollable file list. Clicking a file lazy-loads
// its unified diff via `UnifiedDiffViewer`.
//
// Two CR action buttons live in the footer; both prefill the
// composer with a synthetic prompt rather than auto-sending. Same
// pattern as `ProjectChecksCard.tsx` — the user is always the one
// who clicks Send, which keeps the existing approval gates and
// audit trail in charge.
//
//   • "Review with Jarvis" → asks the agent to read the diff and
//     surface bugs / risks / style nits.
//   • "Suggest commit message" → asks the agent to read the diff
//     and produce a Conventional Commits message.
//
// Direct commit / Create PR actions are deliberately deferred —
// they need a `git.commit` / `gh pr create` tool registration
// path with its own approval flow. v1 keeps the surface read-only.

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import {
  fetchFileDiff,
  fetchWorkspaceDiff,
  refreshWorkspaceDiff,
  type DiffFileEntry,
  type WorkspaceDiff as WorkspaceDiffData,
} from "../../services/workspaceDiff";
import type { ProjectWorkspace } from "../../types/frames";
import { UnifiedDiffViewer } from "../Chat/UnifiedDiffViewer";
import { t } from "../../utils/i18n";
import { CommitDialog } from "./CommitDialog";
import { CreatePrDialog } from "./CreatePrDialog";

interface DiffRootDescriptor {
  /// Absolute filesystem path; passed as `?root=` to the API. Null
  /// means "let the server use its pinned default" — used in the
  /// fallback single-root case where no project / active path is set.
  path: string | null;
  /// Display name. Folder basename for multi-folder projects, just
  /// the basename of the active path otherwise.
  label: string;
}

function basename(p: string | null): string {
  if (!p) return "";
  const stripped = p.replace(/[\\/]+$/, "");
  const i = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return i >= 0 ? stripped.slice(i + 1) : stripped;
}

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const CR_REVIEW_PROMPT = (base: string, branch: string | null): string =>
  `Please review the diff between \`${base}\` and \`${branch ?? "HEAD"}\`. ` +
  `Use \`workspace.context\` first if needed, then \`git.diff\` to inspect ` +
  `the actual hunks (you may want \`git.diff\` with a path filter for the ` +
  `largest files). Surface bugs, security issues, missing tests, and ` +
  `obvious style nits. End with a short approval recommendation.`;

const CR_COMMIT_MSG_PROMPT = (base: string): string =>
  `Please read the working-tree diff via \`git.diff\` (and \`git.diff --cached\` ` +
  `if there are staged changes), then propose a Conventional Commits message ` +
  `for it. Format: a single subject line under 72 chars, blank line, ` +
  `wrapped body explaining the why. Compare against \`${base}\` for context ` +
  `if useful. Output the message in a code block so I can copy it.`;

export function WorkspaceDiff() {
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const projectsById = useAppStore((s) => s.projectsById);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const activeRoot = socketWorkspace ?? draftWorkspacePath ?? null;

  // Resolve the list of folders to diff. Multi-folder projects
  // (project.workspaces.length > 1) get one collapsible section per
  // folder. Single-folder / no-project falls back to the legacy
  // store-backed flow so the count badge + composer shoulder keep
  // working unchanged.
  const roots = useMemo<DiffRootDescriptor[]>(() => {
    const project = draftProjectId ? projectsById[draftProjectId] : null;
    const workspaces: ProjectWorkspace[] = project?.workspaces ?? [];
    if (workspaces.length > 1) {
      return workspaces.map((w) => ({
        path: w.path,
        label: w.name || basename(w.path) || w.path,
      }));
    }
    return [
      {
        path: activeRoot,
        label: basename(activeRoot) || tx("wsDiffSingleRoot", "workspace"),
      },
    ];
  }, [draftProjectId, projectsById, activeRoot]);

  if (roots.length > 1) {
    return (
      <div className="ws-diff ws-diff-multi">
        {roots.map((r) => (
          <WorkspaceDiffRoot
            key={r.path ?? "(default)"}
            root={r}
            // First folder expanded by default so the user sees
            // something on first render; the rest are collapsed
            // pills the user can drill into.
            initiallyOpen={false}
          />
        ))}
      </div>
    );
  }

  return <WorkspaceDiffSingleStore />;
}

/// Single-folder render path. Same store-backed flow as before so
/// `WorkspaceDiffCount` (which reads from `s.workspaceDiff`) stays
/// in sync with the rendered card.
function WorkspaceDiffSingleStore() {
  const diff = useAppStore((s) => s.workspaceDiff);
  const loading = useAppStore((s) => s.workspaceDiffLoading);
  const setWorkspaceDiff = useAppStore((s) => s.setWorkspaceDiff);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const activeRoot = socketWorkspace ?? draftWorkspacePath ?? null;

  useEffect(() => {
    setWorkspaceDiff(null);
    void refreshWorkspaceDiff();
  }, [activeRoot, setWorkspaceDiff]);

  if (diff === "unavailable") return null;
  if (diff == null) {
    return (
      <div className="ws-diff">
        <div className="ws-diff-empty">{loading ? t("wsDiffLoading") : "…"}</div>
      </div>
    );
  }
  return <WorkspaceDiffBody diff={diff} loading={loading} onRefresh={() => void refreshWorkspaceDiff(diff.base)} />;
}

/// Per-root section in the multi-folder layout. Each instance owns
/// its own fetch state — independent of the appStore — so refreshing
/// folder A doesn't blank folder B's expanded file list.
function WorkspaceDiffRoot({
  root,
  initiallyOpen,
}: {
  root: DiffRootDescriptor;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [diff, setDiff] = useState<WorkspaceDiffData | "unavailable" | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = (base?: string) => {
    setLoading(true);
    void fetchWorkspaceDiff(root.path, base).then((res) => {
      setDiff(res);
      setLoading(false);
    });
  };

  // Auto-load when first expanded so the section header shows the
  // count, but don't fetch every folder eagerly on mount.
  useEffect(() => {
    if (!open || diff != null) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-fetch when the folder path changes (project switch).
  useEffect(() => {
    setDiff(null);
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.path]);

  const stat = diff && diff !== "unavailable" ? diff.stat : null;
  const branchLabel = diff && diff !== "unavailable" ? diff.branch ?? "HEAD" : null;

  return (
    <section className="ws-diff-folder">
      <button
        type="button"
        className="ws-diff-folder-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="files-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        <span className="ws-diff-folder-name" title={root.path ?? ""}>{root.label}</span>
        {branchLabel ? <span className="ws-diff-folder-branch">{branchLabel}</span> : null}
        {stat ? (
          <span className="ws-diff-folder-stat">
            <span className="ws-diff-stat-add">+{stat.added}</span>
            <span className="ws-diff-stat-del">−{stat.removed}</span>
            <span className="ws-diff-stat-files">{t("wsDiffFiles", stat.files)}</span>
          </span>
        ) : diff === "unavailable" ? (
          <span className="ws-diff-folder-stat">{tx("wsDiffNotGit", "not a git repo")}</span>
        ) : null}
      </button>
      {open ? (
        diff === "unavailable" ? (
          <div className="ws-diff-empty">{tx("wsDiffNotGitBody", "This folder is not a git repository.")}</div>
        ) : diff == null ? (
          <div className="ws-diff-empty">{loading ? t("wsDiffLoading") : "…"}</div>
        ) : (
          <WorkspaceDiffBody
            diff={diff}
            loading={loading}
            onRefresh={(base) => refresh(base)}
            root={root.path ?? undefined}
          />
        )
      ) : null}
    </section>
  );
}

function WorkspaceDiffBody({
  diff,
  loading,
  onRefresh,
  root,
}: {
  diff: WorkspaceDiffData;
  loading: boolean;
  onRefresh: (base?: string) => void;
  /// When set, the body is rendered inside a per-folder section in
  /// the multi-folder layout — `FileRow`s scope their per-file
  /// fetches to this root and the refresh button targets it. Absent
  /// in the legacy single-folder flow.
  root?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [baseDraft, setBaseDraft] = useState(diff.base);
  const [editingBase, setEditingBase] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const setComposerValue = useAppStore((s) => s.setComposerValue);
  const composerValue = useAppStore((s) => s.composerValue);

  // Reset draft when the underlying diff payload swaps bases.
  useEffect(() => {
    setBaseDraft(diff.base);
  }, [diff.base]);

  const hasUncommitted =
    diff.uncommitted.added + diff.uncommitted.removed + diff.uncommitted.files > 0;

  const sortedFiles = useMemo(() => {
    // Stable sort by aggregate change (largest first), then by path.
    return [...diff.files].sort((a, b) => {
      const aSize = a.added + a.removed;
      const bSize = b.added + b.removed;
      if (aSize !== bSize) return bSize - aSize;
      return a.path.localeCompare(b.path);
    });
  }, [diff.files]);

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function injectPrompt(prompt: string): void {
    const prefix = composerValue.trim().length === 0 ? "" : composerValue + "\n\n";
    setComposerValue(prefix + prompt);
    document.getElementById("input")?.focus();
  }

  function applyBaseDraft(): void {
    const next = baseDraft.trim();
    if (!next) return;
    setEditingBase(false);
    if (next !== diff.base) onRefresh(next);
  }

  return (
    <div className="ws-diff">
      <div className="ws-diff-header">
        <div className="ws-diff-branches">
          {editingBase ? (
            <input
              className="ws-diff-base-input"
              value={baseDraft}
              autoFocus
              onChange={(e) => setBaseDraft(e.target.value)}
              onBlur={applyBaseDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyBaseDraft();
                } else if (e.key === "Escape") {
                  setEditingBase(false);
                  setBaseDraft(diff.base);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="ws-diff-base-btn"
              title={t("wsDiffBaseEditHint")}
              onClick={() => setEditingBase(true)}
            >
              {diff.base}
            </button>
          )}
          <span className="ws-diff-arrow" aria-hidden="true">
            ←
          </span>
          <span className="ws-diff-branch" title={diff.branch ?? ""}>
            {diff.branch ?? "HEAD"}
          </span>
          {diff.head ? <code className="ws-diff-head">{diff.head}</code> : null}
        </div>
        <div className="ws-diff-actions">
          <button
            type="button"
            className="ws-diff-refresh"
            disabled={loading}
            title={t("wsDiffRefresh")}
            onClick={() => onRefresh(diff.base)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="ws-diff-stats">
        {diff.base_exists ? (
          <>
            <span className="ws-diff-stat-add">+{diff.stat.added}</span>
            <span className="ws-diff-stat-del">−{diff.stat.removed}</span>
            <span className="ws-diff-stat-files">{t("wsDiffFiles", diff.stat.files)}</span>
            {diff.ahead > 0 || diff.behind > 0 ? (
              <span className="ws-diff-ahead-behind">
                {diff.ahead > 0 ? `↑${diff.ahead}` : ""}
                {diff.ahead > 0 && diff.behind > 0 ? " " : ""}
                {diff.behind > 0 ? `↓${diff.behind}` : ""}
              </span>
            ) : null}
          </>
        ) : (
          <span className="ws-diff-no-base">{t("wsDiffNoBase", diff.base)}</span>
        )}
      </div>

      {hasUncommitted ? (
        <UncommittedSection
          summary={diff.uncommitted}
          base={diff.base}
          root={root}
        />
      ) : null}

      {sortedFiles.length === 0 ? (
        <div className="ws-diff-empty">{t("wsDiffEmpty")}</div>
      ) : (
        <ul className="ws-diff-files">
          {sortedFiles.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              base={diff.base}
              expanded={expanded.has(f.path)}
              onToggle={() => toggle(f.path)}
              root={root}
            />
          ))}
        </ul>
      )}

      <div className="ws-diff-footer">
        {/* Primary actions — equal-width row. Both go through their
         * own modal dialogs which run direct REST commit / push +
         * `gh pr create`. PR also exists in the composer shoulder;
         * Commit lives only here. */}
        <div className="ws-diff-actions-primary">
          <button
            type="button"
            className="ws-diff-btn ws-diff-btn-primary"
            disabled={!hasUncommitted}
            onClick={() => setCommitOpen(true)}
            title={
              hasUncommitted ? t("wsDiffCommitHint") : t("wsDiffCommitDisabledHint")
            }
          >
            {t("wsDiffCommit")}
          </button>
          <button
            type="button"
            className="ws-diff-btn ws-diff-btn-secondary"
            disabled={!diff.base_exists || diff.ahead === 0}
            onClick={() => setPrOpen(true)}
            title={
              diff.ahead === 0 ? t("wsDiffCreatePrDisabledHint") : t("wsDiffCreatePrHint")
            }
          >
            {t("wsDiffCreatePr")}
          </button>
        </div>

        {/* AI helpers — subtle row, prefixed with a sparkle so the
         * user reads them as "ask Jarvis" affordances rather than
         * direct actions. They prefill the composer (no auto-send),
         * preserving the user's full control. */}
        <div className="ws-diff-actions-ai">
          <button
            type="button"
            className="ws-diff-ai-btn"
            onClick={() => injectPrompt(CR_REVIEW_PROMPT(diff.base, diff.branch))}
            title={t("wsDiffReviewHint")}
          >
            <AiSparkleIcon />
            <span>{t("wsDiffReview")}</span>
          </button>
          <button
            type="button"
            className="ws-diff-ai-btn"
            onClick={() => injectPrompt(CR_COMMIT_MSG_PROMPT(diff.base))}
            title={t("wsDiffSuggestCommitHint")}
          >
            <AiSparkleIcon />
            <span>{t("wsDiffSuggestCommit")}</span>
          </button>
        </div>
      </div>

      <CommitDialog
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        uncommittedFiles={diff.uncommitted.files}
        uncommittedAdded={diff.uncommitted.added}
        uncommittedRemoved={diff.uncommitted.removed}
      />

      <CreatePrDialog
        open={prOpen}
        onClose={() => setPrOpen(false)}
        base={diff.base}
      />
    </div>
  );
}

/// Working-tree (uncommitted) file list. Replaces the old single-line
/// "65 files uncommitted" warning — that aggregate hid the actual
/// content the user wants to inspect on a typical "I haven't committed
/// yet" branch. Entries come from `diff.uncommitted.entries` (new in
/// the v2 wire); older servers (< this build) only ship the aggregate
/// counts and we fall back to the legacy banner.
function UncommittedSection({
  summary,
  base,
  root,
}: {
  summary: import("../../services/workspaceDiff").UncommittedSummary;
  base: string;
  root?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Default-collapsed when there are committed changes (the user's
  // primary view), default-expanded when the working-tree IS the
  // change set (no committed delta yet — the common branch state).
  const [open, setOpen] = useState(true);
  const entries = summary.entries ?? [];

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section className="ws-diff-uncommitted-section">
      <button
        type="button"
        className="ws-diff-uncommitted ws-diff-uncommitted-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t("wsDiffUncommittedHint")}
      >
        <span className="ws-diff-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span aria-hidden="true">⚠</span>
        <span className="ws-diff-uncommitted-label">
          {t("wsDiffUncommitted", summary.files, summary.added, summary.removed)}
        </span>
      </button>
      {open && entries.length > 0 ? (
        <ul className="ws-diff-files ws-diff-files-uncommitted">
          {entries.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              base={base}
              expanded={expanded.has(f.path)}
              onToggle={() => toggle(f.path)}
              root={root}
              uncommitted
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function FileRow({
  file,
  base,
  expanded,
  onToggle,
  root,
  uncommitted = false,
}: {
  file: DiffFileEntry;
  base: string;
  expanded: boolean;
  onToggle: () => void;
  /// When set, per-file fetches are scoped to this folder via
  /// `?root=<root>` and cached separately so two folders touching the
  /// same relative path don't collide. The store-backed
  /// single-folder flow leaves this undefined and uses the legacy
  /// shared `workspaceDiffFileCache` keyed by `<base>::<path>`.
  root?: string;
  /// Tells the per-file fetch to ask for the working-tree (HEAD vs.
  /// unstaged + staged) diff instead of the committed-vs-base one.
  /// Cache key includes the flag so a file that exists in both views
  /// renders distinct hunks.
  uncommitted?: boolean;
}) {
  const cacheKey = `${root ?? ""}::${uncommitted ? "wt" : "head"}::${base}::${file.path}`;
  const storeCache = useAppStore((s) => s.workspaceDiffFileCache[cacheKey]);
  const setEntry = useAppStore((s) => s.setWorkspaceDiffFileEntry);
  const [localCached, setLocalCached] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cached = root ? localCached : storeCache;

  // Lazy fetch when first expanded. Multi-folder mode uses local
  // state so refreshing folder A doesn't blow folder B's open
  // hunks — single-folder mode keeps the legacy store cache.
  useEffect(() => {
    if (!expanded || cached != null || loading) return;
    setLoading(true);
    void fetchFileDiff(base, file.path, root, uncommitted).then((diff) => {
      if (diff != null) {
        if (root) {
          setLocalCached(diff);
        } else {
          setEntry(cacheKey, diff);
        }
      }
      setLoading(false);
    });
  }, [expanded, cached, loading, base, file.path, cacheKey, setEntry, root, uncommitted]);

  return (
    <li className="ws-diff-file" data-status={file.status}>
      <button type="button" className="ws-diff-file-row" onClick={onToggle}>
        <span className="ws-diff-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className={`ws-diff-status ws-diff-status-${file.status}`}>{file.status}</span>
        <span className="ws-diff-path" title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}>
          {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
        </span>
        <span className="ws-diff-file-add">+{file.added}</span>
        <span className="ws-diff-file-del">−{file.removed}</span>
      </button>
      {expanded ? (
        <div className="ws-diff-file-body">
          {cached != null ? (
            cached.length > 0 ? (
              <UnifiedDiffViewer content={cached} />
            ) : (
              <div className="ws-diff-empty">{t("wsDiffFileEmpty")}</div>
            )
          ) : (
            <div className="ws-diff-empty">{t("wsDiffLoading")}</div>
          )}
        </div>
      ) : null}
    </li>
  );
}

/// Compact count rendered next to the section title in
/// `AppWorkspaceRail` so the user sees the file count without
/// expanding the card. v1 just reflects the store-backed primary
/// folder — in multi-folder projects the per-folder counts live
/// inside each section header. Wiring an aggregate count would
/// require fetching every folder eagerly on mount, which we
/// deliberately avoid (the right rail must stay snappy with many
/// folders).
export function WorkspaceDiffCount() {
  const diff = useAppStore((s) => s.workspaceDiff);
  if (diff == null || diff === "unavailable") return <span>0</span>;
  return <span>{diff.stat.files}</span>;
}

/// Inline 4-point sparkle for the AI-helper buttons. Same shape
/// as the `AgentLoadingFooter`'s SparkleSpinner, just static (no
/// spin / pulse) — a glyph that says "this asks Jarvis", not a
/// progress indicator.
function AiSparkleIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 3 L13.9 10.1 A2 2 0 0 0 15.4 11.6 L21 12 L15.4 12.4 A2 2 0 0 0 13.9 13.9 L12 21 L10.1 13.9 A2 2 0 0 0 8.6 12.4 L3 12 L8.6 11.6 A2 2 0 0 0 10.1 10.1 Z" />
    </svg>
  );
}
