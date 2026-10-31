//! Threadgarden's data dir and the service's discovery file (`service.json`).
//!
//! Mirrors `packages/service/src/config.ts` (`resolveDataDirs`) and
//! `packages/service/src/discovery.ts`. The app passes the resolved dirs to the
//! service it spawns as `THREADGARDEN_DATA_DIR` and `THREADGARDEN_LEGACY_DATA_DIR`,
//! so the two can never disagree.

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

/// The OS families Threadgarden distinguishes for its data dir.
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

/// Threadgarden's data dir, and pahub's (Threadgarden before v1.3), which the
/// service migrates from once (spec v1.3 §9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirs {
    pub dir: PathBuf,
    /// pahub's data dir; `dir` itself for an override.
    pub legacy: PathBuf,
    /// The dir came from the deprecated `PAHUB_DATA_DIR`.
    pub deprecated_env: bool,
}

impl DataDirs {
    /// One dir that is its own legacy dir (an override).
    pub fn single(dir: PathBuf) -> Self {
        DataDirs {
            legacy: dir.clone(),
            dir,
            deprecated_env: false,
        }
    }

    /// Where a running service records itself: the new dir first, then the
    /// old one (a pahub service still running from before the update).
    pub fn discovery_dirs(&self) -> Vec<&Path> {
        if self.legacy == self.dir {
            vec![self.dir.as_path()]
        } else {
            vec![self.dir.as_path(), self.legacy.as_path()]
        }
    }
}

fn platform_dir(
    var: &impl Fn(&str) -> Option<PathBuf>,
    os: Os,
    home: &Path,
    name: &str,
) -> PathBuf {
    match os {
        Os::Windows => var("APPDATA")
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join(name),
        Os::MacOs => home.join("Library").join("Application Support").join(name),
        Os::Linux => var("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join(name),
    }
}

/// Threadgarden's data dir: `THREADGARDEN_DATA_DIR`, else (deprecated, for one
/// release) `PAHUB_DATA_DIR`, else `%APPDATA%\threadgarden` (Windows),
/// `~/Library/Application Support/threadgarden` (macOS),
/// `${XDG_DATA_HOME:-~/.local/share}/threadgarden` (Linux), with `pahub` in
/// place of `threadgarden` as the legacy dir. Empty variables count as unset.
pub fn resolve_data_dirs(env: impl Fn(&str) -> Option<String>, os: Os, home: &Path) -> DataDirs {
    let var = |name: &str| env(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = var("THREADGARDEN_DATA_DIR") {
        return DataDirs::single(dir);
    }
    if let Some(dir) = var("PAHUB_DATA_DIR") {
        return DataDirs {
            deprecated_env: true,
            ..DataDirs::single(dir)
        };
    }
    DataDirs {
        dir: platform_dir(&var, os, home, "threadgarden"),
        legacy: platform_dir(&var, os, home, "pahub"),
        deprecated_env: false,
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
    fn ignores_the_fields_of_a_headless_service() {
        let headless = SAMPLE.replace(
            "}",
            r#","remotePort":47380,"remoteAddresses":["192.168.1.20"]}"#,
        );
        assert_eq!(parse_discovery(&headless), parse_discovery(SAMPLE));
        assert!(parse_discovery(&headless).is_some());
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
        let env = env_of(&[("THREADGARDEN_DATA_DIR", "/tmp/tg"), ("APPDATA", "C:/x")]);
        for os in [Os::Windows, Os::MacOs, Os::Linux] {
            let dirs = resolve_data_dirs(&env, os, home);
            assert_eq!(dirs, DataDirs::single(PathBuf::from("/tmp/tg")));
            assert_eq!(dirs.discovery_dirs(), [Path::new("/tmp/tg")]);
        }
    }

    #[test]
    fn data_dir_honours_the_deprecated_override() {
        let home = Path::new("/home/u");
        let env = env_of(&[("PAHUB_DATA_DIR", "/tmp/old")]);
        let dirs = resolve_data_dirs(&env, Os::Linux, home);
        assert_eq!(dirs.dir, PathBuf::from("/tmp/old"));
        assert_eq!(dirs.legacy, PathBuf::from("/tmp/old"));
        assert!(dirs.deprecated_env);
        let both = env_of(&[
            ("THREADGARDEN_DATA_DIR", "/new"),
            ("PAHUB_DATA_DIR", "/old"),
        ]);
        assert_eq!(
            resolve_data_dirs(&both, Os::Linux, home),
            DataDirs::single(PathBuf::from("/new"))
        );
    }

    #[test]
    fn data_dir_per_os() {
        let home = Path::new("/home/u");
        let dirs = |vars: &'static [(&'static str, &'static str)], os: Os| {
            let d = resolve_data_dirs(env_of(vars), os, home);
            assert!(!d.deprecated_env);
            (d.dir, d.legacy)
        };
        let roaming = Path::new("/roaming");
        assert_eq!(
            dirs(&[("APPDATA", "/roaming")], Os::Windows),
            (roaming.join("threadgarden"), roaming.join("pahub"))
        );
        let roaming = home.join("AppData").join("Roaming");
        assert_eq!(
            dirs(&[], Os::Windows),
            (roaming.join("threadgarden"), roaming.join("pahub"))
        );
        let support = home.join("Library").join("Application Support");
        assert_eq!(
            dirs(&[], Os::MacOs),
            (support.join("threadgarden"), support.join("pahub"))
        );
        let xdg = Path::new("/xdg");
        assert_eq!(
            dirs(&[("XDG_DATA_HOME", "/xdg")], Os::Linux),
            (xdg.join("threadgarden"), xdg.join("pahub"))
        );
        let share = home.join(".local").join("share");
        assert_eq!(
            dirs(
                &[("XDG_DATA_HOME", ""), ("THREADGARDEN_DATA_DIR", "")],
                Os::Linux
            ),
            (share.join("threadgarden"), share.join("pahub"))
        );
    }

    #[test]
    fn discovery_looks_in_the_new_dir_first_then_the_old_one() {
        let dirs = resolve_data_dirs(
            env_of(&[("XDG_DATA_HOME", "/xdg")]),
            Os::Linux,
            Path::new("/h"),
        );
        assert_eq!(
            dirs.discovery_dirs(),
            [Path::new("/xdg/threadgarden"), Path::new("/xdg/pahub")]
        );
    }
}
