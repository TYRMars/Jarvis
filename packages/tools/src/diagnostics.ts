// Optional post-write diagnostics hook. After a successful `fs.write` /
// `fs.edit` / `fs.patch`, the tool calls this with the absolute paths it wrote
// and appends the returned text (an LSP `<diagnostics>` block, or `""`) to its
// result — closing the agent's edit→verify loop without touching the run loop.
//
// The composition root supplies an `@jarvis/lsp`-backed implementation when
// `JARVIS_ENABLE_LSP` is set; absent, the edit tools behave exactly as before.
// Implementations MUST be best-effort: never throw, never block an edit.
export type DiagnosticsHook = (absPaths: string[]) => Promise<string>;

/**
 * Append a diagnostics block to a write tool's `result`, if a hook is wired.
 * Swallows hook failures so diagnostics can never break the underlying edit.
 */
export async function withDiagnostics(
  result: string,
  hook: DiagnosticsHook | undefined,
  absPaths: string[],
): Promise<string> {
  if (!hook || absPaths.length === 0) return result;
  try {
    const block = await hook(absPaths);
    return block ? `${result}\n${block}` : result;
  } catch {
    return result;
  }
}
