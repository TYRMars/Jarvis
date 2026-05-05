mod commands;
mod logs;
mod prefs;
mod sidecar;

use std::sync::{Arc, Mutex};

use commands::{
    desktop_logs, desktop_status, open_path, restart_server, reveal_path, select_workspace_dir,
    DesktopAppState,
};
use logs::LogBuffer;
use prefs::{config_dir, DesktopPrefs};
use sidecar::ServerManager;
use tauri::Manager;

const APP_DIR: &str = "ai.jarvis.desktop";

fn main() {
    let logs = LogBuffer::default();
    logs.push("Jarvis Desktop starting");

    let prefs_dir = config_dir(APP_DIR);
    let prefs = DesktopPrefs::load(&prefs_dir);
    if let Some(ws) = prefs.workspace.as_deref() {
        logs.push(format!("Loaded workspace from prefs: {ws}"));
    }
    let server = Arc::new(Mutex::new(ServerManager::with_prefs(
        logs.clone(),
        prefs.clone(),
        prefs_dir.clone(),
    )));

    tauri::Builder::default()
        .manage(DesktopAppState {
            server: Arc::clone(&server),
            logs: logs.clone(),
        })
        .setup(|app| {
            let state = app.state::<DesktopAppState>();
            state.server.lock().expect("server manager").ensure_server();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            restart_server,
            select_workspace_dir,
            open_path,
            reveal_path,
            desktop_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jarvis Desktop");
}
