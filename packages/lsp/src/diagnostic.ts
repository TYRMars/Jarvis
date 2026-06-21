// Diagnostics → text block. Ported from opencode's `lsp/diagnostic.ts`.
//
// Only ERRORS are surfaced — warnings/info/hints are noise for the edit→verify
// loop and would push the model to chase lint nits. The block is appended to a
// successful write tool's result so the model reads its own breakage as text
// (the agent loop already feeds tool output back verbatim, so no loop change).
import type { Diagnostic } from "./protocol.ts";

const MAX_PER_FILE = 20;

const SEVERITY: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };

/** One diagnostic as `SEVERITY [line:col] message` (1-based line/col). */
export function pretty(diagnostic: Diagnostic): string {
  const severity = SEVERITY[diagnostic.severity ?? 1] ?? "ERROR";
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  return `${severity} [${line}:${col}] ${diagnostic.message}`;
}

/**
 * Render an errors-only `<diagnostics file="…">` block, or `""` when the file
 * has no errors. `file` is the label shown to the model (a workspace-relative
 * path reads best). Capped at {@link MAX_PER_FILE} with a `… and N more` tail.
 */
export function report(file: string, issues: Diagnostic[]): string {
  const errors = issues.filter((item) => item.severity === 1);
  if (errors.length === 0) return "";
  const limited = errors.slice(0, MAX_PER_FILE);
  const more = errors.length - MAX_PER_FILE;
  const suffix = more > 0 ? `\n... and ${more} more` : "";
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`;
}
