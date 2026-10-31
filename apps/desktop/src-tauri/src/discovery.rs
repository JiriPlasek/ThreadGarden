//! Threadgarden's data dir and the service's discovery file (`service.json`).
//!
//! Mirrors `packages/service/src/config.ts` (`resolveDataDir`) and
//! `packages/service/src/discovery.ts`. The app passes the resolved dir to the
//! service it spawns as `PAHUB_DATA_DIR`, so the two can never disagree.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The service's discovery record, written atomically by the service at start.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub version: String,
    pub protocol_version: u32,
    pub started_at: u64,
}

/// The OS families pahub distinguishes for its data dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    MacOs,
    Linux,
}

impl Os {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// Threadgarden's data dir: `PAHUB_DATA_DIR`, else `%APPDATA%\pahub` (Windows),
/// `~/Library/Application Support/pahub` (macOS),
/// `${XDG_DATA_HOME:-~/.local/share}/pahub` (Linux). Empty variables count as unset.
pub fn resolve_data_dir(env: impl Fn(&str) -> Option<String>, os: Os, home: &Path) -> PathBuf {
    let var = |name: &str| env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = var("PAHUB_DATA_DIR") {
        return dir;
    }
    match os {
        Os::Windows => var("APPDATA")
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("pahub"),
        Os::MacOs => home
            .join("Library")
            .join("Application Support")
            .join("pahub"),
        Os::Linux => var("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("pahub"),
    }
}

pub fn discovery_path(data_dir: &Path) -> PathBuf {
    data_dir.join("service.json")
}

/// Parses `service.json`; anything malformed counts as no discovery.
pub fn parse_discovery(text: &str) -> Option<Discovery> {
    serde_json::from_str(text).ok()
}

pub fn read_discovery(data_dir: &Path) -> Option<Discovery> {
    let text = std::fs::read_to_string(discovery_path(data_dir)).ok()?;
    parse_discovery(&text)
}

/// The discovery record, unless its process is gone (a stale file after a crash or reboot).
pub fn read_live_discovery(data_dir: &Path, is_alive: impl Fn(u32) -> bool) -> Option<Discovery> {
    read_discovery(data_dir).filter(|d| is_alive(d.pid))
}

/// Whether a process with this pid exists.
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Exists but belongs to someone we may not query.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

/// Whether a process with this pid exists.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"pid":4242,"port":51234,"token":"abc123","version":"0.0.0","protocolVersion":1,"startedAt":1793300000000}"#;

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn parses_discovery_json() {
        let d = parse_discovery(SAMPLE).expect("valid discovery");
        assert_eq!(
            d,
            Discovery {
                pid: 4242,
                port: 51234,
                token: "abc123".into(),
                version: "0.0.0".into(),
                protocol_version: 1,
                started_at: 1_793_300_000_000,
            }
        );
    }

    #[test]
    fn rejects_malformed_discovery() {
        assert_eq!(parse_discovery(""), None);
        assert_eq!(parse_discovery("{\"pid\":1}"), None);
        assert_eq!(parse_discovery("not json"), None);
    }

    #[test]
    fn treats_discovery_with_dead_pid_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(discovery_path(dir.path()), SAMPLE).unwrap();
        assert_eq!(read_live_discovery(dir.path(), |_| false), None);
        let live = read_live_discovery(dir.path(), |pid| pid == 4242);
        assert_eq!(live.map(|d| d.port), Some(51234));
    }

    #[test]
    fn missing_discovery_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_live_discovery(dir.path(), |_| true), None);
    }

    #[test]
    fn current_process_is_alive_and_absurd_pid_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        assert!(!pid_alive(u32::MAX - 1));
    }

    #[test]
    fn data_dir_honours_override() {
        let home = Path::new("/home/u");
        let env = env_of(&[("PAHUB_DATA_DIR", "/tmp/pahub-test"), ("APPDATA", "C:/x")]);
        for os in [Os::Windows, Os::MacOs, Os::Linux] {
            assert_eq!(
                resolve_data_dir(&env, os, home),
                PathBuf::from("/tmp/pahub-test")
            );
        }
    }

    #[test]
    fn data_dir_per_os() {
        let home = Path::new("/home/u");
        assert_eq!(
            resolve_data_dir(env_of(&[("APPDATA", "/roaming")]), Os::Windows, home),
            Path::new("/roaming").join("pahub")
        );
        assert_eq!(
            resolve_data_dir(env_of(&[]), Os::Windows, home),
            home.join("AppData").join("Roaming").join("pahub")
        );
        assert_eq!(
            resolve_data_dir(env_of(&[]), Os::MacOs, home),
            home.join("Library")
                .join("Application Support")
                .join("pahub")
        );
        assert_eq!(
            resolve_data_dir(env_of(&[("XDG_DATA_HOME", "/xdg")]), Os::Linux, home),
            Path::new("/xdg").join("pahub")
        );
        assert_eq!(
            resolve_data_dir(env_of(&[("XDG_DATA_HOME", "")]), Os::Linux, home),
            home.join(".local").join("share").join("pahub")
        );
    }
}
