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
  refreshWorkspaceDiff,
  type DiffFileEntry,
  type WorkspaceDiff as WorkspaceDiffData,
} from "../../services/workspaceDiff";
import { UnifiedDiffViewer } from "../Chat/UnifiedDiffViewer";
import { t } from "../../utils/i18n";
import { CommitDialog } from "./CommitDialog";
import { CreatePrDialog } from "./CreatePrDialog";

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
  const diff = useAppStore((s) => s.workspaceDiff);
  const loading = useAppStore((s) => s.workspaceDiffLoading);

  // Mount-fetch — runs once when the card first appears. Safe to
  // re-run on remount because of the seq guard inside the service.
  useEffect(() => {
    if (diff == null) void refreshWorkspaceDiff();
  }, [diff]);

  if (diff === "unavailable") {
    // Server has no workspace root. Hide entirely so we don't
    // confuse the user with a card that can't ever populate.
    return null;
  }

  if (diff == null) {
    return (
      <div className="ws-diff">
        <div className="ws-diff-empty">{loading ? t("wsDiffLoading") : "…"}</div>
      </div>
    );
  }

  return <WorkspaceDiffBody diff={diff} loading={loading} />;
}

function WorkspaceDiffBody({
  diff,
  loading,
}: {
  diff: WorkspaceDiffData;
  loading: boolean;
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

  const totalChange = diff.stat.added + diff.stat.removed;
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
    if (next !== diff.base) void refreshWorkspaceDiff(next);
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
            onClick={() => void refreshWorkspaceDiff(diff.base)}
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
        <div className="ws-diff-uncommitted" title={t("wsDiffUncommittedHint")}>
          <span aria-hidden="true">⚠</span>
          {t("wsDiffUncommitted", diff.uncommitted.files, diff.uncommitted.added, diff.uncommitted.removed)}
        </div>
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

function FileRow({
  file,
  base,
  expanded,
  onToggle,
}: {
  file: DiffFileEntry;
  base: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cacheKey = `${base}::${file.path}`;
  const cached = useAppStore((s) => s.workspaceDiffFileCache[cacheKey]);
  const setEntry = useAppStore((s) => s.setWorkspaceDiffFileEntry);
  const [loading, setLoading] = useState(false);

  // Lazy fetch when first expanded. Cached afterwards via the
  // store, so re-expanding doesn't refetch.
  useEffect(() => {
    if (!expanded || cached != null || loading) return;
    setLoading(true);
    void fetchFileDiff(base, file.path).then((diff) => {
      if (diff != null) setEntry(cacheKey, diff);
      setLoading(false);
    });
  }, [expanded, cached, loading, base, file.path, cacheKey, setEntry]);

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
/// expanding the card.
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
