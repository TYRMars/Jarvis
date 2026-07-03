// Electron main process — the Jarvis desktop entry point.
//
// P7.6: embed @jarvis/server in the main process (see server-manager.ts), create
// a 1280x860 window, and `loadFile(dist/index.html)` so the bundled SPA paints
// immediately. Once the embedded server is healthy we `loadURL(api_origin)` so
// the SPA runs SAME-ORIGIN against the server (no CORS needed) — the same model
// the Tauri shell uses (it navigates the window to the sidecar origin on setup).
//
// P7.7: IPC handlers back the preload bridge (window.jarvisDesktop), replacing
// the Tauri command surface (desktop_status / restart_server / select_workspace
// / open_path / reveal_path / desktop_logs).
//
// Security baseline (also satisfies the P8.6 checklist preemptively):
// contextIsolation on, sandbox on, nodeIntegration off — the renderer only ever
// touches the main process through the typed, channel-scoped preload bridge.
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { IPC, type DesktopStatus, type OpenResult } from "../shared/ipc.ts";
import { LogBuffer } from "./logs.ts";
import { ServerManager } from "./server-manager.ts";

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 860;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

const logs = new LogBuffer();
logs.push("Jarvis Desktop starting");

let manager: ServerManager | null = null;
let webDist = "";
let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * Resolve the built web SPA directory:
 *   - `JARVIS_DESKTOP_WEB_DIST` override (dev / CI), else
 *   - packaged: `<resources>/web` (electron-builder extraResources), else
 *   - dev: `<repo>/apps/jarvis-web/dist` (relative to the app root).
 */
function resolveWebDist(): string {
  const override = process.env.JARVIS_DESKTOP_WEB_DIST;
  if (override !== undefined && override.length > 0) return override;
  if (app.isPackaged) return path.join(process.resourcesPath, "web");
  // app.getAppPath() === packages/desktop during `electron .`
  return path.resolve(app.getAppPath(), "..", "..", "apps", "jarvis-web", "dist");
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: true,
    show: false,
    title: "Jarvis",
    backgroundColor: "#0b0b0d",
    webPreferences: {
      preload: path.join(app.getAppPath(), "out", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  // Hand external URLs (OAuth start, doc/PR links opened via window.open or
  // target=_blank) to the OS browser and never spawn an uncontrolled in-app
  // BrowserWindow that would escape the parent's hardened webPreferences.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 7.6: load the bundled SPA from disk first (instant first paint / fallback).
  try {
    await win.loadFile(path.join(webDist, "index.html"));
  } catch (e) {
    logs.push(`loadFile(${webDist}) failed: ${String(e)}`);
  }

  // Bring the embedded server up, then navigate to its origin for same-origin
  // API + WebSocket access. If it never starts, stay on the file:// SPA.
  if (manager !== null) {
    await manager.ensureServer();
    await navigateToServer(win, await manager.status());
  }
}

/** Point a window at the live server origin (same-origin SPA), if running. */
async function navigateToServer(win: BrowserWindow, status: DesktopStatus): Promise<void> {
  if (win.isDestroyed() || !status.server_running) return;
  try {
    await win.loadURL(status.api_origin);
  } catch (e) {
    logs.push(`Navigate to ${status.api_origin} failed: ${String(e)}`);
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.status, async () => (manager !== null ? await manager.status() : stoppedStatus()));

  ipcMain.handle(IPC.restart, async (event, workspace: unknown) => {
    if (manager === null) return stoppedStatus();
    const ws = typeof workspace === "string" ? workspace : null;
    const status = await manager.restart(ws);
    // The renderer was served by the old (now-dead) origin; re-navigate the
    // calling window to the new one after the reply is sent.
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== null && status.server_running) {
      setTimeout(() => void navigateToServer(win, status), 0);
    }
    return status;
  });

  ipcMain.handle(IPC.selectWorkspace, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Select Jarvis workspace",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.openPath, async (_event, target: unknown): Promise<OpenResult> => {
    if (typeof target !== "string" || target.length === 0) {
      return { ok: false, error: "no path provided" };
    }
    const err = await shell.openPath(target);
    return err === "" ? { ok: true, error: null } : { ok: false, error: err };
  });

  ipcMain.handle(IPC.revealPath, (_event, target: unknown): OpenResult => {
    if (typeof target !== "string" || target.length === 0) {
      return { ok: false, error: "no path provided" };
    }
    shell.showItemInFolder(target);
    return { ok: true, error: null };
  });

  ipcMain.handle(IPC.logs, (_event, limit: unknown): string[] => {
    const n = typeof limit === "number" && limit > 0 ? Math.floor(limit) : 200;
    return logs.tail(n);
  });
}

function stoppedStatus() {
  return {
    api_origin: "http://127.0.0.1:7001",
    server_kind: "stopped" as const,
    server_running: false,
    workspace: null,
    logs: logs.tail(120),
    last_error: "desktop not initialised",
  };
}

// Single-instance: a second launch focuses the existing window instead of
// starting a second embedded server on a different port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      webDist = resolveWebDist();
      manager = new ServerManager({ logs, prefsDir: app.getPath("userData"), webDist });
      await manager.init();
      registerIpc();
      await createWindow();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((e: unknown) => {
      logs.push(`fatal: ${String(e)}`);
    });

  app.on("window-all-closed", () => {
    // macOS apps conventionally stay resident until Cmd-Q; elsewhere, quit.
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    // Hold the quit until the embedded server closes so its port frees cleanly,
    // then let the second pass through (the guard flag) proceed.
    if (quitting || manager === null) return;
    quitting = true;
    event.preventDefault();
    manager.stop().finally(() => app.quit());
  });
}
