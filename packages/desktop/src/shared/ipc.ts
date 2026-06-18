// Shared IPC contract between the Electron main process and the preload bridge.
//
// This is the Node/Electron analogue of the Tauri command surface
// (apps/jarvis-desktop/src/commands.rs). The preload exposes these calls on
// `window.jarvisDesktop`; the frontend adapter (apps/jarvis-web/src/services/
// desktop.ts) detects the bridge and routes through it instead of `__TAURI__`.
//
// `DesktopStatus` is intentionally snake_case so it is byte-compatible with the
// shape the Tauri shell already returns and the web client already consumes —
// the frontend type does not need to change to gain an Electron backend.

/** IPC channel names. Namespaced so they never collide with app routes. */
export const IPC = {
  status: "jarvis-desktop:status",
  restart: "jarvis-desktop:restart-server",
  selectWorkspace: "jarvis-desktop:select-workspace",
  openPath: "jarvis-desktop:open-path",
  revealPath: "jarvis-desktop:reveal-path",
  logs: "jarvis-desktop:logs",
} as const;

/** How the desktop is currently sourcing its backend. */
export type ServerKind = "embedded" | "external" | "stopped";

/** Snapshot of the desktop server state — mirrors the Tauri `DesktopStatus`. */
export interface DesktopStatus {
  /** Origin the SPA should talk to, e.g. `http://127.0.0.1:53124`. */
  api_origin: string;
  /** embedded (we started it) / external (reused a running server) / stopped. */
  server_kind: ServerKind;
  /** Whether a backend is currently believed to be serving. */
  server_running: boolean;
  /** The pinned workspace root (null when none resolved). */
  workspace: string | null;
  /** Recent log lines (desktop breadcrumbs + server lifecycle). */
  logs: string[];
  /** Last start/restart failure, if any. */
  last_error: string | null;
}

/** Result of an `openPath` / `revealPath` call. */
export interface OpenResult {
  ok: boolean;
  error: string | null;
}

/**
 * The surface exposed on `window.jarvisDesktop` by the preload. Kept in lockstep
 * with the Tauri command names consumed by services/desktop.ts.
 */
export interface JarvisDesktopBridge {
  /** Current backend status (does not start anything). */
  status(): Promise<DesktopStatus>;
  /** Restart the embedded server (optionally re-pinning the workspace). */
  restartServer(workspace?: string | null): Promise<DesktopStatus>;
  /** Native folder picker -> absolute path, or null when cancelled. */
  selectWorkspaceDir(): Promise<string | null>;
  /** Open a path with the OS default handler. */
  openPath(path: string): Promise<OpenResult>;
  /** Reveal a path in the OS file manager. */
  revealPath(path: string): Promise<OpenResult>;
  /** Tail of the desktop/server log buffer. */
  logs(limit?: number): Promise<string[]>;
}
