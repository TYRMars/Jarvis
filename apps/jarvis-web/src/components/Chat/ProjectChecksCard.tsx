// Pretty-print for the `project.checks` tool output.
//
// `project.checks` returns:
//   { "suggestions": [{ "manifest": "...", "kind": "test"|"lint"|"build"|"check",
//                       "command": "...", "why": "..." }] }
//
// The model uses this as a hint for what `shell.exec` to call next,
// but the raw JSON dump is also visible to the user. This card
// turns each suggestion into a row with kind badge + command + why,
// and adds two one-click buttons:
//
//   • Copy → put the command in the clipboard
//   • Send → drop "Run `<command>`" into the composer so the user
//     can review-and-send a synthetic prompt asking the agent to
//     run that exact check.
//
// We don't auto-execute — this stays "user proposes, agent runs",
// which preserves the approval gate on `shell.exec`.

import { useAppStore } from "../../store/appStore";
import { copyToClipboard } from "../../services/copy";
import { t } from "../../utils/i18n";

interface Props {
  content: string;
}

interface Suggestion {
  manifest: string;
  kind: "test" | "lint" | "build" | "check";
  command: string;
  why?: string;
}

interface Parsed {
  suggestions?: Suggestion[];
}

function tryParse(content: string): Suggestion[] | null {
  try {
    const v = JSON.parse(content) as Parsed;
    return Array.isArray(v?.suggestions) ? v.suggestions : null;
  } catch {
    return null;
  }
}

export function ProjectChecksCard({ content }: Props) {
  const setComposerValue = useAppStore((s) => s.setComposerValue);
  const composerValue = useAppStore((s) => s.composerValue);
  const suggestions = tryParse(content);

  if (suggestions == null) return <pre className="tool-pre">{content}</pre>;
  if (suggestions.length === 0) {
    return <div className="checks-card-empty">{t("checksEmpty")}</div>;
  }

  return (
    <div className="checks-card">
      <ul className="checks-card-list">
        {suggestions.map((s, i) => (
          <li key={`${s.manifest}-${s.kind}-${i}`} className="checks-card-row">
            <div className="checks-card-row-head">
              <span className={`checks-card-kind kind-${s.kind}`}>{s.kind}</span>
              <code className="checks-card-cmd">{s.command}</code>
              <div className="checks-card-actions">
                <button
                  type="button"
                  className="checks-card-btn"
                  onClick={() => void copyToClipboard(s.command)}
                  title={t("copy")}
                >
                  {t("copy")}
                </button>
                <button
                  type="button"
                  className="checks-card-btn checks-card-btn-primary"
                  onClick={() => {
                    // Prefill the composer with a synthetic prompt
                    // that asks the agent to run this command. Using
                    // the composer (not auto-send) keeps the user
                    // in the loop and preserves the approval gate
                    // on `shell.exec`.
                    const prefix = composerValue.trim().length === 0 ? "" : composerValue + "\n\n";
                    const message = t("checksRunPrompt", s.command);
                    setComposerValue(prefix + message);
                    document.getElementById("input")?.focus();
                  }}
                  title={t("checksRunHint")}
                >
                  {t("checksRunBtn")}
                </button>
              </div>
            </div>
            <div className="checks-card-meta">
              <span className="checks-card-manifest">
                <code>{s.manifest}</code>
              </span>
              {s.why ? <span className="checks-card-why">{s.why}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
