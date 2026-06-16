// Ensure node-pty's prebuilt `spawn-helper` is executable.
//
// node-pty ships a `spawn-helper` binary in its prebuilds; the prebuild
// tarball / pnpm's content-addressed extraction can land it as mode 0644,
// which makes `posix_spawnp` fail at runtime ("posix_spawnp failed") the
// first time a PTY is opened. We restore the +x bit after every install.
//
// No-op on Windows (no spawn-helper there) and when node-pty isn't present.
// Always exits 0 so it can never break `pnpm install`.
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") process.exit(0);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
let fixed = 0;

/** chmod +x every `prebuilds/<plat>/spawn-helper` under a node-pty package dir. */
function fixUnder(nodePtyDir) {
  const prebuilds = join(nodePtyDir, "prebuilds");
  let plats;
  try {
    plats = readdirSync(prebuilds);
  } catch {
    return;
  }
  for (const plat of plats) {
    const helper = join(prebuilds, plat, "spawn-helper");
    try {
      statSync(helper);
      chmodSync(helper, 0o755);
      fixed++;
    } catch {
      /* not present for this platform */
    }
  }
}

// pnpm store layout: node_modules/.pnpm/node-pty@x/node_modules/node-pty
try {
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  for (const entry of readdirSync(pnpmDir)) {
    if (entry.startsWith("node-pty@")) {
      fixUnder(join(pnpmDir, entry, "node_modules", "node-pty"));
    }
  }
} catch {
  /* no .pnpm dir */
}
// Hoisted / npm layout fallback.
try {
  fixUnder(join(repoRoot, "node_modules", "node-pty"));
} catch {
  /* ignore */
}

if (fixed > 0) console.log(`[fix-node-pty] chmod +x ${fixed} spawn-helper binary(ies)`);
