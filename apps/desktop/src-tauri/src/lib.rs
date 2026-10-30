//! pahub's native shell: window, tray, notifications, keychain, and finding
//! or starting the detached service. The UI talks to the service directly.

pub mod discovery;
pub mod secrets;
pub mod service;
pub mod tray;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, WindowEvent};
use tokio::sync::Mutex;

/// Serialises `service_connection` so concurrent calls never start two services.
static CONNECT: Mutex<()> = Mutex::const_new(());

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no-home-dir: {e}"))?;
    Ok(discovery::resolve_data_dir(
        |name| std::env::var(name).ok(),
        discovery::Os::current(),
        &home,
    ))
}

/// Debug builds run the repo's service with the system `node`; release builds
/// the bundled sidecar and resource (see `tauri.bundle.conf.json`).
fn launch_target(app: &AppHandle) -> Result<service::LaunchTarget, String> {
    if cfg!(debug_assertions) {
        // src-tauri → desktop → apps → repo root
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo = manifest.ancestors().nth(3).ok_or("no-repo-root")?;
        service::dev_target(repo)
    } else {
        let exe = std::env::current_exe().map_err(|e| format!("no-current-exe: {e}"))?;
        let exe_dir = exe.parent().ok_or("no-exe-dir")?;
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| format!("no-resource-dir: {e}"))?;
        service::release_target(exe_dir, &resources)
    }
}

/// Finds the running service or starts it (see `service::connect`).
async fn connect_service(app: &AppHandle) -> Result<service::Connection, String> {
    let _guard = CONNECT.lock().await;
    let dir = data_dir(app)?;
    service::connect(&dir, service::START_TIMEOUT, || {
        let target = launch_target(app)?;
        service::spawn_detached(&target, &dir).map(|_| ())
    })
    .await
}

#[tauri::command]
async fn service_connection(app: AppHandle) -> Result<service::Connection, String> {
    connect_service(&app).await
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn api_key_get() -> Result<Option<String>, String> {
    blocking(secrets::get).await
}

#[tauri::command]
async fn api_key_set(key: String) -> Result<(), String> {
    blocking(move || secrets::set(&key)).await
}

#[tauri::command]
async fn api_key_clear() -> Result<(), String> {
    blocking(secrets::clear).await
}

/// Exits the app only; the service and its agents keep running.
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_tray_needs_you(app: AppHandle, count: u32) -> Result<(), String> {
    tray::set_needs_you(&app, count).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch only focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            service_connection,
            api_key_get,
            api_key_set,
            api_key_clear,
            app_quit,
            set_tray_needs_you,
        ])
        .setup(|app| {
            tray::create(app.handle())?;
            // Start (or find) the service while the webview loads; the UI's
            // `service_connection` then waits for this attempt or repeats it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = connect_service(&handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray; agents and notifications carry on.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running pahub");
}
