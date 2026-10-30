//! Finding or starting the pahub service.
//!
//! The service runs **detached** from the app (its own process group/session,
//! no inherited stdio), so agents survive the window closing, the app quitting
//! or crashing. The app finds it through `service.json` and proves it answers
//! with a `hello` over its token-authenticated WebSocket.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::discovery::{self, Discovery};

/// Must equal `PROTOCOL_VERSION` in `packages/protocol/src/version.ts` (checked by a test).
pub const PROTOCOL_VERSION: u32 = 1;
/// How long a freshly spawned service may take to write `service.json` and answer `hello`.
pub const START_TIMEOUT: Duration = Duration::from_secs(5);
const HELLO_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Node prints an ExperimentalWarning for `node:sqlite`; nobody reads the service's stderr anyway.
pub const NODE_WARNING_FLAG: &str = "--disable-warning=ExperimentalWarning";

/// Windows creation flags for the service: no console, own process group, no window.
#[cfg(windows)]
pub const DETACH_FLAGS: u32 = windows_sys::Win32::System::Threading::DETACHED_PROCESS
    | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
    | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// What the UI needs to open its WebSocket. `service_version` may differ from
/// `app_version` (same protocol): the UI then offers to restart the service (spec §4.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub port: u16,
    pub token: String,
    pub service_version: String,
    pub app_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub service_version: String,
    pub protocol_version: u32,
}

/// The program that runs the service and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchTarget {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

impl LaunchTarget {
    /// `node --disable-warning=ExperimentalWarning <script>`.
    pub fn node(program: PathBuf, script: &Path) -> Self {
        LaunchTarget {
            program,
            args: vec![NODE_WARNING_FLAG.into(), script.as_os_str().to_owned()],
        }
    }
}

/// Development: the system `node` running the repo's built service.
pub fn dev_target(repo_root: &Path) -> Result<LaunchTarget, String> {
    let script = repo_root
        .join("packages")
        .join("service")
        .join("dist")
        .join("service.mjs");
    if !script.is_file() {
        return Err(format!(
            "service-not-built: {} is missing; run `pnpm --filter @pahub/service build`",
            script.display()
        ));
    }
    Ok(LaunchTarget::node(PathBuf::from("node"), &script))
}

/// Release: the bundled Node sidecar (`pahub-node`, next to the app executable)
/// running the bundled `service/service.mjs` resource. Tauri canonicalizes the
/// resource dir, which on Windows gives a verbatim `\\?\C:\…` path that Node
/// cannot load a main script from (`EISDIR: lstat 'C:'`), so both paths are
/// simplified to their plain form (a no-op elsewhere).
pub fn release_target(exe_dir: &Path, resource_dir: &Path) -> Result<LaunchTarget, String> {
    let (exe_dir, resource_dir) = (dunce::simplified(exe_dir), dunce::simplified(resource_dir));
    let node = exe_dir.join(format!("pahub-node{}", std::env::consts::EXE_SUFFIX));
    let script = resource_dir.join("service").join("service.mjs");
    for required in [&node, &script] {
        if !required.is_file() {
            return Err(format!(
                "service-runtime-missing: {} is not bundled with this build",
                required.display()
            ));
        }
    }
    Ok(LaunchTarget::node(node, &script))
}

/// The service command: detached, stdio to the null device, `PAHUB_DATA_DIR` set.
pub fn build_detached_command(target: &LaunchTarget, data_dir: &Path) -> Command {
    let mut cmd = Command::new(&target.program);
    cmd.args(&target.args)
        .env("PAHUB_DATA_DIR", data_dir)
        // Not the app's cwd: a process's cwd cannot be deleted on Windows.
        .current_dir(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACH_FLAGS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe; it runs in the child between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd
}

/// The app's own console handles must not leak into the service, or whoever
/// waits on the app's output (a terminal, `tauri dev`) would wait on the service too.
#[cfg(windows)]
fn stop_std_handle_inheritance() {
    use windows_sys::Win32::Foundation::{
        HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: only clears the inherit flag of the process's own std handles.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

#[cfg(windows)]
fn spawn(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;
    stop_std_handle_inheritance();
    // Leave the app's job object too (if any), so closing that job cannot kill the service;
    // jobs that forbid breakaway refuse this, then the plain detached flags are used.
    cmd.creation_flags(DETACH_FLAGS | CREATE_BREAKAWAY_FROM_JOB);
    cmd.spawn().or_else(|_| {
        cmd.creation_flags(DETACH_FLAGS);
        cmd.spawn()
    })
}

#[cfg(unix)]
fn spawn(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    cmd.spawn()
}

/// Starts the service detached and returns its pid.
pub fn spawn_detached(target: &LaunchTarget, data_dir: &Path) -> Result<u32, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("service-start-failed: {}: {e}", data_dir.display()))?;
    let mut cmd = build_detached_command(target, data_dir);
    let mut child = spawn(&mut cmd)
        .map_err(|e| format!("service-start-failed: {}: {e}", target.program.display()))?;
    let pid = child.id();
    // Reap the child if it exits while the app runs (no zombie on Unix); the
    // service outlives the app otherwise, and this thread simply ends with it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

/// `service-version-mismatch` unless the service speaks this app's protocol.
pub fn check_protocol(hello: &HelloResult) -> Result<(), String> {
    if hello.protocol_version == PROTOCOL_VERSION {
        Ok(())
    } else {
        Err("service-version-mismatch".into())
    }
}

/// Sends `hello` over the service's WebSocket (token as the `pahub.<token>` subprotocol).
pub async fn hello(port: u16, token: &str, timeout: Duration) -> Result<HelloResult, String> {
    let params =
        serde_json::json!({ "protocolVersion": PROTOCOL_VERSION, "client": "pahub-desktop" });
    let result = tokio::time::timeout(timeout, request(port, token, "hello", params))
        .await
        .map_err(|_| "hello-timeout".to_string())??;
    serde_json::from_value(result).map_err(|e| format!("hello-failed: {e}"))
}

/// One request over a fresh connection to the service; resolves to its `result`.
/// Errors read `<method>-failed: …`.
async fn request(
    port: u16,
    token: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};

    let err = |e: &dyn std::fmt::Display| format!("{method}-failed: {e}");
    let mut req = format!("ws://127.0.0.1:{port}")
        .into_client_request()
        .map_err(|e| err(&e))?;
    let protocol = HeaderValue::from_str(&format!("pahub.{token}")).map_err(|e| err(&e))?;
    req.headers_mut().insert("Sec-WebSocket-Protocol", protocol);
    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| err(&e))?;
    let msg = serde_json::json!({ "id": 1, "method": method, "params": params });
    ws.send(Message::text(msg.to_string()))
        .await
        .map_err(|e| err(&e))?;
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| err(&e))?;
        let Ok(text) = msg.to_text() else { continue };
        let Ok(reply) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if reply.get("id") != Some(&serde_json::Value::from(1)) {
            continue; // an event
        }
        let _ = ws.close(None).await;
        if let Some(e) = reply.get("error") {
            return Err(format!("{method}-failed: {e}"));
        }
        return Ok(reply["result"].clone());
    }
    Err(format!("{method}-failed: connection closed"))
}

/// How long `stop` waits for the old service's process to exit.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Stops the recorded service ("Restart service", spec §4.2): asks it to shut
/// down with all its work (`service.shutdown {stopAll: true}`, a method every
/// protocol version has, so this also works for an incompatible service) and
/// resolves once its process has exited, so a new service can take over the
/// data dir. Nothing recorded, or the process already gone, is success; a
/// refused request is fine too (the UI may have asked it first, and it is
/// already closing).
pub async fn stop(
    data_dir: &Path,
    timeout: Duration,
    is_alive: impl Fn(u32) -> bool,
) -> Result<(), String> {
    let Some(d) = discovery::read_discovery(data_dir).filter(|d| is_alive(d.pid)) else {
        return Ok(());
    };
    let params = serde_json::json!({ "stopAll": true });
    let _ = tokio::time::timeout(
        HELLO_TIMEOUT,
        request(d.port, &d.token, "service.shutdown", params),
    )
    .await;
    let deadline = tokio::time::Instant::now() + timeout;
    while is_alive(d.pid) {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "service-stop-timeout: the pahub service (pid {}) did not exit within {} s",
                d.pid,
                timeout.as_secs_f32()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Ok(())
}

fn connection(d: &Discovery, hello: &HelloResult, app_version: &str) -> Connection {
    Connection {
        port: d.port,
        token: d.token.clone(),
        service_version: hello.service_version.clone(),
        app_version: app_version.to_string(),
    }
}

/// Connects to the running service, or calls `launch` to start one and waits
/// up to `start_timeout` for a fresh `service.json` whose service answers `hello`.
/// Only a different *protocol* is an error; a different service version is reported.
pub async fn connect(
    data_dir: &Path,
    app_version: &str,
    start_timeout: Duration,
    launch: impl FnOnce() -> Result<(), String>,
) -> Result<Connection, String> {
    let recorded = discovery::read_discovery(data_dir);
    if let Some(d) = recorded.as_ref().filter(|d| discovery::pid_alive(d.pid)) {
        // A live process that does not answer (a reused pid, a hung service)
        // counts as no service; the new one then replaces it.
        if let Ok(h) = hello(d.port, &d.token, HELLO_TIMEOUT).await {
            check_protocol(&h)?;
            return Ok(connection(d, &h, app_version));
        }
    }

    let is_fresh = |d: &Discovery| {
        recorded
            .as_ref()
            .is_none_or(|old| (old.pid, old.started_at) != (d.pid, d.started_at))
    };
    launch()?;
    let deadline = tokio::time::Instant::now() + start_timeout;
    loop {
        if let Some(d) =
            discovery::read_live_discovery(data_dir, discovery::pid_alive).filter(|d| is_fresh(d))
            && let Ok(h) = hello(d.port, &d.token, HELLO_TIMEOUT).await
        {
            check_protocol(&h)?;
            return Ok(connection(&d, &h, app_version));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "service-start-timeout: no service answered within {} s (logs in {})",
                start_timeout.as_secs_f32(),
                data_dir.display()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Callback, ErrorResponse, Request, Response,
    };

    const APP_VERSION: &str = "0.1.0";

    /// The fake service's handshake check: only the `pahub.<token>` subprotocol is
    /// accepted. A `Callback` impl, because tungstenite fixes the callback's error type.
    struct RequireToken(String);

    impl Callback for RequireToken {
        fn on_request(self, req: &Request, mut res: Response) -> Result<Response, ErrorResponse> {
            match req.headers().get("sec-websocket-protocol").cloned() {
                Some(p) if p.to_str().ok() == Some(self.0.as_str()) => {
                    res.headers_mut().insert("sec-websocket-protocol", p);
                    Ok(res)
                }
                _ => Err(Response::builder().status(401).body(None).unwrap()),
            }
        }
    }

    /// A stand-in service: checks the token subprotocol, answers `hello`.
    async fn fake_service(
        token: &'static str,
        service_version: &'static str,
        protocol_version: u32,
    ) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let check = RequireToken(format!("pahub.{token}"));
                    let ws = tokio_tungstenite::accept_hdr_async(stream, check).await;
                    let Ok(mut ws) = ws else { return };
                    while let Some(Ok(msg)) = ws.next().await {
                        let Ok(text) = msg.to_text() else { continue };
                        let req: serde_json::Value = serde_json::from_str(text).unwrap();
                        assert_eq!(req["method"], "hello");
                        assert_eq!(req["params"]["protocolVersion"], PROTOCOL_VERSION);
                        let reply = serde_json::json!({
                            "id": req["id"],
                            "result": { "serviceVersion": service_version, "protocolVersion": protocol_version },
                        });
                        let _ = ws.send(Message::text(reply.to_string())).await;
                    }
                });
            }
        });
        port
    }

    /// A stand-in service that answers every request with `{}`, records each
    /// request, and "exits" (clears `alive`) once asked to shut down.
    async fn shutdown_service(
        token: &'static str,
        alive: Arc<AtomicBool>,
    ) -> (u16, Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (log, alive) = (log.clone(), alive.clone());
                tokio::spawn(async move {
                    let check = RequireToken(format!("pahub.{token}"));
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, check).await
                    else {
                        return;
                    };
                    while let Some(Ok(msg)) = ws.next().await {
                        let Ok(text) = msg.to_text() else { continue };
                        let req: serde_json::Value = serde_json::from_str(text).unwrap();
                        let reply = serde_json::json!({ "id": req["id"], "result": {} });
                        let _ = ws.send(Message::text(reply.to_string())).await;
                        if req["method"] == "service.shutdown" {
                            alive.store(false, Ordering::SeqCst);
                        }
                        log.lock().unwrap().push(req);
                    }
                });
            }
        });
        (port, seen)
    }

    fn write_discovery(dir: &Path, port: u16, token: &str, started_at: u64) {
        let json = serde_json::json!({
            "pid": std::process::id(),
            "port": port,
            "token": token,
            "version": "9.9.9",
            "protocolVersion": PROTOCOL_VERSION,
            "startedAt": started_at,
        });
        std::fs::write(discovery::discovery_path(dir), json.to_string()).unwrap();
    }

    #[test]
    fn protocol_version_matches_the_protocol_package() {
        let file =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/protocol/src/version.ts");
        let text = std::fs::read_to_string(file).unwrap();
        assert!(
            text.contains(&format!("PROTOCOL_VERSION = {PROTOCOL_VERSION};")),
            "PROTOCOL_VERSION differs from packages/protocol: {text}"
        );
    }

    #[test]
    fn builds_detached_command_with_expected_flags_per_os() {
        let target = LaunchTarget::node(PathBuf::from("node"), Path::new("svc/service.mjs"));
        let cmd = build_detached_command(&target, Path::new("data-dir"));
        assert_eq!(cmd.get_program(), "node");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(
            args,
            ["--disable-warning=ExperimentalWarning", "svc/service.mjs"]
        );
        let data_dir = cmd
            .get_envs()
            .find(|(k, _)| *k == "PAHUB_DATA_DIR")
            .and_then(|(_, v)| v);
        assert_eq!(data_dir, Some(std::ffi::OsStr::new("data-dir")));
        assert_eq!(cmd.get_current_dir(), Some(Path::new("data-dir")));
        #[cfg(windows)]
        assert_eq!(DETACH_FLAGS, 0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }

    /// On Unix the service leads a new session (`setsid`), so it is its own process group leader.
    #[cfg(unix)]
    #[test]
    fn detached_child_leads_its_own_session() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        let target = LaunchTarget {
            program: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".into(),
                format!("echo $$ $(ps -o pgid= -p $$) > '{}'", out.display()).into(),
            ],
        };
        let pid = spawn_detached(&target, dir.path()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let text = loop {
            if let Ok(t) = std::fs::read_to_string(&out)
                && t.ends_with('\n')
            {
                break t;
            }
            assert!(std::time::Instant::now() < deadline, "child never wrote");
            std::thread::sleep(Duration::from_millis(20));
        };
        let ids: Vec<u32> = text
            .split_whitespace()
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(ids, [pid, pid], "child pid and process group");
        assert_ne!(unsafe { libc::getpgrp() } as u32, pid);
    }

    #[test]
    fn dev_target_requires_the_built_service() {
        let repo = tempfile::tempdir().unwrap();
        let err = dev_target(repo.path()).unwrap_err();
        assert!(err.starts_with("service-not-built"), "{err}");
        let dist = repo.path().join("packages").join("service").join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("service.mjs"), "").unwrap();
        let target = dev_target(repo.path()).unwrap();
        assert_eq!(target.program, PathBuf::from("node"));
        assert_eq!(target.args[1], dist.join("service.mjs").into_os_string());
    }

    #[test]
    fn release_target_reports_a_missing_sidecar() {
        let exe_dir = tempfile::tempdir().unwrap();
        let res_dir = tempfile::tempdir().unwrap();
        let err = release_target(exe_dir.path(), res_dir.path()).unwrap_err();
        assert!(err.starts_with("service-runtime-missing"), "{err}");
        let node = exe_dir
            .path()
            .join(format!("pahub-node{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&node, "").unwrap();
        let err = release_target(exe_dir.path(), res_dir.path()).unwrap_err();
        assert!(err.starts_with("service-runtime-missing"), "{err}");
        std::fs::create_dir_all(res_dir.path().join("service")).unwrap();
        std::fs::write(res_dir.path().join("service/service.mjs"), "").unwrap();
        let target = release_target(exe_dir.path(), res_dir.path()).unwrap();
        assert_eq!(target.program, node);
    }

    /// Canonical paths are verbatim (`\\?\C:\…`) on Windows; the service gets plain ones.
    #[test]
    fn release_target_passes_plain_paths_to_node() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let node = canonical.join(format!("pahub-node{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&node, "").unwrap();
        std::fs::create_dir_all(canonical.join("service")).unwrap();
        std::fs::write(canonical.join("service").join("service.mjs"), "").unwrap();
        let target = release_target(&canonical, &canonical).unwrap();
        let plain = dunce::simplified(&canonical).to_path_buf();
        assert_eq!(
            target.program,
            plain.join(format!("pahub-node{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(
            target.args[1],
            plain.join("service").join("service.mjs").into_os_string()
        );
        assert!(!target.args[1].to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn rejects_version_mismatch() {
        let ok = HelloResult {
            service_version: "1.0.0".into(),
            protocol_version: PROTOCOL_VERSION,
        };
        assert_eq!(check_protocol(&ok), Ok(()));
        let newer = HelloResult {
            protocol_version: PROTOCOL_VERSION + 1,
            ..ok
        };
        assert_eq!(
            check_protocol(&newer),
            Err("service-version-mismatch".to_string())
        );
    }

    #[tokio::test]
    async fn hello_authenticates_with_the_token_subprotocol() {
        let port = fake_service("tok", "9.9.9", PROTOCOL_VERSION).await;
        let h = hello(port, "tok", Duration::from_secs(2)).await.unwrap();
        assert_eq!(h.service_version, "9.9.9");
        assert!(hello(port, "wrong", Duration::from_secs(2)).await.is_err());
    }

    #[tokio::test]
    async fn connects_to_a_running_service_without_launching() {
        let dir = tempfile::tempdir().unwrap();
        let port = fake_service("tok", APP_VERSION, PROTOCOL_VERSION).await;
        write_discovery(dir.path(), port, "tok", 1);
        let conn = connect(dir.path(), APP_VERSION, Duration::from_secs(1), || {
            panic!("must not launch a second service")
        })
        .await
        .unwrap();
        assert_eq!(
            conn,
            Connection {
                port,
                token: "tok".into(),
                service_version: APP_VERSION.into(),
                app_version: APP_VERSION.into(),
            }
        );
    }

    /// Same protocol, another service version (e.g. an older service still
    /// running after an app update): connect, and report both versions.
    #[tokio::test]
    async fn reports_a_different_service_version_with_the_same_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let port = fake_service("tok", "0.0.9", PROTOCOL_VERSION).await;
        write_discovery(dir.path(), port, "tok", 1);
        let conn = connect(dir.path(), APP_VERSION, Duration::from_secs(1), || {
            panic!("must not launch over a compatible service")
        })
        .await
        .unwrap();
        assert_eq!(conn.service_version, "0.0.9");
        assert_eq!(conn.app_version, APP_VERSION);
        let json = serde_json::to_value(&conn).unwrap();
        assert_eq!(json["serviceVersion"], "0.0.9");
        assert_eq!(json["appVersion"], APP_VERSION);
    }

    #[tokio::test]
    async fn connect_rejects_version_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let port = fake_service("tok", APP_VERSION, PROTOCOL_VERSION + 1).await;
        write_discovery(dir.path(), port, "tok", 1);
        let err = connect(dir.path(), APP_VERSION, Duration::from_secs(1), || {
            panic!("must not launch over an incompatible service")
        })
        .await
        .unwrap_err();
        assert_eq!(err, "service-version-mismatch");
    }

    #[tokio::test]
    async fn launches_when_the_recorded_service_is_gone_and_waits_for_a_fresh_one() {
        let dir = tempfile::tempdir().unwrap();
        // A stale record: nothing listens on its port.
        let stale = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stale_port = stale.local_addr().unwrap().port();
        drop(stale);
        write_discovery(dir.path(), stale_port, "old", 1);
        let port = fake_service("new", APP_VERSION, PROTOCOL_VERSION).await;
        let launched = Arc::new(AtomicBool::new(false));
        let (flag, path) = (launched.clone(), dir.path().to_path_buf());
        let conn = connect(dir.path(), APP_VERSION, Duration::from_secs(3), move || {
            flag.store(true, Ordering::SeqCst);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                write_discovery(&path, port, "new", 2);
            });
            Ok(())
        })
        .await
        .unwrap();
        assert!(launched.load(Ordering::SeqCst));
        assert_eq!(conn.port, port);
        assert_eq!(conn.token, "new");
    }

    #[tokio::test]
    async fn gives_up_when_no_service_appears() {
        let dir = tempfile::tempdir().unwrap();
        let err = connect(dir.path(), APP_VERSION, Duration::from_millis(300), || {
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(err.starts_with("service-start-timeout"), "{err}");
    }

    #[tokio::test]
    async fn reports_a_failed_launch() {
        let dir = tempfile::tempdir().unwrap();
        let err = connect(dir.path(), APP_VERSION, Duration::from_secs(1), || {
            Err("service-runtime-missing: x".into())
        })
        .await
        .unwrap_err();
        assert_eq!(err, "service-runtime-missing: x");
    }

    #[tokio::test]
    async fn stop_asks_the_service_to_shut_down_and_waits_for_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        let alive = Arc::new(AtomicBool::new(true));
        let (port, seen) = shutdown_service("tok", alive.clone()).await;
        write_discovery(dir.path(), port, "tok", 1);
        let flag = alive.clone();
        stop(dir.path(), Duration::from_secs(3), move |_| {
            flag.load(Ordering::SeqCst)
        })
        .await
        .unwrap();
        assert!(!alive.load(Ordering::SeqCst));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["method"], "service.shutdown");
        assert_eq!(seen[0]["params"], serde_json::json!({ "stopAll": true }));
    }

    #[tokio::test]
    async fn stop_without_a_live_service_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        stop(dir.path(), Duration::from_millis(100), |_| true)
            .await
            .unwrap();
        write_discovery(dir.path(), 1, "tok", 1);
        stop(dir.path(), Duration::from_millis(100), |_| false)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stop_gives_up_when_the_process_does_not_exit() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing listens on the recorded port; the process stays alive.
        let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = gone.local_addr().unwrap().port();
        drop(gone);
        write_discovery(dir.path(), port, "tok", 1);
        let err = stop(dir.path(), Duration::from_millis(300), |_| true)
            .await
            .unwrap_err();
        assert!(err.starts_with("service-stop-timeout"), "{err}");
    }
}
