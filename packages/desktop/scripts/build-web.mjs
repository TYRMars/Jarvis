// Build the jarvis-web SPA for the desktop shell.
//
// apps/jarvis-web is outside the pnpm workspace (the workspace globs packages/*
// only, see pnpm-workspace.yaml), so we drive its own toolchain directly. The
// `JARVIS_DESKTOP_BUILD=1` flag makes Vite emit RELATIVE asset paths (`base:
// "./"`), which is required so `loadFile(dist/index.html)` works from a file://
// origin (and still works when served at the server root). Mirrors the Tauri
// shell's `beforeBuildCommand`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..", "..", "..", "apps", "jarvis-web");

if (!existsSync(webDir)) {
  console.error(`jarvis-web not found at ${webDir}`);
  process.exit(1);
}

// Use npm in the web app (it manages its own lockfile/node_modules independent
// of the pnpm workspace). Install on demand so a clean checkout can build, and
// prefer the reproducible `npm ci` when a lockfile is present (matches the Tauri
// release.yml) so a release artifact never drifts off the committed lockfile.
if (!existsSync(path.join(webDir, "node_modules"))) {
  const hasLock = existsSync(path.join(webDir, "package-lock.json"));
  console.log(`[build-web] installing jarvis-web deps (npm ${hasLock ? "ci" : "install"})…`);
  run("npm", [hasLock ? "ci" : "install"], webDir);
}

console.log("[build-web] building jarvis-web (JARVIS_DESKTOP_BUILD=1)…");
run("npm", ["run", "build"], webDir, { JARVIS_DESKTOP_BUILD: "1" });

console.log(`[build-web] done -> ${path.join(webDir, "dist")}`);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string,string>} [extraEnv]
 */
function run(cmd, args, cwd, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    console.error(`[build-web] \`${cmd} ${args.join(" ")}\` failed (${res.status})`);
    process.exit(res.status ?? 1);
  }
}
