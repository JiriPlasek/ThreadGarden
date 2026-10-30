//! The tray icon (spec §4.2): closing the window hides it here; the menu
//! reopens it, quits the app only, or asks the UI to confirm stopping work.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TRAY_ID: &str = "pahub";
/// Emitted to the webview; the UI confirms, then calls the service.
pub const EVENT_STOP_ALL: &str = "tray://stop-all";
pub const EVENT_QUIT_ALL: &str = "tray://quit-all";

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open pahub", true, None::<&str>)?;
    let stop_all = MenuItem::with_id(app, "stop-all", "Stop all work…", true, None::<&str>)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        "Quit pahub (keep agents running)",
        true,
        None::<&str>,
    )?;
    let quit_all = MenuItem::with_id(
        app,
        "quit-all",
        "Quit pahub completely…",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &stop_all,
            &PredefinedMenuItem::separator(app)?,
            &quit,
            &quit_all,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(needs_you_tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "stop-all" => {
                show_main_window(app);
                let _ = app.emit(EVENT_STOP_ALL, ());
            }
            "quit-all" => {
                show_main_window(app);
                let _ = app.emit(EVENT_QUIT_ALL, ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn needs_you_tooltip(count: u32) -> String {
    match count {
        0 => "pahub".to_string(),
        1 => "pahub — 1 chat needs you".to_string(),
        n => format!("pahub — {n} chats need you"),
    }
}

/// Tooltip on every OS; a count next to the icon where the OS supports tray titles (macOS, Linux).
pub fn set_needs_you<R: Runtime>(app: &AppHandle<R>, count: u32) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(needs_you_tooltip(count)))?;
        tray.set_title((count > 0).then(|| count.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_counts_chats_waiting() {
        assert_eq!(needs_you_tooltip(0), "pahub");
        assert_eq!(needs_you_tooltip(1), "pahub — 1 chat needs you");
        assert_eq!(needs_you_tooltip(4), "pahub — 4 chats need you");
    }
}
