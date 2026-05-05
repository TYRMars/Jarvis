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

Not implemented yet:

- tray menu
- packaged `externalBin`
- auto updater
- built-in terminal/PTTY
