//! THROWAWAY spike: does a Rust core survive on the owner's phone, inside a foreground
//! service, with a pinned link to a machine and an alert with the app closed?
mod core;
#[cfg(target_os = "android")]
mod android;

#[tauri::command]
async fn core_connection(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    // The Kotlin service normally started the core; on any other path start it here.
    for _ in 0..30 {
        if core::CORE.get().is_some() { break; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let c = core::start(dir.to_string_lossy().into_owned());
    Ok(serde_json::json!({ "port": c.port, "token": c.token }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
