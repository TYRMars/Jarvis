use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::logs::LogBuffer;
use crate::sidecar::{DesktopStatus, ServerManager};

pub struct DesktopAppState {
    pub server: Arc<Mutex<ServerManager>>,
    pub logs: LogBuffer,
}

#[derive(Debug, Serialize)]
pub struct CommandResult {
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn desktop_status(state: State<'_, DesktopAppState>) -> DesktopStatus {
    state.server.lock().expect("server manager").status()
}

#[tauri::command]
pub fn restart_server(
    workspace: Option<String>,
    state: State<'_, DesktopAppState>,
) -> DesktopStatus {
    state
        .server
        .lock()
        .expect("server manager")
        .restart(workspace)
}

#[tauri::command]
pub fn select_workspace_dir() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Jarvis workspace")
        .pick_folder()
        .map(|p| p.display().to_string())
}

#[tauri::command]
pub fn open_path(path: String) -> CommandResult {
    match open::that_detached(PathBuf::from(path)) {
        Ok(_) => CommandResult {
            ok: true,
            error: None,
        },
        Err(e) => CommandResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn reveal_path(path: String) -> CommandResult {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map(|s| s.success());

    #[cfg(not(target_os = "macos"))]
    let result = open::that_detached(PathBuf::from(&path)).map(|_| true);

    match result {
        Ok(true) => CommandResult {
            ok: true,
            error: None,
        },
        Ok(false) => CommandResult {
            ok: false,
            error: Some("system opener returned a non-zero status".to_string()),
        },
        Err(e) => CommandResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn desktop_logs(limit: Option<usize>, state: State<'_, DesktopAppState>) -> Vec<String> {
    state.logs.tail(limit.unwrap_or(200))
}
