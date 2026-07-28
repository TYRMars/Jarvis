// Preload bridge — the only seam between the sandboxed renderer and the main
// process (P7.7, replacing @tauri-apps/api). Runs with contextIsolation +
// sandbox on, so it may only `require('electron')`; it exposes a typed, frozen
// `window.jarvisDesktop` whose every method is a thin `ipcRenderer.invoke` over
// a namespaced channel (see ../shared/ipc.ts). No Node APIs reach the page.
import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type DesktopStatus,
  type JarvisDesktopBridge,
  type OpenResult,
} from "../shared/ipc.ts";

const bridge: JarvisDesktopBridge = {
  status: (): Promise<DesktopStatus> => ipcRenderer.invoke(IPC.status),
  restartServer: (workspace?: string | null): Promise<DesktopStatus> =>
    ipcRenderer.invoke(IPC.restart, workspace ?? null),
  selectWorkspaceDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectWorkspace),
  openPath: (path: string): Promise<OpenResult> => ipcRenderer.invoke(IPC.openPath, path),
  revealPath: (path: string): Promise<OpenResult> => ipcRenderer.invoke(IPC.revealPath, path),
  logs: (limit?: number): Promise<string[]> => ipcRenderer.invoke(IPC.logs, limit ?? 200),
  setLanExposure: (enabled: boolean): Promise<DesktopStatus> =>
    ipcRenderer.invoke(IPC.setLanExposure, enabled),
};

contextBridge.exposeInMainWorld("jarvisDesktop", bridge);
