// Language registry: map a file to the language server that should diagnose it.
//
// The default registry recognises TypeScript/JavaScript, Python, Go, and Rust,
// and PATH-probes the server binary — an absent server resolves to `null` so
// the manager cleanly no-ops (we deliberately do NOT auto-download servers, the
// heaviest/riskiest part of opencode's implementation). Tests inject a custom
// registry to point an extension at a mock server.
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export interface ServerSpec {
  /** Stable key so the manager reuses one server process across files. */
  serverKey: string;
  command: string;
  args: string[];
  /** LSP `languageId` for `textDocument/didOpen`. */
  languageId: string;
}

export interface LanguageRegistry {
  /** The server for `absPath`, or `null` when unsupported / not installed. */
  resolve(absPath: string): ServerSpec | null;
}

/**
 * The executable search environment, passed in from the composition root
 * (library packages must not read `process.env`). `path` is the OS PATH string;
 * `pathExt` is the Windows executable-extension list. Absent `path` → bare
 * command names can't be probed, so the default registry treats every server as
 * not installed.
 */
export interface SearchEnv {
  path?: string;
  pathExt?: string;
}

interface ServerDef {
  serverKey: string;
  command: string;
  args: string[];
  /** extension (lowercase, with dot) → languageId */
  languages: Record<string, string>;
}

const DEFAULT_SERVERS: ServerDef[] = [
  {
    serverKey: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: {
      ".ts": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
  },
  {
    serverKey: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    languages: { ".py": "python", ".pyi": "python" },
  },
  { serverKey: "gopls", command: "gopls", args: [], languages: { ".go": "go" } },
  { serverKey: "rust-analyzer", command: "rust-analyzer", args: [], languages: { ".rs": "rust" } },
];

/**
 * Whether `cmd` resolves to an executable, given a {@link SearchEnv}. A command
 * containing a path separator is checked directly; a bare name is looked up in
 * `search.path`. No `search.path` → bare names resolve to `false`.
 */
export function whichSync(cmd: string, search: SearchEnv = {}): boolean {
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd);
  if (!search.path) return false;
  const dirs = search.path.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (search.pathExt ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

/** Default registry: known servers, probed once per server key against {@link SearchEnv}. */
export class DefaultLanguageRegistry implements LanguageRegistry {
  readonly #installed = new Map<string, boolean>();
  readonly #search: SearchEnv;

  constructor(search: SearchEnv = {}) {
    this.#search = search;
  }

  resolve(absPath: string): ServerSpec | null {
    const ext = extname(absPath).toLowerCase();
    if (!ext) return null;
    const def = DEFAULT_SERVERS.find((d) => ext in d.languages);
    if (!def) return null;
    let ok = this.#installed.get(def.serverKey);
    if (ok === undefined) {
      ok = whichSync(def.command, this.#search);
      this.#installed.set(def.serverKey, ok);
    }
    if (!ok) return null;
    return { serverKey: def.serverKey, command: def.command, args: def.args, languageId: def.languages[ext] as string };
  }
}
