// @jarvis/lsp — minimal Language Server Protocol client for the agent's
// edit→verify loop. The composition root builds an `LspManager` and passes its
// `report` as the `diagnostics` hook into the `fs.*` write tools, which append
// the returned `<diagnostics>` block to their result so the model sees the
// errors its edit introduced.
export { LspManager, type LspManagerOptions } from "./manager.ts";
export {
  DefaultLanguageRegistry,
  whichSync,
  type LanguageRegistry,
  type ServerSpec,
  type SearchEnv,
} from "./registry.ts";
export { LspClient, type LspClientOptions } from "./client.ts";
export { report, pretty } from "./diagnostic.ts";
export type { Diagnostic, DiagnosticSeverity, Position, Range } from "./protocol.ts";
