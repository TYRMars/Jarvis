// Desktop preferences (pinned workspace + LAN-exposure posture).
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
  /** Expose the embedded server on the LAN (bind 0.0.0.0 + require a token). */
  lanExposure?: boolean;
  /** Preferred stable port when exposed (phones keep a saved URL); default 7001. */
  lanPort?: number;
  /** Generated access token injected as JARVIS_ACCESS_TOKEN while exposed. */
  accessToken?: string;
}

/** Load prefs from `<dir>/prefs.json`; returns `{}` when absent/invalid. */
export async function loadPrefs(dir: string): Promise<DesktopPrefs> {
  try {
    const body = await readFile(path.join(dir, PREFS_FILE), "utf8");
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return {};
    const rec = parsed as Record<string, unknown>;
    const prefs: DesktopPrefs = {};
    if (typeof rec.workspace === "string" && rec.workspace.length > 0) {
      prefs.workspace = rec.workspace;
    }
    if (typeof rec.lanExposure === "boolean") prefs.lanExposure = rec.lanExposure;
    if (typeof rec.lanPort === "number" && Number.isInteger(rec.lanPort) && rec.lanPort > 0 && rec.lanPort < 65536) {
      prefs.lanPort = rec.lanPort;
    }
    if (typeof rec.accessToken === "string" && rec.accessToken.length > 0) {
      prefs.accessToken = rec.accessToken;
    }
    return prefs;
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
    // 0600: prefs may carry the generated access token (same posture as the
    // server's JARVIS_DDNS_CREDENTIALS file).
    await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, dst);
  } catch {
    /* best-effort: a non-persisted workspace is acceptable */
  }
}
