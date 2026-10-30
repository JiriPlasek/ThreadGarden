//! Keeps pahub's webview on pahub's own pages. Links in chat content are
//! opened in the system browser by the UI (ruling R23); this guard is the
//! defence in depth: any other top-level navigation is refused.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// Where the app's own pages are served from on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppOrigin {
    /// Windows serves the app from `http(s)://tauri.localhost`; macOS and Linux
    /// from `tauri://localhost`.
    pub windows: bool,
    /// Tauri's `useHttpsScheme` window option (Windows only; default `false`,
    /// i.e. `http://tauri.localhost`).
    pub https: bool,
    /// The dev server (`build.devUrl`), only while running under `tauri dev`.
    pub dev: Option<Url>,
}

impl AppOrigin {
    /// The origin of the running app: the main window's `useHttpsScheme`, and
    /// the dev server only when `tauri::is_dev()` (a build without the
    /// `custom-protocol` feature, which is what loads `devUrl` in the first place).
    pub fn of<R: Runtime>(app: &tauri::AppHandle<R>) -> Self {
        let config = app.config();
        let https = config
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
            .is_some_and(|w| w.use_https_scheme);
        let dev = if tauri::is_dev() {
            config.build.dev_url.clone()
        } else {
            None
        };
        AppOrigin {
            windows: cfg!(windows),
            https,
            dev,
        }
    }
}

/// True for the app's own origin: `http://tauri.localhost` (`https://` with
/// `useHttpsScheme`) on Windows, `tauri://localhost` on macOS and Linux, never
/// with an explicit port; and the dev server when one is given. `about:blank`
/// is allowed for webview start-up.
pub fn is_app_url(url: &Url, origin: &AppOrigin) -> bool {
    let host = url.host_str();
    let app_scheme = match (origin.windows, origin.https) {
        (true, true) => "https",
        (true, false) => "http",
        (false, _) => "tauri",
    };
    let app_host = if origin.windows {
        "tauri.localhost"
    } else {
        "localhost"
    };
    if url.scheme() == app_scheme && host == Some(app_host) && url.port().is_none() {
        return true;
    }
    match url.scheme() {
        "http" | "https" => origin.dev.as_ref().is_some_and(|dev| {
            dev.scheme() == url.scheme()
                && dev.host_str() == host
                && dev.port_or_known_default() == url.port_or_known_default()
        }),
        "about" => url.path() == "blank",
        _ => false,
    }
}

/// A plugin whose navigation hook blocks every page outside the app.
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = is_app_url(url, &AppOrigin::of(webview.app_handle()));
            if !allowed {
                eprintln!("pahub: blocked navigation away from the app to {url}");
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn windows(https: bool) -> AppOrigin {
        AppOrigin {
            windows: true,
            https,
            dev: None,
        }
    }

    fn unix() -> AppOrigin {
        AppOrigin {
            windows: false,
            https: false,
            dev: None,
        }
    }

    #[test]
    fn allows_the_windows_origin_with_the_configured_scheme() {
        for ok in [
            "http://tauri.localhost",
            "http://tauri.localhost/",
            "http://tauri.localhost/some/route",
            "about:blank",
        ] {
            assert!(is_app_url(&url(ok), &windows(false)), "{ok}");
        }
        assert!(!is_app_url(
            &url("https://tauri.localhost/"),
            &windows(false)
        ));
        assert!(is_app_url(&url("https://tauri.localhost/"), &windows(true)));
        assert!(!is_app_url(&url("http://tauri.localhost/"), &windows(true)));
        // Not the app's origin on Windows.
        assert!(!is_app_url(&url("tauri://localhost/"), &windows(false)));
    }

    #[test]
    fn allows_the_tauri_scheme_only_off_windows() {
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "about:blank",
        ] {
            assert!(is_app_url(&url(ok), &unix()), "{ok}");
        }
        for bad in [
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "tauri://evil",
        ] {
            assert!(!is_app_url(&url(bad), &unix()), "{bad}");
        }
    }

    #[test]
    fn refuses_an_explicit_port_on_the_app_origin() {
        assert!(!is_app_url(
            &url("http://tauri.localhost:8080/"),
            &windows(false)
        ));
        assert!(!is_app_url(
            &url("https://tauri.localhost:8443/"),
            &windows(true)
        ));
        assert!(!is_app_url(&url("tauri://localhost:1/"), &unix()));
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = AppOrigin {
            dev: Some(url("http://127.0.0.1:1420")),
            ..windows(false)
        };
        assert!(is_app_url(&url("http://127.0.0.1:1420/chat"), &dev));
        assert!(!is_app_url(&url("http://127.0.0.1:1420/"), &windows(false)));
        assert!(!is_app_url(&url("http://127.0.0.1:1421/"), &dev));
        assert!(!is_app_url(&url("https://127.0.0.1:1420/"), &dev));
        assert!(!is_app_url(&url("http://localhost:1420/"), &dev));
    }

    #[test]
    fn blocks_everything_else() {
        for origin in [windows(false), windows(true), unix()] {
            let origin = AppOrigin {
                dev: Some(url("http://127.0.0.1:1420")),
                ..origin
            };
            for bad in [
                "https://evil.example/",
                "http://evil.example/",
                "http://tauri.localhost.evil.example/",
                "https://tauri.localhost.evil.example/",
                "https://evil.example/tauri.localhost",
                "http://localhost/",
                "tauri://evil",
                "file:///etc/passwd",
                "javascript:alert(1)",
                "data:text/html,<h1>x</h1>",
                "about:srcdoc",
                "mailto:a@b.example",
            ] {
                assert!(!is_app_url(&url(bad), &origin), "{bad} with {origin:?}");
            }
        }
    }
}
