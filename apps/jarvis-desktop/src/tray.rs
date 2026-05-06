use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::commands::DesktopAppState;

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::new(app, "Show Jarvis", true, None::<&str>)?;
    let restart_i = MenuItem::new(app, "Restart Server", true, None::<&str>)?;
    let logs_i = MenuItem::new(app, "Open Logs", true, None::<&str>)?;
    let quit_i = MenuItem::new(app, "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_i, &restart_i, &logs_i, &quit_i])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                id if id == show_i.id() => show_window(app),
                id if id == restart_i.id() => restart_server(app),
                id if id == logs_i.id() => open_logs(app),
                id if id == quit_i.id() => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::TrayIconEvent;
            if let TrayIconEvent::Click { .. } = event {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn on_close_requested(window: &tauri::Window) {
    let _ = window.hide();
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn restart_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopAppState>() {
        let mut server = state.server.lock().expect("server manager");
        let _ = server.restart(None);
    }
}

fn open_logs(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("desktop:open-logs", ());
    }
}
