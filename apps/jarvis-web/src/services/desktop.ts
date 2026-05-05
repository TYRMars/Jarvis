import { setApiOriginOverride } from "./api";

type TauriCore = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

export type DesktopStatus = {
  api_origin: string;
  server_running: boolean;
  workspace?: string | null;
  logs: string[];
  last_error?: string | null;
};

function tauriCore(): TauriCore | null {
  return ((window as any).__TAURI__?.core ?? null) as TauriCore | null;
}

export function isDesktopRuntime(): boolean {
  return !!tauriCore();
}

export async function initDesktopRuntime(): Promise<DesktopStatus | null> {
  const core = tauriCore();
  if (!core) return null;
  const status = await core.invoke<DesktopStatus>("desktop_status");
  setApiOriginOverride(status.api_origin);
  localStorage.setItem("jarvis.apiOrigin", status.api_origin);
  return status;
}

export async function fetchDesktopStatus(): Promise<DesktopStatus | null> {
  const core = tauriCore();
  if (!core) return null;
  return await core.invoke<DesktopStatus>("desktop_status");
}

export async function selectDesktopWorkspace(): Promise<string | null> {
  const core = tauriCore();
  if (!core) return null;
  return await core.invoke<string | null>("select_workspace_dir");
}

export async function restartDesktopServer(workspace?: string | null): Promise<DesktopStatus | null> {
  const core = tauriCore();
  if (!core) return null;
  const status = await core.invoke<DesktopStatus>("restart_server", { workspace });
  setApiOriginOverride(status.api_origin);
  localStorage.setItem("jarvis.apiOrigin", status.api_origin);
  return status;
}

export async function openDesktopPath(path: string): Promise<boolean> {
  const core = tauriCore();
  if (!core) return false;
  const result = await core.invoke<{ ok: boolean }>("open_path", { path });
  return result.ok;
}

export async function fetchDesktopLogs(limit = 200): Promise<string[]> {
  const core = tauriCore();
  if (!core) return [];
  return await core.invoke<string[]>("desktop_logs", { limit });
}
