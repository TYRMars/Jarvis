//! Shell command execution tool.
//!
//! Spawns a child process via `sh -c` (or `cmd /C` on Windows), captures
//! stdout and stderr separately, and enforces a timeout. The optional
//! `cwd` argument is resolved under the tool's root and rejected if it
//! escapes the path sandbox. Output is truncated per stream so a runaway
//! command can't explode the conversation.
//!
//! On top of the path sandbox, an optional process-level [`Sandbox`]
//! wraps each invocation in a host-OS isolation primitive (`bwrap` on
//! Linux, `sandbox-exec` on macOS) that confines filesystem and
//! network access. See [`docs/proposals/sandboxing.md`] for the full
//! design.
//!
//! Intentionally not registered by default in `register_builtins` — opt
//! in via `BuiltinsConfig::enable_shell_exec`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use harness_core::{
    emit_progress_to, progress_sender, BoxError, Tool, ToolCategory, ToolProgress,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::warn;

use crate::sandbox::resolve_under;

const DEFAULT_MAX_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// OS-level isolation strategy applied around every [`ShellExecTool`]
/// invocation. Backends layer on top of the path sandbox + approval
/// gate; they don't replace either.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub enum Sandbox {
    /// No process-level isolation. Path sandbox + approval gate only.
    /// Equivalent to the historical behaviour and the safe default
    /// for single-user dev workflows.
    None,
    /// Pick the best available backend at construction time:
    /// `Bubblewrap` on Linux when `bwrap` is in `$PATH`,
    /// `SandboxExec` on macOS, `None` (with a `warn!`) elsewhere.
    Auto { allow_network: bool },
    /// Linux: wrap the command in `bwrap --unshare-all --die-with-parent`
    /// with the tool root bind-mounted read-write. Network is dropped
    /// unless `allow_network = true`.
    Bubblewrap { allow_network: bool },
    /// macOS: wrap the command in `sandbox-exec` with a generated SBPL
    /// profile that allows reads under `/usr` / `/System` / `/Library`,
    /// reads + writes under the tool root, and (by default) denies
    /// network egress.
    SandboxExec { allow_network: bool },
}

impl Sandbox {
    /// Resolve `Auto` to a concrete backend at runtime. Cheap to call
    /// per-invocation but typically resolved once at provider startup.
    pub fn resolve(self) -> Sandbox {
        match self {
            Sandbox::Auto { allow_network } => {
                #[cfg(target_os = "linux")]
                {
                    if which("bwrap").is_some() {
                        return Sandbox::Bubblewrap { allow_network };
                    }
                    warn!(
                        "JARVIS_SHELL_SANDBOX=auto but `bwrap` not in PATH; falling back to none"
                    );
                    Sandbox::None
                }
                #[cfg(target_os = "macos")]
                {
                    if which("sandbox-exec").is_some() {
                        return Sandbox::SandboxExec { allow_network };
                    }
                    warn!("JARVIS_SHELL_SANDBOX=auto but `sandbox-exec` not found; falling back to none");
                    Sandbox::None
                }
                #[cfg(not(any(target_os = "linux", target_os = "macos")))]
                {
                    let _ = allow_network;
                    warn!("JARVIS_SHELL_SANDBOX=auto: no backend on this OS; falling back to none");
                    Sandbox::None
                }
            }
            other => other,
        }
    }
}

/// Cheap `which`-style lookup. Used by `Auto` resolution; isolated so
/// we don't pull a `which` crate just for this.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// OS-level resource caps applied to each child via `setrlimit` in a
/// `pre_exec` hook. All fields optional — `None` means "leave the
/// inherited limit alone". Defaults are conservative for an LLM-driven
/// shell and unlikely to surprise day-to-day workflows; a build that
/// hits them probably wants `JARVIS_SHELL_*` overrides anyway.
#[derive(Debug, Clone, Default)]
pub struct ShellLimits {
    /// Hard CPU-time cap in seconds. `RLIMIT_CPU` sends SIGXCPU on
    /// the soft limit and SIGKILL on the hard limit; we set both to
    /// the same value so a runaway loop dies cleanly.
    pub cpu_seconds: Option<u64>,
    /// Hard virtual address-space cap in bytes (`RLIMIT_AS`). Acts
    /// like a memory ceiling — `mmap` / `brk` past this fails. Not
    /// equivalent to RSS but easier to enforce portably.
    pub address_space_bytes: Option<u64>,
    /// Cap on file descriptors the child can open (`RLIMIT_NOFILE`).
    pub max_open_files: Option<u64>,
    /// Cap on processes the child's UID can run (`RLIMIT_NPROC`).
    /// Defangs fork bombs but counts globally per-UID, so a low value
    /// can wedge unrelated processes — leave generous.
    pub max_processes: Option<u64>,
}

impl ShellLimits {
    /// Sensible defaults for an interactive coding agent: 60 s CPU,
    /// 2 GB virtual memory, 256 fds, 256 procs.
    pub fn safe_defaults() -> Self {
        Self {
            cpu_seconds: Some(60),
            address_space_bytes: Some(2 * 1024 * 1024 * 1024),
            max_open_files: Some(256),
            max_processes: Some(256),
        }
    }

    /// True iff at least one limit is set; cheap pre-check so the
    /// `pre_exec` closure isn't installed when there's nothing to do.
    fn any(&self) -> bool {
        self.cpu_seconds.is_some()
            || self.address_space_bytes.is_some()
            || self.max_open_files.is_some()
            || self.max_processes.is_some()
    }
}

/// Run a shell command. Stdout and stderr are captured separately; both are
/// truncated to `max_bytes` per stream. The command is killed if it runs
/// longer than `timeout_ms`.
pub struct ShellExecTool {
    root: PathBuf,
    max_bytes: usize,
    default_timeout_ms: u64,
    sandbox: Sandbox,
    limits: ShellLimits,
}

impl ShellExecTool {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: DEFAULT_MAX_BYTES,
            default_timeout_ms: DEFAULT_TIMEOUT_MS,
            sandbox: Sandbox::None,
            limits: ShellLimits::default(),
        }
    }

    pub fn with_max_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n;
        self
    }

    pub fn with_default_timeout_ms(mut self, ms: u64) -> Self {
        self.default_timeout_ms = ms;
        self
    }

    /// Wrap each invocation in a host-OS isolation primitive (see
    /// [`Sandbox`]). Approval still gates the call separately —
    /// sandboxing is defence in depth, not a substitute.
    pub fn with_sandbox(mut self, sandbox: Sandbox) -> Self {
        self.sandbox = sandbox.resolve();
        self
    }

    /// Apply OS resource caps via `setrlimit` in the child's
    /// `pre_exec` hook. No-op on Windows. See [`ShellLimits`].
    pub fn with_limits(mut self, limits: ShellLimits) -> Self {
        self.limits = limits;
        self
    }
}

#[async_trait]
impl Tool for ShellExecTool {
    fn name(&self) -> &str {
        "shell.exec"
    }

    fn requires_approval(&self) -> bool {
        true
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Exec
    }

    fn summary_for_audit(&self, args: &serde_json::Value) -> Option<String> {
        args.get("command")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    }

    fn description(&self) -> &str {
        "Run a shell command (`sh -c` on unix, `cmd /C` on windows). \
         `cwd` is relative to the tool root; absolute paths and `..` are \
         rejected. Returns exit code, stdout, and stderr (each truncated). \
         Killed after `timeout_ms` (default 30000)."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line passed to `sh -c` / `cmd /C`."
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory, relative to the tool root."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Timeout in milliseconds. Defaults to 30000."
                }
            },
            "required": ["command"]
        })
    }

    fn cacheable(&self) -> bool {
        true
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| -> BoxError { "missing `command` argument".into() })?;

        let root = harness_core::active_workspace_or(&self.root);
        let cwd = match args.get("cwd").and_then(Value::as_str) {
            Some(rel) => resolve_under(&root, rel)?,
            None => root.clone(),
        };

        let timeout_ms = args
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(self.default_timeout_ms);

        let mut cmd = build_command(command, &root, &cwd, &self.sandbox)?;
        cmd.current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_limits(&mut cmd, &self.limits);

        let mut child = cmd.spawn()?;

        // Stream stdout / stderr line-by-line. Each line is emitted
        // to the agent's progress channel (becomes a `ToolProgress`
        // event the client renders in real time) AND accumulated for
        // the final return value the model reads. Truncation still
        // happens — but on the *accumulated* buffer, not on the
        // stream, so the user sees every byte live before we trim
        // for the model.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| -> BoxError { "no stdout pipe".into() })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| -> BoxError { "no stderr pipe".into() })?;
        let max_bytes = self.max_bytes;
        // Grab the sender from the task_local **here**, on the
        // agent's task. The reader sub-tasks (`tokio::spawn` below)
        // run on their own slots and can't access the parent's
        // `task_local`, so we forward an explicit clone instead.
        let prog = progress_sender();

        let stdout_task = tokio::spawn(stream_pipe(stdout, "stdout", max_bytes, prog.clone()));
        let stderr_task = tokio::spawn(stream_pipe(stderr, "stderr", max_bytes, prog));

        let exit_status =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(format!("process error: {e}").into()),
                Err(_) => {
                    // Timeout: drop the child to fire `kill_on_drop`,
                    // then bubble the error. The streaming tasks abort
                    // cleanly when the pipes close.
                    drop(child);
                    return Err(format!("timed out after {timeout_ms} ms").into());
                }
            };

        let (stdout_buf, sout_truncated, stdout_total) = stdout_task
            .await
            .map_err(|e| -> BoxError { format!("stdout join: {e}").into() })?;
        let (stderr_buf, serr_truncated, stderr_total) = stderr_task
            .await
            .map_err(|e| -> BoxError { format!("stderr join: {e}").into() })?;

        let exit = exit_status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());

        let mut s = String::new();
        s.push_str(&format!("exit={exit}\n"));
        s.push_str(&format!("--- stdout ({stdout_total} bytes) ---\n"));
        s.push_str(&stdout_buf);
        if sout_truncated {
            s.push_str(&format!(
                "\n[... stdout truncated at {max_bytes} bytes ...]"
            ));
        }
        s.push_str(&format!("\n--- stderr ({stderr_total} bytes) ---\n"));
        s.push_str(&stderr_buf);
        if serr_truncated {
            s.push_str(&format!(
                "\n[... stderr truncated at {max_bytes} bytes ...]"
            ));
        }
        Ok(s)
    }
}

/// Read `pipe` line-by-line, emit each chunk on the explicit
/// `prog` channel (cloned from the agent's task_local — see
/// `invoke`), and accumulate up to `max_bytes` for the final
/// return value. The `bool` is `true` when the byte budget was
/// exceeded; the third element is the *full* observed byte count
/// (so the formatted summary stays accurate even after truncation).
async fn stream_pipe<R>(
    pipe: R,
    label: &'static str,
    max_bytes: usize,
    prog: Option<mpsc::UnboundedSender<ToolProgress>>,
) -> (String, bool, usize)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(pipe).lines();
    let mut buf = String::new();
    let mut total = 0usize;
    let mut truncated = false;
    while let Ok(Some(line)) = reader.next_line().await {
        total += line.len() + 1; // +1 for the stripped newline
                                 // Live emit happens regardless of truncation — the user
                                 // gets to watch the whole thing scroll, even when the
                                 // agent's view is going to be clipped.
        if let Some(tx) = &prog {
            emit_progress_to(tx, label, format!("{line}\n"));
        }
        if !truncated {
            if buf.len() + line.len() + 1 > max_bytes {
                truncated = true;
            } else {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    }
    (buf, truncated, total)
}

/// Install a `pre_exec` hook on the child that calls `setrlimit` for
/// each configured cap. Runs *after* `fork` and *before* `execve`
/// inside the child, so failures only kill the soon-to-be-replaced
/// process — no impact on the parent. We swallow setrlimit errors
/// (logging via stderr would intersperse with the child's output);
/// the most likely cause of failure is a parent rlimit already
/// stricter than what we're trying to set, in which case the kid is
/// already as locked-down as we wanted.
#[cfg(unix)]
fn apply_limits(cmd: &mut Command, limits: &ShellLimits) {
    if !limits.any() {
        return;
    }
    let limits = limits.clone();
    // SAFETY: pre_exec runs in the child between fork and execve.
    // We must be async-signal-safe — `libc::setrlimit` is on POSIX.
    // tokio's Command exposes `pre_exec` directly (no `CommandExt`
    // trait import needed since the `process` feature is on).
    unsafe {
        cmd.pre_exec(move || {
            if let Some(secs) = limits.cpu_seconds {
                set_one(libc::RLIMIT_CPU, secs);
            }
            if let Some(bytes) = limits.address_space_bytes {
                set_one(libc::RLIMIT_AS, bytes);
            }
            if let Some(n) = limits.max_open_files {
                set_one(libc::RLIMIT_NOFILE, n);
            }
            if let Some(n) = limits.max_processes {
                set_one(libc::RLIMIT_NPROC, n);
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn apply_limits(_cmd: &mut Command, _limits: &ShellLimits) {
    // Windows: `setrlimit` doesn't exist; the equivalent (job objects
    // + memory caps) is a much bigger lift. No-op for now.
}

// Linux's libc declares the rlimit-resource arg as `__rlimit_resource_t`
// (a typedef for `c_uint`), while macOS / BSD use plain `c_int`. The
// `RLIMIT_*` constants follow the platform's type, so we mirror that
// alias to keep `set_one` generic across both.
#[cfg(all(unix, target_os = "linux"))]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(target_os = "linux")))]
type RlimitResource = libc::c_int;

#[cfg(unix)]
fn set_one(resource: RlimitResource, value: u64) {
    let rl = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    // SAFETY: `setrlimit` takes a valid pointer; struct is on stack
    // and outlives the call. Errors are deliberately ignored — see
    // `apply_limits` doc.
    unsafe {
        libc::setrlimit(resource, &rl);
    }
}

/// Construct the `tokio::process::Command` that ultimately runs `inner`,
/// optionally wrapped in an OS-level sandbox. The plain (`Sandbox::None`)
/// branch matches the historical behaviour byte-for-byte; backends
/// emit longer argv but execute the same `sh -c <inner>` payload.
fn build_command(
    inner: &str,
    root: &Path,
    cwd: &Path,
    sandbox: &Sandbox,
) -> Result<Command, BoxError> {
    if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(inner);
        return Ok(c);
    }

    match sandbox {
        Sandbox::None => {
            let mut c = Command::new("sh");
            c.arg("-c").arg(inner);
            Ok(c)
        }
        Sandbox::Auto { .. } => {
            // `with_sandbox` already calls `resolve()`, so `Auto` should
            // never reach here. Treat as a bug rather than silently
            // running unsandboxed.
            Err("Sandbox::Auto must be resolved before use; call `Sandbox::resolve()`".into())
        }
        Sandbox::Bubblewrap { allow_network } => {
            Ok(build_bubblewrap(inner, root, cwd, *allow_network))
        }
        Sandbox::SandboxExec { allow_network } => {
            Ok(build_sandbox_exec(inner, root, *allow_network))
        }
    }
}

/// `bwrap` invocation: deny by default, then bind-mount what we
/// actually need.
///
/// - `--ro-bind /usr /usr` (and friends) keep system tools available
///   for read.
/// - `--bind <root> <root>` makes the project tree read-write at the
///   same path so relative `cwd` resolution stays meaningful for the
///   model.
/// - `--unshare-all` cuts the network unless `allow_network` is set,
///   in which case we explicitly re-share the net namespace.
/// - `--die-with-parent` lets `kill_on_drop` actually kill the whole
///   process tree on timeout.
fn build_bubblewrap(inner: &str, root: &Path, cwd: &Path, allow_network: bool) -> Command {
    let root_str = root.display().to_string();
    let cwd_str = cwd.display().to_string();

    let mut c = Command::new("bwrap");
    // Read-only bind for the standard system tree. Each path is gated
    // with `--ro-bind-try` so missing directories on minimal distros
    // don't abort the launch.
    for ro in ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"] {
        c.arg("--ro-bind-try").arg(ro).arg(ro);
    }
    // Project root is read-write at the same path the host sees, so
    // relative cwd works.
    c.arg("--bind").arg(&root_str).arg(&root_str);
    // Minimal /dev + /proc.
    c.arg("--dev").arg("/dev");
    c.arg("--proc").arg("/proc");
    c.arg("--tmpfs").arg("/tmp");
    // Namespace + lifecycle hardening.
    c.arg("--unshare-all");
    if allow_network {
        c.arg("--share-net");
    }
    c.arg("--die-with-parent");
    c.arg("--new-session");
    c.arg("--chdir").arg(&cwd_str);
    c.arg("--").arg("sh").arg("-c").arg(inner);
    c
}

/// `sandbox-exec` invocation. The SBPL profile is generated at
/// runtime so the project root can be inlined as a literal subpath —
/// substituting a string into a parsed S-expression after the fact is
/// brittle, and Apple's `sandbox-exec -p '<profile>'` accepts the
/// profile inline. Apple deprecated this in 10.15 but it's still the
/// only built-in option; if it ever disappears, `Auto` falls back
/// silently to `None`.
fn build_sandbox_exec(inner: &str, root: &Path, allow_network: bool) -> Command {
    let profile = sandbox_exec_profile(root, allow_network);
    let mut c = Command::new("sandbox-exec");
    c.arg("-p").arg(profile).arg("sh").arg("-c").arg(inner);
    c
}

fn sandbox_exec_profile(root: &Path, allow_network: bool) -> String {
    // Canonicalise to the absolute form sandbox-exec sees; if
    // canonicalisation fails (e.g. root deleted between construction
    // and invocation), fall back to the literal path — denying
    // everything is the safer default than crashing the call.
    let abs_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root_lit = abs_root.display().to_string();
    let escaped_root = root_lit.replace('\\', "\\\\").replace('"', "\\\"");

    let network_clause = if allow_network {
        "(allow network*)"
    } else {
        "(deny network*)"
    };

    format!(
        "(version 1)\n\
         (deny default)\n\
         (allow process-fork process-exec)\n\
         (allow signal (target self))\n\
         (allow sysctl-read)\n\
         (allow file-read* (subpath \"/usr\") (subpath \"/System\") \
                            (subpath \"/Library\") (subpath \"/private/etc\") \
                            (subpath \"/private/var\") (subpath \"/bin\") \
                            (subpath \"/sbin\") (subpath \"/dev\") \
                            (subpath \"/private/tmp\") (subpath \"/private/var/folders\"))\n\
         (allow file-read* file-write* (subpath \"{escaped_root}\"))\n\
         (allow file-write* (subpath \"/private/tmp\") (subpath \"/private/var/folders\"))\n\
         {network_clause}\n",
    )
}

#[cfg(test)]
#[cfg(not(windows))]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn runs_simple_command() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let out = tool
            .invoke(json!({ "command": "echo hello" }))
            .await
            .unwrap();
        assert!(out.contains("exit=0"), "got: {out}");
        assert!(out.contains("hello"), "got: {out}");
    }

    #[tokio::test]
    async fn captures_nonzero_exit() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let out = tool.invoke(json!({ "command": "exit 7" })).await.unwrap();
        assert!(out.contains("exit=7"), "got: {out}");
    }

    #[tokio::test]
    async fn captures_stderr_separately() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let out = tool
            .invoke(json!({ "command": "echo oops 1>&2; exit 1" }))
            .await
            .unwrap();
        assert!(out.contains("--- stderr"), "got: {out}");
        assert!(out.contains("oops"), "got: {out}");
        assert!(out.contains("exit=1"), "got: {out}");
    }

    #[tokio::test]
    async fn rejects_cwd_escape() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let err = tool
            .invoke(json!({ "command": "true", "cwd": "../etc" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains(".."), "got: {err}");
    }

    #[tokio::test]
    async fn enforces_timeout() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let err = tool
            .invoke(json!({ "command": "sleep 5", "timeout_ms": 100 }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "got: {err}");
    }

    #[tokio::test]
    async fn truncates_large_output() {
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path()).with_max_bytes(16);
        let out = tool
            .invoke(json!({ "command": "printf 'abcdefghijklmnopqrstuvwxyz'" }))
            .await
            .unwrap();
        assert!(out.contains("stdout truncated at 16"), "got: {out}");
    }

    #[tokio::test]
    async fn streams_progress_via_task_local() {
        // Spawn the tool inside a `with_progress` scope, drain the
        // matching receiver, and check we got line-by-line stdout
        // chunks before `invoke` returned. `printf '%s\n'` flushes
        // each line so the reader can see them as separate events.
        use harness_core::progress::{with_progress, ToolProgress};
        use tokio::sync::mpsc;

        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path());
        let (tx, mut rx) = mpsc::unbounded_channel::<ToolProgress>();

        let invoke = with_progress(
            tx,
            tool.invoke(json!({
                "command": "printf 'a\\nb\\nc\\n'",
            })),
        );

        // Drain in parallel so emits don't block on a full channel
        // (unbounded, but make ordering explicit).
        let drain = tokio::spawn(async move {
            let mut chunks = Vec::new();
            while let Some(p) = rx.recv().await {
                chunks.push(p);
            }
            chunks
        });
        let out = invoke.await.unwrap();
        let chunks = drain.await.unwrap();

        assert!(out.contains("exit=0"), "got: {out}");
        let stdout_lines: Vec<&str> = chunks
            .iter()
            .filter(|p| p.stream == "stdout")
            .map(|p| p.chunk.as_str())
            .collect();
        assert_eq!(
            stdout_lines,
            vec!["a\n", "b\n", "c\n"],
            "chunks: {chunks:?}"
        );
    }

    // ---------- Sandbox plumbing ----------

    #[test]
    fn sandbox_none_keeps_plain_sh_invocation() {
        let dir = tempdir().unwrap();
        let cmd = build_command("echo hi", dir.path(), dir.path(), &Sandbox::None).unwrap();
        let program = cmd.as_std().get_program().to_str().unwrap().to_string();
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|s| s.to_str().unwrap().to_string())
            .collect();
        assert_eq!(program, "sh");
        assert_eq!(args, vec!["-c", "echo hi"]);
    }

    #[test]
    fn sandbox_auto_must_be_resolved_before_use() {
        let dir = tempdir().unwrap();
        let err = build_command(
            "echo hi",
            dir.path(),
            dir.path(),
            &Sandbox::Auto {
                allow_network: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("must be resolved"), "got: {err}");
    }

    #[test]
    fn sandbox_resolve_picks_concrete_backend_or_falls_back() {
        // Resolve always returns a concrete variant — never `Auto`.
        let resolved = Sandbox::Auto {
            allow_network: false,
        }
        .resolve();
        assert!(!matches!(resolved, Sandbox::Auto { .. }));
    }

    #[test]
    fn bubblewrap_argv_includes_isolation_flags() {
        let dir = tempdir().unwrap();
        let cmd = build_bubblewrap("echo hi", dir.path(), dir.path(), false);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|s| s.to_str().unwrap().to_string())
            .collect();
        let joined = args.join(" ");
        assert!(joined.contains("--unshare-all"), "argv: {joined}");
        assert!(joined.contains("--die-with-parent"), "argv: {joined}");
        // Network flag must NOT be present when disabled.
        assert!(!joined.contains("--share-net"), "argv: {joined}");
        // The actual command goes through `sh -c <inner>` after the
        // `--` separator.
        let dash_dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dash_dash + 1], "sh");
        assert_eq!(args[dash_dash + 2], "-c");
        assert_eq!(args[dash_dash + 3], "echo hi");
    }

    #[test]
    fn bubblewrap_argv_includes_share_net_when_allowed() {
        let dir = tempdir().unwrap();
        let cmd = build_bubblewrap("echo hi", dir.path(), dir.path(), true);
        let joined: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|s| s.to_str().unwrap().to_string())
            .collect();
        assert!(
            joined.iter().any(|a| a == "--share-net"),
            "argv: {joined:?}"
        );
    }

    #[test]
    fn sandbox_exec_profile_denies_network_by_default() {
        let dir = tempdir().unwrap();
        let p = sandbox_exec_profile(dir.path(), false);
        assert!(p.contains("(deny default)"), "{p}");
        assert!(p.contains("(deny network*)"), "{p}");
        assert!(!p.contains("(allow network*)"), "{p}");
    }

    #[test]
    fn sandbox_exec_profile_allows_network_when_opted_in() {
        let dir = tempdir().unwrap();
        let p = sandbox_exec_profile(dir.path(), true);
        assert!(p.contains("(allow network*)"), "{p}");
        assert!(!p.contains("(deny network*)"), "{p}");
    }

    #[test]
    fn sandbox_exec_profile_grants_root_subpath_rw() {
        let dir = tempdir().unwrap();
        let p = sandbox_exec_profile(dir.path(), false);
        let abs = dir.path().canonicalize().unwrap();
        let needle = format!("(subpath \"{}\")", abs.display());
        assert!(p.contains(&needle), "profile missing root subpath: {p}");
    }

    // ---------- ShellLimits ----------

    #[test]
    fn limits_default_is_inert() {
        let l = ShellLimits::default();
        assert!(!l.any());
    }

    #[test]
    fn limits_safe_defaults_sets_all_four() {
        let l = ShellLimits::safe_defaults();
        assert!(l.any());
        assert_eq!(l.cpu_seconds, Some(60));
        assert!(l.address_space_bytes.is_some_and(|n| n >= 1 << 30));
        assert!(l.max_open_files.is_some());
        assert!(l.max_processes.is_some());
    }

    /// End-to-end: with `max_open_files = 64` set, the shell child
    /// inherits an `RLIMIT_NOFILE` soft limit of 64. We assert via
    /// `ulimit -n` rather than trying to actually exhaust file
    /// descriptors — exhaustion is shell-specific (POSIX `dash` on
    /// Ubuntu and `bash` on macOS allocate stock fds differently,
    /// and `exec N< /dev/null` *replaces* fd N rather than adding
    /// new ones). Asking the shell directly is portable and tests
    /// the same thing: did the `pre_exec` hook actually call
    /// `setrlimit`?
    #[cfg(unix)]
    #[tokio::test]
    async fn limits_nofile_cap_enforced() {
        let dir = tempdir().unwrap();

        // Reference: no cap → ulimit reports the default (typically
        // 1024+ on Linux, 256+ on macOS, anything but 64).
        let baseline = ShellExecTool::new(dir.path());
        let out_default = baseline
            .invoke(json!({ "command": "ulimit -n" }))
            .await
            .unwrap();
        assert!(
            out_default.contains("exit=0"),
            "baseline failed: {out_default}"
        );
        assert!(
            !contains_ulimit_value(&out_default, 64),
            "baseline already at NOFILE=64; can't distinguish from a cap. got: {out_default}"
        );

        // Capped → ulimit reports exactly 64.
        let limited = ShellExecTool::new(dir.path()).with_limits(ShellLimits {
            max_open_files: Some(64),
            ..Default::default()
        });
        let out_capped = limited
            .invoke(json!({ "command": "ulimit -n" }))
            .await
            .unwrap();
        assert!(
            contains_ulimit_value(&out_capped, 64),
            "expected ulimit -n to report 64 under NOFILE cap, got: {out_capped}"
        );
    }

    /// Pull the numeric `ulimit -n` line out of a captured shell
    /// output and check it equals `expected`. Tolerates any amount
    /// of leading/trailing whitespace from different shells.
    #[cfg(unix)]
    fn contains_ulimit_value(captured: &str, expected: u64) -> bool {
        captured
            .lines()
            .map(str::trim)
            .any(|line| line.parse::<u64>().is_ok_and(|n| n == expected))
    }

    /// macOS: end-to-end smoke test that `sandbox-exec` actually denies
    /// reads outside the project root. Skipped if `sandbox-exec` isn't
    /// on the host (deprecated, but present on every shipping macOS at
    /// time of writing).
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn sandbox_exec_denies_writes_outside_root() {
        if which("sandbox-exec").is_none() {
            return;
        }
        let dir = tempdir().unwrap();
        let tool = ShellExecTool::new(dir.path()).with_sandbox(Sandbox::SandboxExec {
            allow_network: false,
        });
        // Try to write somewhere we don't allow. Should fail / produce
        // a non-zero exit. We're not testing the exact error string
        // (sandbox-exec wording varies between macOS versions) — just
        // that the write didn't succeed.
        let target = "/tmp/jarvis-sandbox-test-leak";
        let _ = std::fs::remove_file(target);
        let out = tool
            .invoke(json!({
                "command": format!("echo leaked > {}", target)
            }))
            .await
            .unwrap();
        assert!(
            !out.contains("exit=0"),
            "expected non-zero exit, got: {out}"
        );
        assert!(
            !std::path::Path::new(target).exists(),
            "sandbox let a write outside root succeed: {target}"
        );
    }
}
