// The minimal slice of the LSP types this client touches. We model only what
// the push-diagnostics path needs (positions, ranges, diagnostics) rather than
// vendoring `vscode-languageserver-protocol`.

export interface Position {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 column. */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** LSP DiagnosticSeverity: 1 Error · 2 Warning · 3 Information · 4 Hint. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
}

/** `textDocument/publishDiagnostics` notification params. */
export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}
