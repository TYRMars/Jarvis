# `shell.exec` sandboxing

**Status:** v0 Adopted. `Sandbox` enum (`None` / `Auto` / `Bubblewrap` /
`SandboxExec`), per-OS backends, `Sandbox::Auto` runtime detection,
`ShellExecTool::with_sandbox`, `BuiltinsConfig::shell_sandbox`, and
`JARVIS_SHELL_SANDBOX` / `JARVIS_SHELL_NETWORK` env wiring all
landed. Container backend (Docker / Podman) and `setrlimit`-based
resource caps (cuts 5 + 6) remain follow-ups — they were carved out
to land independently without breaking the API.
**Touches:** `harness-tools::shell` (add backend strategies), new
`harness-tools/src/sandbox/` submodule with per-OS implementations,
`apps/jarvis` config wiring.

## Motivation

`shell.exec` today only enforces a path sandbox on `cwd` — once the
process launches, it inherits the host's file system, network, and
process privileges. The approval gate is the only safety net, which
is fine for dev-machine usage but **insufficient for any deployment
where the LLM's output isn't fully trusted** (multi-tenant, exposed
to user-supplied prompts, autonomous mode).

Concrete attack surfaces today:

- `rm -rf /` outside `JARVIS_FS_ROOT`.
- `curl … | sh` to exfiltrate or pull arbitrary code.
- Reading SSH keys, environment variables, AWS credentials.
- Forking long-running daemons that survive `kill_on_drop`.
- Network egress to anywhere.

The fix is process-level isolation, layered on top of the existing
path sandbox + approval gate.

## Goals

1. **OS-level filesystem confinement.** The process can read+write
   only paths under `JARVIS_FS_ROOT` (plus a small read-only allowlist
   for `/usr` / `/lib` / loader bits).
2. **Network egress disabled by default.** Optional allowlist.
3. **Resource caps.** Wall-clock timeout (already there), CPU time,
   RSS memory, max open files, max process count (defang fork bombs).
4. **Process-tree containment.** Child processes the LLM spawns are
   visible and reaped as a unit; nothing escapes when the parent
   times out.

Non-goals (v0):

- Full container isolation (separate PID/network/UTS namespaces with
  a layered rootfs). That's "ship a real container runtime", which
  is a much bigger project. v0 settles for "good enough for a
  per-developer / per-CI workspace, not for a public multi-tenant
  service".
- Defending against kernel-level escapes. We're using OS sandboxes,
  not VMs.

## Backend strategies

Layered choice driven by what's available on the host:

| OS | Primary | Fallback |
|---|---|---|
| Linux | `bubblewrap` (bind-mount sandbox) | `firejail`, then unsandboxed + warning |
| macOS | `sandbox-exec` with a hand-rolled SBPL profile | unsandboxed + warning |
| Windows | (out of scope) | unsandboxed + warning |

A separate, opt-in strategy uses **`docker run --rm`** or
**`podman run --rm`** with a pre-built image that has the project's
dev tools installed. Heavier but stronger isolation; useful for CI
and untrusted environments.

### Linux: `bubblewrap`

`bwrap --ro-bind /usr /usr --ro-bind /lib /lib \
       --bind <root> /workspace --chdir /workspace \
       --unshare-all --share-net? --die-with-parent \
       --new-session -- sh -c <command>`

- `--unshare-all` gives fresh PID/UTS/network/IPC/cgroup namespaces.
- `--die-with-parent` means our `kill_on_drop` actually kills the
  whole process tree.
- `--new-session` prevents tty stealing from a pty-attached parent.
- Rootless; no setuid bits required since Linux 4.18.

Trade-off: `bwrap` must be installed (Debian/Ubuntu: `bubblewrap`;
RHEL family: `bubblewrap`). Detect at startup; if missing, fall back
or error per config.

### macOS: `sandbox-exec`

Apple deprecated `sandbox-exec` in 10.15 but it still works (and is
what every dev tool that needs sandboxing on macOS still uses,
including `npm`'s and Cargo's experimental modes). SBPL profile:

```
(version 1)
(deny default)
(allow process-fork process-exec)
(allow file-read* (subpath "/usr") (subpath "/System") (subpath "/Library"))
(allow file-read*
       file-write*
       (subpath "/Users/<user>/<root>"))
(allow file-read*
       (subpath "/private/etc")
       (literal "/dev/null") (literal "/dev/urandom"))
(deny network*)
```

Wired via `sandbox-exec -p '<profile>' -- sh -c '<command>'`. Profile
templated at runtime with the actual `JARVIS_FS_ROOT`.

### Container backend (opt-in)

```
docker run --rm \
  --network=none \
  --memory=1g --cpus=1.0 --pids-limit=64 \
  -v <root>:/workspace -w /workspace \
  --user $(id -u):$(id -g) \
  jarvis-shell-runtime \
  sh -c "<command>"
```

`jarvis-shell-runtime` is a small Dockerfile shipped in the repo
(Alpine + project's typical dev tools — `git`, `bash`, `coreutils`,
the language toolchain you care about). Heavier startup (~200ms cold)
but the strongest isolation we can do without writing kernel code.

## API

`ShellExecTool` grows a `Sandbox` strategy. The existing
`ShellExecTool::new(root)` keeps working (no sandbox = current
behaviour, for back-compat). New constructors:

```rust
impl ShellExecTool {
    pub fn with_sandbox(mut self, sandbox: Sandbox) -> Self { ... }
}

#[non_exhaustive]
pub enum Sandbox {
    /// No process-level isolation. Path sandbox + approval gate
    /// only. Equivalent to current behaviour.
    None,
    /// Auto-detect the best available backend on this host.
    /// `bubblewrap` on Linux, `sandbox-exec` on macOS, `None` with
    /// a `warn!` log elsewhere.
    Auto,
    /// Linux: bubblewrap with `--unshare-all`, network off.
    Bubblewrap {
        allow_network: bool,
        ro_paths: Vec<PathBuf>,
    },
    /// macOS: sandbox-exec with the rolled SBPL profile, network off.
    SandboxExec { allow_network: bool },
    /// Run inside `docker run --rm` / `podman run --rm`.
    Container {
        runtime: ContainerRuntime, // Docker | Podman
        image: String,
        memory_mb: u32,
        cpus: f32,
        pids_limit: u32,
        allow_network: bool,
    },
}

pub enum ContainerRuntime { Docker, Podman }
```

Resource limits ride alongside (not on the enum, since they're
backend-agnostic):

```rust
pub struct ShellExecLimits {
    pub timeout: Duration,        // already there
    pub max_stdout_bytes: usize,  // already there
    pub max_stderr_bytes: usize,  // already there
    pub max_processes: Option<u32>,
    pub max_open_files: Option<u64>,
    pub rss_mb: Option<u64>,
}
```

For backends that don't natively limit (Auto/None on macOS):
implement softer caps via `setrlimit` on the child before exec.
`tokio::process::Command::pre_exec` (unsafe but supported) is the
hook.

## Config

Env-var wiring in `apps/jarvis`:

| Env | Effect |
|---|---|
| `JARVIS_SHELL_SANDBOX` | `none` (default), `auto`, `bubblewrap`, `sandbox-exec`, `docker`, `podman` |
| `JARVIS_SHELL_NETWORK` | `0` (default) / `1` |
| `JARVIS_SHELL_IMAGE` | image for container backends; defaults to `jarvis-shell-runtime` |
| `JARVIS_SHELL_MEMORY_MB` | default 1024 for container backends |
| `JARVIS_SHELL_CPUS` | default 1.0 |
| `JARVIS_SHELL_PIDS` | default 64 |
| `JARVIS_SHELL_RO_PATHS` | colon-separated read-only allow-list paths |

Defaults are conservative: **network off, memory 1G, CPU 1, PIDs 64**.
Explicit override required to relax.

## Implementation cuts

1. **`Sandbox::None` is current behaviour.** Refactor
   `ShellExecTool` to thread a `Sandbox` enum through `invoke`.
   Default constructor maps to `None`. Existing tests stay green.
   ~80 LOC.
2. **`Sandbox::SandboxExec` (macOS).** Hand-rolled SBPL profile
   templated at construction time. Tests: run `whoami`, `pwd`,
   verify cwd matches; run `ls /etc` and verify denial; run with
   `allow_network: false` and verify a `curl` to localhost fails.
   ~120 LOC. (Run only on macOS in CI via `cfg(target_os)`.)
3. **`Sandbox::Bubblewrap` (Linux).** Mirror tests. ~100 LOC.
4. **`Sandbox::Auto`.** Detect `which bwrap` / `which sandbox-exec`
   at provider construction; fall back with a `warn!`. ~40 LOC.
5. **Resource caps via `pre_exec` + `setrlimit`.** Pure Rust, works
   regardless of backend. ~80 LOC.
6. **`Sandbox::Container`.** Build / require the
   `jarvis-shell-runtime` image; thread args; tests use a stubbed
   runtime when Docker isn't available in CI. ~150 LOC + Dockerfile.
7. **Tool API: `requires_approval` stays true.** Sandboxing is
   defence in depth, not a substitute for the approver. Document
   this loud in the tool description.
8. **Integration test harness.** A small dummy command set per OS
   that exercises the failure modes (write outside root, network,
   fork bomb). Runs on each backend in matrix CI.

## Performance

| Backend | Cold start overhead | Per-call overhead |
|---|---|---|
| None | 0 | 0 |
| sandbox-exec | ~5-15 ms | ~5 ms |
| bwrap | ~5-20 ms | ~5 ms |
| Container (Docker) | ~150-400 ms | ~150 ms |

Acceptable for everything except very-high-frequency tool use. If a
real workload shows the container backend is too slow, we add a
"warm pool" of paused containers (separate proposal).

## Risks / open questions

- **macOS deprecation of `sandbox-exec`.** Apple flagged it years ago
  and hasn't removed it. There's no public successor; if it
  disappears, the macOS path falls back to the container backend.
  Document the dependency clearly in `CLAUDE.md`.
- **`bwrap` on RHEL-family hosts.** Available but in the
  `bubblewrap` package on EPEL — not always installed. CI matrix
  must verify the fallback path actually fails-safe.
- **Container backend in CI.** Docker-in-Docker is fiddly. Use
  rootless Podman on GitHub Actions runners; document the dance.
- **Rebuilding the image.** `jarvis-shell-runtime` should be pinned
  by content hash, not floating tag, so the LLM can't rely on
  package versions changing.
- **Network allowlist.** `--unshare-all` cuts all DNS too. If
  `allow_network: true`, we'd need to drop `--unshare-net` and
  arrange for `nslookup` etc. to work. For containers,
  `--network=none` is symmetric. A finer-grained allowlist (only
  outbound to `*.crates.io`, say) is iptables / nftables territory
  — out of scope for v0.
- **`shell.exec` semantics shift.** Some scripts that work today
  will fail under sandboxing. Document loudly when enabling — and
  make sure the "tool denied"-style error carries the sandbox
  reason ("permission denied: outside root") so the model adapts.

## Out of scope

- Per-tenant resource accounting / quotas.
- Persistent sandboxed shells (long-lived REPL inside the sandbox).
- gVisor / firecracker / VM-level isolation.
- Egress filtering finer than "on / off".
