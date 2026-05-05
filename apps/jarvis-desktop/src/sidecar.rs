use std::env;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

use crate::logs::LogBuffer;
use crate::prefs::DesktopPrefs;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerKind {
    External,
    Sidecar,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopStatus {
    pub api_origin: String,
    pub server_kind: ServerKind,
    pub server_running: bool,
    pub workspace: Option<String>,
    pub logs: Vec<String>,
    pub last_error: Option<String>,
}

pub struct ServerManager {
    api_origin: String,
    workspace: Option<PathBuf>,
    child: Option<Child>,
    kind: ServerKind,
    last_error: Option<String>,
    logs: LogBuffer,
    prefs: DesktopPrefs,
    prefs_dir: Option<PathBuf>,
}

impl ServerManager {
    pub fn with_prefs(logs: LogBuffer, prefs: DesktopPrefs, prefs_dir: PathBuf) -> Self {
        let workspace = prefs
            .workspace
            .as_ref()
            .map(PathBuf::from)
            .or_else(default_workspace);
        Self {
            api_origin: "http://127.0.0.1:7001".to_string(),
            workspace,
            child: None,
            kind: ServerKind::Stopped,
            last_error: None,
            logs,
            prefs,
            prefs_dir: if prefs_dir.as_os_str().is_empty() {
                None
            } else {
                Some(prefs_dir)
            },
        }
    }

    fn record_workspace_pref(&mut self, workspace: &Path) {
        let display = workspace.display().to_string();
        if self.prefs.workspace.as_deref() == Some(display.as_str()) {
            return;
        }
        self.prefs.workspace = Some(display);
        if let Some(dir) = self.prefs_dir.as_deref() {
            self.prefs.save(dir);
        }
    }

    pub fn ensure_server(&mut self) {
        if health_ok(&self.api_origin) {
            self.kind = ServerKind::External;
            self.logs.push(format!("Using existing Jarvis server at {}", self.api_origin));
            return;
        }
        if let Err(e) = self.start_sidecar(self.workspace.clone()) {
            self.last_error = Some(e.to_string());
            self.logs.push(format!("Failed to start Jarvis server: {e}"));
        }
    }

    pub fn status(&mut self) -> DesktopStatus {
        self.reap_if_exited();
        DesktopStatus {
            api_origin: self.api_origin.clone(),
            server_kind: self.kind.clone(),
            server_running: health_ok(&self.api_origin),
            workspace: self.workspace.as_ref().map(|p| p.display().to_string()),
            logs: self.logs.tail(120),
            last_error: self.last_error.clone(),
        }
    }

    pub fn restart(&mut self, workspace: Option<String>) -> DesktopStatus {
        if let Some(path) = workspace {
            self.workspace = Some(PathBuf::from(path));
        }
        self.stop_sidecar();
        self.last_error = None;
        if let Err(e) = self.start_sidecar(self.workspace.clone()) {
            self.last_error = Some(e.to_string());
            self.logs.push(format!("Failed to restart Jarvis server: {e}"));
        }
        self.status()
    }

    fn start_sidecar(&mut self, workspace: Option<PathBuf>) -> Result<()> {
        let jarvis = locate_jarvis_binary()?;
        let port = pick_port()?;
        let addr = format!("127.0.0.1:{port}");
        let api_origin = format!("http://{addr}");
        let workspace = workspace.unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        self.record_workspace_pref(&workspace);

        self.logs.push(format!(
            "Starting Jarvis sidecar: {} serve --workspace {} on {}",
            jarvis.display(),
            workspace.display(),
            addr
        ));

        let mut child = Command::new(&jarvis)
            .arg("serve")
            .arg("--workspace")
            .arg(&workspace)
            .env("JARVIS_ADDR", &addr)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawn `{}`", jarvis.display()))?;

        if let Some(stdout) = child.stdout.take() {
            self.logs.pipe("server", stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            self.logs.pipe("server:err", stderr);
        }

        self.api_origin = api_origin;
        self.workspace = Some(workspace);
        self.child = Some(child);
        self.kind = ServerKind::Sidecar;

        // Stretch the wait to ~6s so first-run cargo cold-starts and
        // slow-disk dev builds don't time out the way a 3s budget
        // does. We also short-circuit the moment the child exits so
        // a missing API key surfaces in <100ms instead of waiting
        // out the full window.
        for _ in 0..60 {
            if health_ok(&self.api_origin) {
                self.logs.push(format!("Jarvis sidecar ready at {}", self.api_origin));
                return Ok(());
            }
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    self.child = None;
                    self.kind = ServerKind::Stopped;
                    let tail = self.server_log_tail(8);
                    return Err(anyhow!(
                        "Jarvis server exited early ({status}). {}",
                        if tail.is_empty() {
                            "No output captured — try running `jarvis serve` manually for diagnostics.".to_string()
                        } else {
                            format!("Recent output:\n{tail}")
                        }
                    ));
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let tail = self.server_log_tail(6);
        let suffix = if tail.is_empty() {
            String::new()
        } else {
            format!("\nRecent output:\n{tail}")
        };
        Err(anyhow!(
            "sidecar did not become healthy at {}{suffix}",
            self.api_origin
        ))
    }

    /// Last `limit` lines emitted by the spawned `jarvis` process,
    /// stitched together for inclusion in error messages. Filters
    /// the shared log buffer to the `[server]` / `[server:err]`
    /// prefixes so we don't echo desktop-side breadcrumbs back to
    /// the user.
    fn server_log_tail(&self, limit: usize) -> String {
        self.logs
            .tail(limit * 4)
            .into_iter()
            .filter(|line| line.starts_with("[server"))
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn stop_sidecar(&mut self) {
        if let Some(mut child) = self.child.take() {
            self.logs.push("Stopping Jarvis sidecar");
            let _ = child.kill();
            let _ = child.wait();
        }
        if matches!(self.kind, ServerKind::Sidecar) {
            self.kind = ServerKind::Stopped;
        }
    }

    fn reap_if_exited(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                self.logs.push(format!("Jarvis sidecar exited with {status}"));
                self.child = None;
                self.kind = ServerKind::Stopped;
            }
            Ok(None) => {}
            Err(e) => {
                self.logs.push(format!("Jarvis sidecar status failed: {e}"));
            }
        }
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        self.stop_sidecar();
    }
}

fn health_ok(origin: &str) -> bool {
    let Some(addr) = origin.strip_prefix("http://") else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()),
        Duration::from_millis(180),
    ) else {
        return false;
    };
    use std::io::{Read, Write};
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut buf = [0u8; 64];
    matches!(stream.read(&mut buf), Ok(n) if std::str::from_utf8(&buf[..n]).unwrap_or("").contains("200 OK"))
}

fn pick_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn locate_jarvis_binary() -> Result<PathBuf> {
    if let Ok(path) = env::var("JARVIS_DESKTOP_SIDECAR") {
        let buf = PathBuf::from(&path);
        if !buf.exists() {
            return Err(anyhow!(
                "JARVIS_DESKTOP_SIDECAR points at `{path}` which does not exist"
            ));
        }
        return Ok(buf);
    }

    let exe = env::current_exe().context("current exe")?;
    if let Some(dir) = exe.parent() {
        let sibling = dir.join(binary_name("jarvis"));
        if sibling.exists() {
            return Ok(sibling);
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest.parent().and_then(|p| p.parent());
    if let Some(root) = workspace_root {
        for profile in ["debug", "release"] {
            let candidate = root.join("target").join(profile).join(binary_name("jarvis"));
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    let workspace_target = workspace_root
        .map(|root| root.join("target").join("debug").join(binary_name("jarvis")));
    if let Some(path) = workspace_target {
        if path.exists() {
            return Ok(path);
        }
    }

    // Last resort — let `Command::new` resolve `jarvis` against PATH.
    // Operators who symlink the binary system-wide rely on this; the
    // failure path produces a clear "spawn jarvis" error that the
    // overlay surfaces.
    Ok(PathBuf::from(binary_name("jarvis")))
}

fn binary_name(name: &str) -> String {
    #[cfg(windows)]
    {
        format!("{name}.exe")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn default_workspace() -> Option<PathBuf> {
    env::var_os("JARVIS_DESKTOP_WORKSPACE")
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())
}
