//! Self-update (releases spec §6): how this copy was installed decides whether
//! the updater may replace it. deb and rpm installs belong to the system's
//! package manager; an AppImage carries `APPIMAGE` in its environment.

/// How this app was installed, for `install_kind`: `windows`, `macos`,
/// `appimage` (self-updating) or `linux-package` (deb/rpm: download only).
pub fn install_kind_for(os: &str, appimage: Option<&str>) -> &'static str {
    match os {
        "windows" => "windows",
        "macos" => "macos",
        _ if appimage.is_some_and(|p| !p.is_empty()) => "appimage",
        _ => "linux-package",
    }
}

#[cfg(test)]
mod tests {
    use super::install_kind_for;

    #[test]
    fn windows_and_macos_update_themselves() {
        assert_eq!(install_kind_for("windows", None), "windows");
        assert_eq!(install_kind_for("macos", None), "macos");
    }

    #[test]
    fn an_appimage_updates_itself() {
        assert_eq!(
            install_kind_for("linux", Some("/home/a/Threadgarden.AppImage")),
            "appimage"
        );
    }

    #[test]
    fn deb_and_rpm_installs_do_not() {
        assert_eq!(install_kind_for("linux", None), "linux-package");
        assert_eq!(install_kind_for("linux", Some("")), "linux-package");
    }
}
