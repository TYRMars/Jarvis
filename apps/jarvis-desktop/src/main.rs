mod commands;
mod logs;
mod prefs;
mod sidecar;
mod tray;

use std::sync::{Arc, Mutex};

use commands::{
    desktop_logs, desktop_status, open_path, restart_server, reveal_path, select_workspace_dir,
    DesktopAppState,
};
use logs::LogBuffer;
use prefs::{config_dir, DesktopPrefs};
use sidecar::ServerManager;
use tauri::webview::PageLoadEvent;
use tauri::{ActivationPolicy, Manager, Url, WindowEvent};

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

    let page_load_logs = logs.clone();

    tauri::Builder::default()
        .manage(DesktopAppState {
            server: Arc::clone(&server),
            logs: logs.clone(),
        })
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Regular);
            let state = app.state::<DesktopAppState>();
            let status = {
                let mut server = state.server.lock().expect("server manager");
                server.ensure_server();
                server.status()
            };
            if let Err(e) = app.handle().show() {
                state.logs.push(format!("Show app failed: {e}"));
            }
            if let Some(window) = app.get_webview_window("main") {
                if status.server_running {
                    match Url::parse(&status.api_origin) {
                        Ok(url) => {
                            if let Err(e) = window.navigate(url) {
                                state.logs.push(format!("Navigate main window failed: {e}"));
                            }
                        }
                        Err(e) => state
                            .logs
                            .push(format!("Invalid sidecar URL `{}`: {e}", status.api_origin)),
                    }
                }
                if let Err(e) = window.show() {
                    state.logs.push(format!("Show main window failed: {e}"));
                }
                if let Err(e) = window.set_focus() {
                    state.logs.push(format!("Focus main window failed: {e}"));
                }
            } else {
                state
                    .logs
                    .push("Main window not available during setup; waiting for page load");
            }
            if let Err(e) = tray::setup_tray(app) {
                state.logs.push(format!("Tray setup failed: {e}"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                tray::on_close_requested(window);
                api.prevent_close();
            }
        })
        .on_page_load(move |webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let window = webview.window();
            let app_handle = window.app_handle();
            if let Err(e) = app_handle.set_activation_policy(ActivationPolicy::Regular) {
                page_load_logs.push(format!("Set app activation policy failed: {e}"));
            }
            if let Err(e) = app_handle.show() {
                page_load_logs.push(format!("Show app after page load failed: {e}"));
            }
            if let Err(e) = window.unminimize() {
                page_load_logs.push(format!("Unminimize window after page load failed: {e}"));
            }
            if let Err(e) = window.show() {
                page_load_logs.push(format!("Show window after page load failed: {e}"));
            }
            if let Err(e) = window.set_focus() {
                page_load_logs.push(format!("Focus window after page load failed: {e}"));
            }
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
