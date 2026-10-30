//! Keeps pahub's webview on pahub's own pages. Links in chat content are
//! opened in the system browser by the UI (ruling R23); this guard is the
//! defence in depth: any other top-level navigation is refused.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// True for the app's own origin: `tauri://localhost` (macOS, Linux),
/// `http(s)://tauri.localhost` (Windows), and in debug builds the dev server.
/// `about:blank` is allowed for webview start-up.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" => host == Some("localhost"),
        "http" | "https" if host == Some("tauri.localhost") => true,
        "http" | "https" => dev_url.is_some_and(|dev| {
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
            let config = webview.app_handle().config();
            let dev = if cfg!(debug_assertions) {
                config.build.dev_url.as_ref()
            } else {
                None
            };
            let allowed = is_app_url(url, dev);
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

    #[test]
    fn allows_the_app_origin_on_every_platform() {
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/some/route",
            "about:blank",
        ] {
            assert!(is_app_url(&url(ok), None), "{ok}");
        }
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = url("http://127.0.0.1:1420");
        assert!(is_app_url(&url("http://127.0.0.1:1420/chat"), Some(&dev)));
        assert!(!is_app_url(&url("http://127.0.0.1:1420/"), None));
        assert!(!is_app_url(&url("http://127.0.0.1:1421/"), Some(&dev)));
        assert!(!is_app_url(&url("https://127.0.0.1:1420/"), Some(&dev)));
        assert!(!is_app_url(&url("http://localhost:1420/"), Some(&dev)));
    }

    #[test]
    fn blocks_everything_else() {
        let dev = url("http://127.0.0.1:1420");
        for bad in [
            "https://evil.example/",
            "http://evil.example/",
            "https://tauri.localhost.evil.example/",
            "https://evil.example/tauri.localhost",
            "tauri://evil",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "about:srcdoc",
            "mailto:a@b.example",
        ] {
            assert!(!is_app_url(&url(bad), Some(&dev)), "{bad}");
        }
    }
}
