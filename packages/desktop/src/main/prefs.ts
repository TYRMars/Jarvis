// Desktop preferences (just the pinned workspace, for now).
//
// Port of apps/jarvis-desktop/src/prefs.rs: a tiny JSON file under the app's
// user-data dir, written atomically (tmp + rename) so a crash mid-write can't
// corrupt it. Best-effort throughout — a failed read returns defaults, a failed
// write is swallowed (the workspace simply won't persist).
//
// The directory is passed in (the Electron main resolves `app.getPath("userData")`)
// so this module stays electron-free and unit-testable.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PREFS_FILE = "prefs.json";

export interface DesktopPrefs {
  workspace?: string;
}

/** Load prefs from `<dir>/prefs.json`; returns `{}` when absent/invalid. */
export async function loadPrefs(dir: string): Promise<DesktopPrefs> {
  try {
    const body = await readFile(path.join(dir, PREFS_FILE), "utf8");
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return {};
    const ws = (parsed as Record<string, unknown>).workspace;
    return typeof ws === "string" && ws.length > 0 ? { workspace: ws } : {};
  } catch {
    return {};
  }
}

/** Persist prefs atomically to `<dir>/prefs.json`. Best-effort (never throws). */
export async function savePrefs(dir: string, prefs: DesktopPrefs): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${PREFS_FILE}.tmp`);
    const dst = path.join(dir, PREFS_FILE);
    await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
    await rename(tmp, dst);
  } catch {
    /* best-effort: a non-persisted workspace is acceptable */
  }
}
