# Onboarding & distribution — "openclaw-quality startup"

**Status:** PR 1 + PR 2 + PR 3 Adopted —
config-file loader, `clap` subcommand structure, `jarvis init`
interactive wizard, `jarvis status` pretty-print, per-provider
auth-file store with env-var fallback into `jarvis serve`, and the
native PKCE Codex login (`jarvis login --provider codex`,
including a `--device-code` mode for headless) all landed. The
codex serve path now prefers `~/.config/jarvis/auth/codex.json`
over `~/.codex/auth.json` so jarvis owns the credential lifecycle
end-to-end. PR 4 (release binaries + install script + Homebrew)
remains Proposed.
**Touches:** `apps/jarvis` (subcommand structure, config loader,
interactive prompts, OAuth login server), new
`crates/harness-config/` for the config-file shape, GitHub Actions
release workflow, install scripts.

## Why

Jarvis today is shaped like a developer tool: `git clone`, `cargo
build`, `export OPENAI_API_KEY=...`, `cargo run -p jarvis`. That's
fine for someone hacking on the harness itself, but a user who just
wants to run an agent on their machine sees ~5 friction points before
the first prompt.

OpenClaw (and the official Codex CLI) set the bar:

```
$ brew install openclaw          # or curl-pipe-sh
$ openclaw onboard               # interactive picker, opens browser
$ openclaw                       # just runs
```

Three specific frictions to remove:

1. **Distribution.** No pre-built binary. Anyone without a Rust
   toolchain hits a wall.
2. **Auth.** For non-Codex providers we ask the user to wrangle env
   vars. For Codex we shell out to OpenAI's `codex login` and read
   `~/.codex/auth.json` — fine for power users, awkward for first
   contact.
3. **Configuration.** Every preference is an env var. There's no
   "set once, forget" file. `JARVIS_FS_ROOT=$(pwd)` in particular
   has to be redone every shell session.

Goal: bring all three to OpenClaw parity without compromising the
"power users keep using env vars and get reproducible behaviour"
property.

## Product alignment

Onboarding should set up Jarvis as a Chat / Work / Doc workspace, not
as a coding-only CLI. The first-run flow still asks for a workspace
root because Work and Coding capability need one, but the language and
defaults should make the broader product clear:

- choose provider/model once for all product surfaces;
- choose initial capabilities (`coding`, `office`, `research`);
- choose persistence so Chat conversations, TODO/Work state, and Doc
  drafts can survive restarts;
- open the Web UI at the product home rather than a coding-specific
  screen.

## Target UX

```
# install
$ brew install jarvis              # macOS
$ curl -fsSL https://.../install.sh | sh   # Linux
# (or `cargo install jarvis-cli` for the Rust crowd)

$ jarvis init
? Choose a provider:
  ▸ openai (API key)
    openai-responses (API key, reasoning models)
    anthropic (API key)
    google (API key)
    codex (ChatGPT subscription, OAuth)
  Enter selected.

? Provider: codex
  Opening https://auth.openai.com/oauth/authorize?... in your browser.
  Waiting for callback on http://localhost:1455/auth/callback ...
  ✓ Logged in as alice@example.com (workspace acct_abc)

? Default model: gpt-5-codex-mini
? Workspace root for fs.* tools: /Users/alice/projects/foo
? Enable file-edit / shell-exec tools (gated by approval)? Yes
? Persist conversations? Yes (sqlite at ~/.local/share/jarvis/db.sqlite)
? Memory budget: 8000 tokens (window)
? Approval mode: deny by default; WS clients can override interactively

  ✓ Configuration written to ~/.config/jarvis/config.toml
  ✓ Credentials stored in ~/.config/jarvis/auth/codex.json

  Run `jarvis` to start the server, or `jarvis --help` for more.

$ jarvis
INFO jarvis: provider=codex model=gpt-5-codex-mini
INFO jarvis: listening on http://127.0.0.1:7001
INFO jarvis: open http://localhost:7001/ui/ to chat
```

Auxiliary commands:

| Command | What |
|---|---|
| `jarvis` (default) | Same as `jarvis serve` — start HTTP server reading config |
| `jarvis init` | Interactive onboarding (writes config + auth) |
| `jarvis login [--provider X]` | Just the auth step (re-login / switch account) |
| `jarvis logout [--provider X]` | Drop credentials |
| `jarvis status` | Show current config + auth state (which provider, expiry, fs root, etc.) |
| `jarvis serve` | Explicit form of default; allows flags |
| `jarvis chat` | (covered by [cli.md](cli.md)) — TUI/REPL frontend; doesn't need server |
| `jarvis --mcp-serve` | Existing MCP stdio mode (renamed: `jarvis mcp-serve`) |

## Config file

Path resolution (first hit wins):

1. `--config <path>` flag
2. `$JARVIS_CONFIG`
3. `$XDG_CONFIG_HOME/jarvis/config.toml`
4. `~/.config/jarvis/config.toml` (macOS / Linux)
5. `%APPDATA%\jarvis\config.toml` (Windows)

Format: TOML. Per-provider sections so secrets aren't co-mingled with
preferences. Example:

```toml
# ~/.config/jarvis/config.toml

[server]
addr = "127.0.0.1:7001"        # default 0.0.0.0:7001

[provider]
default = "codex"
model   = "gpt-5-codex-mini"   # overrides each provider's default

[provider.codex]
# auth lives separately at ~/.config/jarvis/auth/codex.json so this
# file can be committed / shared without leaking tokens.
reasoning_summary = "auto"
include_encrypted_reasoning = true

[provider.openai]
base_url = "https://api.openai.com/v1"
# api_key NOT stored here — use auth/openai.json or OPENAI_API_KEY env

[tools]
fs_root          = "/Users/alice/projects/foo"
enable_fs_write  = false
enable_fs_edit   = true
enable_shell_exec = true

[memory]
tokens = 8000
mode   = "window"

[persistence]
url = "sqlite:///Users/alice/.local/share/jarvis/db.sqlite"

[approval]
mode = "deny"

[mcp_servers]
fs   = "uvx mcp-server-filesystem /tmp"
git  = "uvx mcp-server-git"
```

**Layering rules** (highest precedence wins):

1. Command-line flags (`--addr`, `--model`, …)
2. Environment variables (existing `JARVIS_*`)
3. Config file
4. Built-in defaults

This preserves the current "env vars work" property — operators with
existing scripts don't need to migrate. Config file is purely
additive.

### Auth file

Per-provider, separate from the main config:

```
~/.config/jarvis/auth/
  codex.json     # { access_token, refresh_token, account_id, ... }
  openai.json    # { api_key }
  anthropic.json
  google.json
```

`auth.json` files have mode `0600` and are written via write-temp +
rename atomically (same pattern as the existing
`codex_auth::write_back`).

For Codex specifically: the file format mirrors the existing
`~/.codex/auth.json` shape so power users can copy between Jarvis
and the official Codex CLI if they want. We **don't** read from
`~/.codex/auth.json` anymore by default once Jarvis owns its own
flow — but we keep an env-var fallback for migration:

```bash
JARVIS_USE_CODEX_CLI_AUTH=1   # read ~/.codex/auth.json instead
```

## OAuth flow (Codex)

Reproduce what `codex-rs/login/src/server.rs` does:

```rust
// crates/harness-codex-auth/src/oauth.rs (new)
pub async fn login_via_browser() -> Result<CodexAuth> {
    let (verifier, challenge) = pkce::generate_s256();
    let state = random_url_safe(32);

    let listener = TcpListener::bind("127.0.0.1:1455").await?;
    let port = 1455;
    let redirect = format!("http://localhost:{port}/auth/callback");

    let url = format!(
        "https://auth.openai.com/oauth/authorize\
         ?response_type=code\
         &client_id={CLIENT_ID}\
         &scope=openid+profile+email+offline_access\
            +api.connectors.read+api.connectors.invoke\
         &redirect_uri={redirect}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann",   // shared with codex CLI
    );
    open::that(&url)?;     // best-effort open in default browser
    println!("If your browser didn't open, visit: {url}");

    let code = wait_for_callback(&listener, &state).await?;

    let tokens = exchange_code(code, verifier, redirect).await?;
    let account_id = parse_id_token_for_account(&tokens.id_token);

    Ok(CodexAuth {
        access_token: tokens.access_token,
        refresh_token: Some(tokens.refresh_token),
        account_id,
        persist_path: Some(default_codex_auth_path()),
    })
}
```

The loopback server displays a small HTML success page on the
callback so the user knows to switch back to the terminal.

`open::that()` (the `open` crate) handles macOS / Linux / Windows
default-browser opening. ~10 KB binary impact, worth it.

For headless flows (CI, SSH-without-X), fall back to **device-code
auth** (also in `codex-rs/login/src/device_code_auth.rs`):

```
$ jarvis login --device-code
  Visit: https://auth.openai.com/device
  Enter code: ABCD-WXYZ
  Waiting...
  ✓ Logged in
```

## Distribution

### GitHub Releases (machine-built)

`.github/workflows/release.yml`: on `git tag v*`, build with
`cross` for:

| Triple | Asset |
|---|---|
| `x86_64-unknown-linux-gnu` | `jarvis-x86_64-linux.tar.gz` |
| `aarch64-unknown-linux-gnu` | `jarvis-aarch64-linux.tar.gz` |
| `x86_64-apple-darwin` | `jarvis-x86_64-macos.tar.gz` |
| `aarch64-apple-darwin` | `jarvis-aarch64-macos.tar.gz` |
| `x86_64-pc-windows-msvc` | `jarvis-x86_64-windows.zip` |

Each archive contains:

```
jarvis           # the binary; embeds apps/jarvis-web/ via include_dir!
README.md
LICENSE
```

### Install script

Hosted at the repo root or a small Cloudflare Pages site:

```sh
# install.sh — pinned to a release tag
set -e
TAG="${JARVIS_VERSION:-latest}"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
URL="https://github.com/.../releases/download/${TAG}/jarvis-${ARCH}-${OS}.tar.gz"
curl -fsSL "$URL" | tar -xz -C "${PREFIX:-/usr/local/bin}"
echo "Installed jarvis. Run 'jarvis init' to get started."
```

### Homebrew

```ruby
# Formula/jarvis.rb
class Jarvis < Formula
  desc "Local agent runtime: pluggable LLM providers, tools, memory"
  homepage "https://github.com/.../jarvis"
  version "0.1.0"
  if OS.mac?
    if Hardware::CPU.arm?
      url "https://github.com/.../releases/download/v0.1.0/jarvis-aarch64-macos.tar.gz"
      sha256 "..."
    else
      url "..."
      sha256 "..."
    end
  end
  def install
    bin.install "jarvis"
  end
end
```

Lives in a separate `homebrew-jarvis` tap (or push to homebrew-core
when stable enough — that requires usage signals).

### `cargo install`

For Rust users:

```bash
cargo install jarvis-cli   # publishes apps/jarvis as a binary crate
```

Requires renaming `apps/jarvis` package to `jarvis-cli` for crates.io
namespace (or just `jarvis` if available).

## Subcommand structure

Use `clap` derive. Sketch:

```rust
#[derive(Parser)]
#[command(name = "jarvis", version, about)]
struct Cli {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Cmd>,    // None → default to Serve
}

#[derive(Subcommand)]
enum Cmd {
    /// Interactive onboarding: pick provider, log in, write config.
    Init { #[arg(long)] force: bool },
    /// Authenticate with a provider. Defaults to the configured one.
    Login {
        #[arg(long)] provider: Option<String>,
        #[arg(long)] device_code: bool,
    },
    /// Drop stored credentials.
    Logout { #[arg(long)] provider: Option<String> },
    /// Print current config + auth state.
    Status,
    /// Run the HTTP server (default if no subcommand).
    Serve {
        #[arg(long)] addr: Option<SocketAddr>,
        #[arg(long)] model: Option<String>,
    },
    /// Run as MCP server on stdio.
    McpServe,
}
```

`apps/jarvis/src/main.rs` becomes a small dispatcher; the existing
"build provider, agent, app state, serve" logic moves into
`apps/jarvis/src/serve.rs`.

## Phased MVP

I'd ship this as **four PRs**, each independently useful, each
~200-400 LOC.

### PR 1 — Config file + clap subcommands

- `clap` dep
- `apps/jarvis/src/config.rs` — `Config` struct (mirrors env vars,
  TOML deserialise, layered defaults → file → env → flags)
- Wire subcommand structure (`Init`, `Login`, `Logout`, `Status`,
  `Serve`, `McpServe`); `Init`/`Login`/`Logout`/`Status` are stubs
  returning "not yet implemented"
- `Serve` reads config and runs the existing logic
- Backwards compat: env vars still work, no config file required
- Doc the config schema in the user guide

After this: `jarvis serve` works, env-var users see no change.
Subcommand surface exists for the next PRs.

### PR 2 — `jarvis init` + `jarvis status`

- `dialoguer` dep for interactive prompts
- Write the config file via `Init`
- `Status` reads + pretty-prints
- For provider auth: prompt for API key, store in `auth/<provider>.json`
- For Codex provider in this PR: detect `~/.codex/auth.json` and
  reuse it (Path A from the existing implementation); the proper
  PKCE login lands in PR 3

After this: most users (everyone except Codex) get a one-shot
onboard. Codex users still depend on `codex login`.

### PR 3 — `jarvis login --provider codex` proper PKCE flow

- `pkce` + `open` deps (or hand-roll PKCE; it's ~30 LOC)
- Loopback server on 127.0.0.1:1455
- Browser open + callback handler
- Token exchange against `auth.openai.com/oauth/token`
- Write `~/.config/jarvis/auth/codex.json`
- `--device-code` mode for headless

After this: Jarvis owns its Codex auth. `codex` CLI no longer
required.

### PR 4 — Pre-built binaries + install script

- `.github/workflows/release.yml` with `cross` matrix
- Smoke-test step: download artifact, `jarvis status` succeeds
- `install.sh` with `JARVIS_VERSION` env override
- Homebrew tap (separate repo) — push the formula

After this: `brew install jarvis` works. `cargo install` from
crates.io as a parallel option (PR 4a, smaller).

## Risks / open questions

- **`dialoguer` adds compile time + binary size**. ~150 KB and a
  pull from the indicatif ecosystem. Worth it for a real onboard
  UX. Alternative: hand-roll with `std::io::stdin` + ANSI escapes
  (less dep, more code).
- **Cross-compilation for arm64-linux on macOS hosts**. `cross`
  handles this, but the action runs longer. CI matrix needs ~10
  min budget.
- **Homebrew formula publishing requires manual review** for
  homebrew-core; a self-tap is instant but users have to
  `brew tap` first. For v0 the self-tap is fine.
- **`open` crate behavior on headless Linux** — falls back to
  printing the URL. Document.
- **PKCE refresh-on-401 logic stays in `codex_auth.rs`** — the
  login command just produces the initial `auth.json`; existing
  refresh code keeps working unchanged.
- **`crates.io` namespace**. `jarvis` may already be taken
  (it isn't currently — verified — but worth confirming before
  PR 4a). Falls back to `jarvis-cli` if needed.
- **Telemetry / first-run consent**. Out of scope — Jarvis collects
  zero telemetry, and we don't want to start.

## Out of scope

- Auto-update (`jarvis self-update`) — meaningful but separate.
- Service install / launchd / systemd unit — let users wire that.
- GUI installer (`.dmg`, `.msi`) — too much surface for v0.
- TUI chat front-end — already covered by [cli.md](cli.md);
  `jarvis chat` delegates to that work when it lands.

## Sources / references

- OpenClaw `models auth login` flow:
  [openclaw/openclaw#32065](https://github.com/openclaw/openclaw/pull/32065)
- OpenAI Codex CLI PKCE implementation:
  [openai/codex `codex-rs/login/src/server.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)
- `dialoguer` interactive prompt crate
- `cross` cross-compilation tool
