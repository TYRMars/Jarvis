import { setApiOriginOverride } from "./api";

// Desktop runtime adapter. The web SPA ships two desktop shells:
//
//   - Tauri (apps/jarvis-desktop) exposes `window.__TAURI__.core.invoke(cmd)`.
//   - Electron (@jarvis/desktop, P7.7) exposes a typed `window.jarvisDesktop`
//     bridge from its preload (ipcRenderer.invoke under the hood).
//
// Both speak the same `DesktopStatus` shape, so this module detects whichever is
// present and routes to it; in a plain browser both are absent and every call is
// a no-op. The exported function surface is unchanged from the Tauri-only cut.

type TauriCore = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

export type DesktopStatus = {
  api_origin: string;
  server_running: boolean;
  workspace?: string | null;
  logs: string[];
  last_error?: string | null;
  server_kind?: string;
};

type OpenResult = { ok: boolean; error?: string | null };

// The Electron preload bridge (see packages/desktop/src/shared/ipc.ts).
type ElectronBridge = {
  status: () => Promise<DesktopStatus>;
  restartServer: (workspace?: string | null) => Promise<DesktopStatus>;
  selectWorkspaceDir: () => Promise<string | null>;
  openPath: (path: string) => Promise<OpenResult>;
  revealPath: (path: string) => Promise<OpenResult>;
  logs: (limit?: number) => Promise<string[]>;
};

function electronBridge(): ElectronBridge | null {
  return (window as unknown as { jarvisDesktop?: ElectronBridge }).jarvisDesktop ?? null;
}

function tauriCore(): TauriCore | null {
  const tauri = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  return tauri?.core ?? null;
}

export function isDesktopRuntime(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return !!electronBridge() || !!tauriCore() || ua.includes("Electron/") || ua.includes("Tauri/");
}

/** Mirror a freshly-fetched status into the API-origin override + persistence. */
function applyStatus(status: DesktopStatus): DesktopStatus {
  setApiOriginOverride(status.api_origin);
  localStorage.setItem("jarvis.apiOrigin", status.api_origin);
  return status;
}

export async function initDesktopRuntime(): Promise<DesktopStatus | null> {
  const electron = electronBridge();
  if (electron) return applyStatus(await electron.status());

  const core = tauriCore();
  if (core) return applyStatus(await core.invoke<DesktopStatus>("desktop_status"));

  return null;
}

export async function fetchDesktopStatus(): Promise<DesktopStatus | null> {
  const electron = electronBridge();
  if (electron) return await electron.status();

  const core = tauriCore();
  if (core) return await core.invoke<DesktopStatus>("desktop_status");

  return null;
}

export async function selectDesktopWorkspace(): Promise<string | null> {
  const electron = electronBridge();
  if (electron) return await electron.selectWorkspaceDir();

  const core = tauriCore();
  if (core) return await core.invoke<string | null>("select_workspace_dir");

  return null;
}

export async function restartDesktopServer(workspace?: string | null): Promise<DesktopStatus | null> {
  const electron = electronBridge();
  if (electron) return applyStatus(await electron.restartServer(workspace ?? null));

  const core = tauriCore();
  if (core) return applyStatus(await core.invoke<DesktopStatus>("restart_server", { workspace }));

  return null;
}

export async function openDesktopPath(path: string): Promise<boolean> {
  const electron = electronBridge();
  if (electron) return (await electron.openPath(path)).ok;

  const core = tauriCore();
  if (core) {
    const result = await core.invoke<{ ok: boolean }>("open_path", { path });
    return result.ok;
  }
  return false;
}

export async function revealDesktopPath(path: string): Promise<boolean> {
  const electron = electronBridge();
  if (electron) return (await electron.revealPath(path)).ok;

  const core = tauriCore();
  if (core) {
    const result = await core.invoke<{ ok: boolean }>("reveal_path", { path });
    return result.ok;
  }
  return false;
}

export async function fetchDesktopLogs(limit = 200): Promise<string[]> {
  const electron = electronBridge();
  if (electron) return await electron.logs(limit);

  const core = tauriCore();
  if (core) return await core.invoke<string[]>("desktop_logs", { limit });

  return [];
}
