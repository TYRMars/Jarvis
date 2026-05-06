# Jarvis Desktop MVP

Tauri shell for the existing Jarvis Web UI. The desktop process owns
local system integration and sidecar management only; product state
continues to live in `apps/jarvis-web` and `harness-server`.

## Development

Build the Web UI and the Jarvis server binary first:

```bash
npm run build --prefix apps/jarvis-web
cargo build -p jarvis
cargo run -p jarvis-desktop
```

The desktop app will:

- reuse an existing healthy server at `http://127.0.0.1:7001`, or
- start `target/debug/jarvis serve --workspace <workspace>` on a free
  loopback port and inject that API origin into the Web UI.

Override the sidecar binary path with:

```bash
JARVIS_DESKTOP_SIDECAR=/path/to/jarvis cargo run -p jarvis-desktop
```

Override the startup workspace with:

```bash
JARVIS_DESKTOP_WORKSPACE=/path/to/repo cargo run -p jarvis-desktop
```

## IPC Commands

Exposed to the Web UI through Tauri global `invoke`:

- `desktop_status`
- `restart_server`
- `select_workspace_dir`
- `open_path`
- `reveal_path`
- `desktop_logs`

## Icons

The icon set in `icons/` is generated from a single 1024×1024 master.
To regenerate (e.g. after a brand tweak), run:

```bash
python3 apps/jarvis-desktop/scripts/generate_icons.py
```

The script renders the master, resamples it to every size Tauri's
bundler expects (`32x32.png`, `128x128.png`, `128x128@2x.png`,
Windows tiles), and assembles `icon.icns` (macOS) and `icon.ico`
(Windows) via `iconutil` and Pillow. Requires `python3` with
Pillow installed.

## Troubleshooting startup

If the desktop app can't reach the sidecar, the React UI shows a
recovery overlay with the actual stderr tail (auto-expanded on
failure). Common causes:

- **No API key in the env**: `jarvis serve` exits immediately if the
  configured provider has no key. Launch the desktop from a shell
  where `OPENAI_API_KEY` (or whichever provider you use) is exported,
  or set it in your shell rc and ensure the launcher inherits it.
- **`jarvis` binary missing**: build it first with
  `cargo build -p jarvis`. Both `target/debug/jarvis` and
  `target/release/jarvis` are checked. Override with
  `JARVIS_DESKTOP_SIDECAR=/path/to/jarvis`.
- **Port collision**: the sidecar picks a random free port; if
  another `jarvis serve` is already running on `127.0.0.1:7001`,
  the desktop reuses that one (kind: `external`).
- **Conversations list is empty**: the sidecar uses the default
  JSON store at `~/.local/share/jarvis/conversations`. If your
  prior conversations were written under a custom `JARVIS_DB_URL`,
  export it for the launcher too.

## Releasing a Mac preview build

The `.github/workflows/desktop-release.yml` workflow builds DMGs for
Apple Silicon and Intel Macs and (on tag pushes) attaches them to a
GitHub Release.

To cut a preview build:

```bash
git tag desktop-v0.1.0-preview.1
git push origin desktop-v0.1.0-preview.1
```

The workflow:

1. Builds the web UI with `JARVIS_DESKTOP_BUILD=1`.
2. Builds the `jarvis` server binary for the matching target triple.
3. Stages it under `apps/jarvis-desktop/binaries/jarvis-<triple>` so
   Tauri's `bundle.externalBin` picks it up and copies it inside the
   `.app` next to the desktop binary.
4. Runs `cargo tauri build --bundles dmg,app` per architecture.
5. Renames each DMG to `Jarvis-<tag>-macos-{arm64,x64}.dmg`,
   computes a `sha256`, and uploads the pair as release assets.

`workflow_dispatch` runs (manual triggers without a tag) only upload
the DMGs as workflow artifacts — no Release is created.

### Tester install

The release notes spell out the install flow, but in short:

1. Download the `.dmg` matching your CPU (`arm64` for Apple Silicon,
   `x64` for Intel).
2. Drag **Jarvis.app** into **Applications**.
3. The build is **unsigned** — clear the quarantine bit before first
   launch:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Jarvis.app
   ```
4. Export your provider API key in the shell that launches the app
   (the GUI launcher inherits the shell's env when invoked via
   `open`):
   ```sh
   export OPENAI_API_KEY=sk-...
   open /Applications/Jarvis.app
   ```

Tester-side troubleshooting follows the same matrix as the dev
section above (no API key, port collision, conversations dir).

## MVP Boundaries

Implemented:

- Tauri window loading `apps/jarvis-web/dist`
- icons (PNG + .icns + .ico, generated from a master via
  `scripts/generate_icons.py`)
- local server health check with stderr-tail diagnostics
- sidecar start/restart, with early-exit detection
- API origin injection
- native folder picker
- open/reveal path commands
- sidecar log buffer
- persisted desktop preferences (last-used workspace)
- launch-failure recovery overlay (auto-expanded server log tail,
  Retry, Choose workspace…)
- packaged `externalBin` (the `jarvis` server binary ships inside
  the `.app` — no separate install needed for testers)

Not implemented yet:

- tray menu
- code-signing / notarization (preview builds are unsigned)
- auto updater
- built-in terminal/PTTY
