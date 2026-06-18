# @jarvis/desktop

Electron desktop shell for the Node rewrite. It **embeds `@jarvis/server` in the
Electron main process** (no separate sidecar binary), renders the built
`jarvis-web` SPA, and bridges native affordances (folder picker, open/reveal
path, logs) into the renderer through a typed preload bridge.

This is the Node-rewrite successor to the Tauri shell (`apps/jarvis-desktop`),
covering tasklist items **P7.6 – P7.8**.

## How it works

```
┌─ Electron main (Node) ───────────────────────────────┐
│  ServerManager                                        │
│    loadConfig(env) → buildProvider → openStores       │
│    → buildAppState → serve()  ← @jarvis/server        │
│    listens on 127.0.0.1:<ephemeral>                   │
│                                                       │
│  BrowserWindow 1280×860                               │
│    1. loadFile(jarvis-web/dist/index.html)  (instant) │
│    2. loadURL(http://127.0.0.1:<port>)      (when up) │  ← same-origin, no CORS
│                                                       │
│  ipcMain.handle(...)  ← preload bridge                │
└───────────────────────────────────────────────────────┘
```

- **Embedded, not spawned.** The main process is Node, so it builds the
  composition root in-process and calls `serve()` directly. `JARVIS_ADDR`,
  `JARVIS_FS_ROOT`, and `JARVIS_WEB_DIST` are forced on top of `process.env`.
- **`loadFile` → `loadURL`.** The window loads the bundled SPA from disk first
  for an instant first paint, then navigates to the server origin so the SPA runs
  same-origin (no CORS plumbing needed). If the server never starts (e.g. no API
  key) the window stays on the `file://` SPA, which surfaces the error;
  `restartServer` re-attempts.
- **External-server reuse.** If a `jarvis serve` is already healthy on
  `127.0.0.1:7001`, the desktop reuses it instead of starting a second instance.
- **Security.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration:
  false`. The renderer only reaches the main process via the channel-scoped
  preload bridge (`window.jarvisDesktop`).

## Develop

```sh
# from the repo root
pnpm install                                  # workspace deps (incl. Electron)
pnpm --filter @jarvis/desktop run build:web   # build jarvis-web (relative base)
pnpm --filter @jarvis/desktop run dev         # bundle main/preload + launch
```

`dev` runs the esbuild bundle (`build.mjs`) then `electron .`. The SPA is loaded
from `../../apps/jarvis-web/dist` in dev (override with `JARVIS_DESKTOP_WEB_DIST`).

Set your provider key in the launching shell so the embedded server starts:

```sh
export OPENAI_API_KEY=sk-...
pnpm --filter @jarvis/desktop run dev
```

## Package (macOS dmg + zip)

```sh
pnpm --filter @jarvis/desktop run dist
# → packages/desktop/release/Jarvis-<version>-<arch>.{dmg,zip}
```

`dist` = build the SPA + esbuild bundle + `electron-builder --mac`. Native addons
(`better-sqlite3`, `node-pty`) are kept external from the esbuild bundle and
rebuilt against Electron's ABI by electron-builder. Builds are unsigned by
default — see `electron-builder.yml` for the signing/notarization knobs.

CI: `.github/workflows/node-desktop-release.yml` builds dmg+zip on a
`node-desktop-v*` tag (or manual dispatch).

## Layout

| path                       | role                                              |
| -------------------------- | ------------------------------------------------- |
| `src/main/index.ts`        | app lifecycle, window, IPC handlers               |
| `src/main/server-manager.ts` | embeds `@jarvis/server` in-process              |
| `src/main/{net,prefs,logs}.ts` | port-pick/health, prefs file, log ring buffer |
| `src/preload/index.ts`     | `contextBridge` → `window.jarvisDesktop`          |
| `src/shared/ipc.ts`        | channel names + `DesktopStatus` contract          |
| `build.mjs`                | esbuild bundle (main + preload → CJS)             |
| `scripts/build-web.mjs`    | build jarvis-web with `JARVIS_DESKTOP_BUILD=1`    |
| `electron-builder.yml`     | macOS dmg + zip packaging                          |

The frontend adapter lives in `apps/jarvis-web/src/services/desktop.ts`; it
detects either the Tauri (`__TAURI__`) or the Electron (`window.jarvisDesktop`)
bridge and routes through whichever is present.
