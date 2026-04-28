// Pretty-print for the `workspace.context` tool output.
//
// The tool returns a JSON blob like:
//   { "root": "...", "vcs": "git", "branch": "...", "head": "...",
//     "dirty": true, "instructions": [...], "manifests": [...],
//     "top_level": [...] }
//
// Dumping the raw JSON is technically fine but adds visual noise to
// the start of every coding turn. This card lifts the four most
// useful fields (branch, dirty, instructions, manifests) into
// chips + a small list so the user gets a glance summary before
// the agent moves on.

import { t } from "../../utils/i18n";

interface Props {
  content: string;
}

interface ParsedContext {
  root?: string;
  vcs?: string;
  branch?: string | null;
  head?: string | null;
  dirty?: boolean;
  instructions?: string[];
  manifests?: string[];
  top_level?: string[];
}

function tryParse(content: string): ParsedContext | null {
  try {
    const v = JSON.parse(content);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

export function WorkspaceContextCard({ content }: Props) {
  const parsed = tryParse(content);
  if (!parsed) {
    // Fall back to raw output rendering if parsing fails — the
    // agent should never get less information than the underlying
    // pre would show.
    return <pre className="tool-pre">{content}</pre>;
  }
  const branch = parsed.branch ?? null;
  const head = parsed.head ?? null;
  const dirty = parsed.dirty === true;
  const instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
  const manifests = Array.isArray(parsed.manifests) ? parsed.manifests : [];
  const topLevel = Array.isArray(parsed.top_level) ? parsed.top_level : [];

  return (
    <div className="ws-context-card">
      {parsed.root ? (
        <div className="ws-context-root" title={parsed.root}>
          <span className="ws-context-label">{t("wsContextRoot")}</span>
          <code>{parsed.root}</code>
        </div>
      ) : null}

      <div className="ws-context-chips">
        {parsed.vcs ? (
          <span className={`ws-context-chip vcs-${parsed.vcs}`}>{parsed.vcs}</span>
        ) : (
          <span className="ws-context-chip vcs-none">{t("wsContextNoVcs")}</span>
        )}
        {branch ? <span className="ws-context-chip">⎇ {branch}</span> : null}
        {head ? <span className="ws-context-chip mono">{head}</span> : null}
        {parsed.vcs === "git" ? (
          <span className={`ws-context-chip ${dirty ? "dirty" : "clean"}`}>
            {dirty ? t("wsContextDirty") : t("wsContextClean")}
          </span>
        ) : null}
      </div>

      {instructions.length > 0 ? (
        <div className="ws-context-section">
          <div className="ws-context-section-title">{t("wsContextInstructions")}</div>
          <ul className="ws-context-list">
            {instructions.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {manifests.length > 0 ? (
        <div className="ws-context-section">
          <div className="ws-context-section-title">
            {t("wsContextManifests")}
            <span className="ws-context-count">{manifests.length}</span>
          </div>
          <ul className="ws-context-list">
            {manifests.slice(0, 8).map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
            {manifests.length > 8 ? (
              <li className="ws-context-more">+{manifests.length - 8}</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {topLevel.length > 0 ? (
        <div className="ws-context-section">
          <div className="ws-context-section-title">
            {t("wsContextTopLevel")}
            <span className="ws-context-count">{topLevel.length}</span>
          </div>
          <div className="ws-context-grid">
            {topLevel.map((entry) => (
              <code key={entry} className="ws-context-grid-item">
                {entry}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
