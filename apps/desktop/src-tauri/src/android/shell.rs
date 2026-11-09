//! JNI between the Kotlin side (`CoreBridge`, `CoreService`, `MainActivity`)
//! and the core, and the Tauri commands the screens call on Android.
//!
//! Kotlin calls in through `CoreBridge`'s `external` functions. Rust calls out
//! through `CoreBridge`'s static methods, on the class handed to `start`: a
//! thread Rust made can't look the app's classes up itself (its class loader
//! is the system's).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{JNI_FALSE, JNI_TRUE, jboolean};
use jni::{JNIEnv, JavaVM};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use threadgarden_core::secrets::{Secrets, SecretsError};
use threadgarden_core::{Core, CoreEvent, CoreHandle};

use super::{Chat, Keeper, alert_title, status_text};

/// The process's core, kept across activities and the screens.
static KEEPER: Keeper = Keeper::new(Core::start);
static VM: OnceLock<JavaVM> = OnceLock::new();
static BRIDGE: OnceLock<GlobalRef> = OnceLock::new();
/// The running app, for `alerts://open`. Replaced if the activity is made again.
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

/// What `CoreBridge` failed at: a JNI error or a Kotlin exception (cleared).
#[derive(Debug)]
struct BridgeError;

impl From<jni::errors::Error> for BridgeError {
    fn from(_: jni::errors::Error) -> Self {
        BridgeError
    }
}

/// Runs `f` with `CoreBridge`'s class, on any thread, in a local frame of its
/// own (a thread Rust attached never returns to Java to free its local refs).
fn bridge<T>(
    f: impl FnOnce(&mut JNIEnv, &JClass) -> Result<T, BridgeError>,
) -> Result<T, BridgeError> {
    let (Some(vm), Some(class)) = (VM.get(), BRIDGE.get()) else {
        return Err(BridgeError);
    };
    let mut env = vm.attach_current_thread_permanently()?;
    let class: &JClass = class.as_obj().into();
    let result = env.with_local_frame(8, |env| f(env, class));
    // An exception left pending would break the next JNI call on this thread.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
        return Err(BridgeError);
    }
    result
}

/// A `CoreBridge` method taking strings and returning nothing.
fn call(method: &str, args: &[&str]) -> Result<(), BridgeError> {
    bridge(|env, class| {
        let mut strings = Vec::with_capacity(args.len());
        for a in args {
            strings.push(JObject::from(env.new_string(a)?));
        }
        let values: Vec<JValue> = strings.iter().map(JValue::Object).collect();
        let sig = format!("({})V", "Ljava/lang/String;".repeat(args.len()));
        env.call_static_method(class, method, sig, &values)?;
        Ok(())
    })
}

fn call_bool(method: &str) -> Result<bool, BridgeError> {
    bridge(|env, class| Ok(env.call_static_method(class, method, "()Z", &[])?.z()?))
}

fn log(message: &str) {
    let _ = call("log", &[message]);
}

/// The Keystore-backed secrets (`KeystoreSecrets.kt`): a file in
/// `noBackupFilesDir`, encrypted with an AES-GCM key in AndroidKeyStore. Every
/// error reads the same, so none can carry a secret.
struct KeystoreSecrets;

impl Secrets for KeystoreSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        bridge(|env, class| {
            let k = JObject::from(env.new_string(key)?);
            let v = env
                .call_static_method(
                    class,
                    "secretGet",
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&k)],
                )?
                .l()?;
            if v.is_null() {
                return Ok(None);
            }
            Ok(Some(env.get_string(&JString::from(v))?.into()))
        })
        .map_err(|_| SecretsError("the keystore could not be read".into()))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        call("secretSet", &[key, value])
            .map_err(|_| SecretsError("the keystore could not be written".into()))
    }

    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        call("secretDelete", &[key])
            .map_err(|_| SecretsError("the keystore could not be written".into()))
    }
}

/// Passes the core's events to Kotlin, for as long as the core runs.
fn follow(core: &CoreHandle) {
    let mut events = core.events();
    // Off the runtime: the Kotlin calls block, and the core's two workers are its own.
    let spawned = std::thread::Builder::new()
        .name("threadgarden-events".into())
        .spawn(move || {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match events.blocking_recv() {
                    Ok(CoreEvent::Alert {
                        machine_id,
                        machine_name,
                        session_id,
                        chat_title,
                        kind,
                    }) => {
                        let title = alert_title(&machine_name, &chat_title, kind);
                        let _ = call("postAlert", &[&machine_id, &session_id, &title]);
                    }
                    Ok(CoreEvent::Status(s)) => {
                        let _ = call("postStatus", &[&status_text(s)]);
                    }
                    // The machine and why, never a frame or a token.
                    Ok(CoreEvent::LinkFailed { machine_id, reason }) => {
                        log(&format!("link to {machine_id} failed: {reason}"));
                    }
                    Ok(_) => {}
                    // Missed some: the next status says where the links are.
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        });
    if spawned.is_err() {
        log("could not follow the core's events");
    }
}

fn string(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(Into::into).unwrap_or_default()
}

/// `CoreBridge.start(filesDir, name)`: starts the process's core, or finds it
/// running. Called by the activity and the service, both on the main thread.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_start(
    mut env: JNIEnv,
    class: JClass,
    data_dir: JString,
    name: JString,
) -> jboolean {
    if VM.get().is_none()
        && let Ok(vm) = env.get_java_vm()
    {
        let _ = VM.set(vm);
    }
    if BRIDGE.get().is_none()
        && let Ok(g) = env.new_global_ref(&class)
    {
        let _ = BRIDGE.set(g);
    }
    let dir = string(&mut env, &data_dir);
    let name = string(&mut env, &name);
    match KEEPER.start(dir.into(), Arc::new(KeystoreSecrets), name) {
        Ok((core, new)) => {
            if new {
                follow(&core);
            }
            JNI_TRUE
        }
        Err(e) => {
            log(&e);
            JNI_FALSE
        }
    }
}

/// `CoreBridge.wasConnected(filesDir)`: whether a boot starts the service.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_wasConnected(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
) -> jboolean {
    let dir = string(&mut env, &data_dir);
    if Keeper::boot_starts(std::path::Path::new(&dir)) {
        JNI_TRUE
    } else {
        JNI_FALSE
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_connect(
    _env: JNIEnv,
    _class: JClass,
) {
    if let Some(core) = KEEPER.core()
        && let Err(e) = core.connect()
    {
        log(&format!("connect: {e}"));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_disconnect(
    _env: JNIEnv,
    _class: JClass,
) {
    if let Some(core) = KEEPER.core()
        && let Err(e) = core.disconnect()
    {
        log(&format!("disconnect: {e}"));
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_networkChanged(
    _env: JNIEnv,
    _class: JClass,
) {
    if let Some(core) = KEEPER.core() {
        core.network_changed();
    }
}

/// The permanent notification's text now (the service's first post).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_statusText<'l>(
    env: JNIEnv<'l>,
    _class: JClass<'l>,
) -> JString<'l> {
    let text = KEEPER
        .core()
        .map(|c| status_text(c.link_status()))
        .unwrap_or_default();
    env.new_string(text).unwrap_or_default()
}

/// The activity came to the front or went to the background.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_front(
    _env: JNIEnv,
    _class: JClass,
    front: jboolean,
) {
    if let Some((m, s)) = KEEPER.front(front == JNI_TRUE) {
        let _ = call("cancelAlert", &[&m, &s]);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenChat {
    machine_id: String,
    session_id: String,
}

/// An alert was tapped: its chat waits for the screens, and they're told now
/// if they're there (`alerts://open`).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_threadgarden_phone_CoreBridge_opened(
    mut env: JNIEnv,
    _class: JClass,
    machine_id: JString,
    session_id: JString,
) {
    let chat: Chat = (string(&mut env, &machine_id), string(&mut env, &session_id));
    KEEPER.opened(chat.clone());
    let app = APP.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(app) = app {
        let _ = app.emit(
            "alerts://open",
            OpenChat {
                machine_id: chat.0,
                session_id: chat.1,
            },
        );
    }
}

/// The app is up: `alerts://open` can reach its screens.
pub fn set_app(app: AppHandle) {
    *APP.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// The same shape as the desktop's: the core stands in for the service.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    port: u16,
    token: String,
    service_version: String,
    app_version: String,
}

/// The core's loopback port and token. The activity starts the core before
/// the webview loads, so it's normally there at once.
#[tauri::command]
pub async fn service_connection(app: AppHandle) -> Result<Connection, String> {
    let core = blocking(|| {
        for _ in 0..50 {
            if let Some(core) = KEEPER.core() {
                return Ok(core);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("core-not-started".to_string())
    })
    .await?;
    Ok(Connection {
        port: core.port(),
        token: core.token().to_string(),
        // The core carries the app's version (the versions test keeps them one).
        service_version: env!("CARGO_PKG_VERSION").to_string(),
        app_version: app.package_info().version.to_string(),
    })
}

/// The chat on screen (`null`s: none). Its alert, if any, goes.
#[tauri::command]
pub async fn alerts_set_active(
    machine_id: Option<String>,
    session_id: Option<String>,
) -> Result<(), String> {
    let chat = machine_id.zip(session_id);
    blocking(move || {
        if let Some((m, s)) = KEEPER.show(chat) {
            let _ = call("cancelAlert", &[&m, &s]);
        }
        Ok(())
    })
    .await
}

/// The opened alert's chat, once: for screens that weren't listening yet.
#[tauri::command]
pub fn alerts_take_open() -> Option<OpenChat> {
    KEEPER
        .take_opened()
        .map(|(machine_id, session_id)| OpenChat {
            machine_id,
            session_id,
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAlive {
    notifications_allowed: bool,
    battery_exempt: bool,
    /// The alert links are on (not Disconnected).
    connected: bool,
}

#[tauri::command]
pub async fn keep_alive_status() -> Result<KeepAlive, String> {
    blocking(|| {
        let failed = |_| "keep-alive-unknown".to_string();
        Ok(KeepAlive {
            notifications_allowed: call_bool("notificationsAllowed").map_err(failed)?,
            battery_exempt: call_bool("batteryExempt").map_err(failed)?,
            connected: KEEPER.core().is_some_and(|c| c.link_status().on),
        })
    })
    .await
}

/// Android's own dialog asking to exempt the app from battery optimisation.
#[tauri::command]
pub async fn request_battery_exemption() -> Result<(), String> {
    blocking(|| call("requestBatteryExemption", &[]).map_err(|_| "no-battery-dialog".into())).await
}

/// Disconnect, as the notification's action: the links close and the service
/// (with its notification) stops. The screens keep the core.
#[tauri::command]
pub async fn disconnect() -> Result<(), String> {
    blocking(|| {
        // Logged and carried on: the links are closed either way, only
        // remembering it across a restart failed.
        if let Some(core) = KEEPER.core()
            && let Err(e) = core.disconnect()
        {
            log(&format!("disconnect: {e}"));
        }
        call("stopService", &[]).map_err(|_| "no-service".into())
    })
    .await
}

#[tauri::command]
pub async fn connect() -> Result<(), String> {
    blocking(|| {
        if let Some(core) = KEEPER.core()
            && let Err(e) = core.connect()
        {
            log(&format!("connect: {e}"));
        }
        call("startService", &[]).map_err(|_| "no-service".into())
    })
    .await
}
