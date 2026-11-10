//! The phone's update check (`update.latest`): GitHub's latest release, asked
//! by the core since the webview's CSP keeps the screens on loopback. One
//! read-only HTTPS GET to the releases API (rustls, Mozilla's roots), cached
//! for a while: GitHub rate-limits anonymous callers. It answers the version
//! and, when the release has one, its APK's address, which the screens open
//! in the browser. Nothing is ever downloaded or installed here.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::methods::{MethodError, Router};

/// The latest release of the app, as GitHub's API has it.
const LATEST: &str = "https://api.github.com/repos/JiriPlasek/ThreadGarden/releases/latest";
/// Tests point the check elsewhere (somewhere that never answers): never GitHub from a test.
const LATEST_ENV: &str = "THREADGARDEN_RELEASES_URL";
/// A successful answer is kept this long.
const TTL: Duration = Duration::from_secs(10 * 60);
/// The whole request, connect to last byte.
const TIMEOUT: Duration = Duration::from_secs(15);
/// More than any release's JSON (it carries the notes).
const MAX_RESPONSE: usize = 2 * 1024 * 1024;

/// The protocol's `UPDATE_ERRORS.UNREACHABLE`: no network, or GitHub didn't answer.
fn unreachable(message: impl Into<String>) -> MethodError {
    MethodError::new("UNREACHABLE", message)
}

/// Registers `update.latest`.
pub fn register(router: &mut Router) {
    let cache: Arc<Mutex<Option<(Instant, Value)>>> = Arc::default();
    router.register("update.latest", move |_| {
        let cache = cache.clone();
        async move {
            if let Some((at, answer)) = cache.lock().unwrap_or_else(|e| e.into_inner()).clone()
                && at.elapsed() < TTL
            {
                return Ok(answer);
            }
            let url = std::env::var(LATEST_ENV).unwrap_or_else(|_| LATEST.to_string());
            let body = tokio::time::timeout(TIMEOUT, get(&url))
                .await
                .map_err(|_| unreachable("GitHub did not answer in time"))??;
            let answer = latest(&body)?;
            *cache.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Instant::now(), answer.clone()));
            Ok(answer)
        }
    });
}

/// `{ version, url? }` from a release's JSON: the tag without its `v`, and the
/// first `.apk` asset served by github.com.
pub fn latest(body: &[u8]) -> Result<Value, MethodError> {
    let release: Value =
        serde_json::from_slice(body).map_err(|_| unreachable("The release could not be read"))?;
    let tag = release["tag_name"].as_str().unwrap_or_default();
    let version = tag.strip_prefix('v').unwrap_or(tag);
    let usable = version
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".+_-".contains(c));
    if !usable {
        return Err(unreachable("The release has no usable version"));
    }
    let apk = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|a| {
            let name = a["name"].as_str()?;
            let url = a["browser_download_url"].as_str()?;
            (name.to_ascii_lowercase().ends_with(".apk") && url.starts_with("https://github.com/"))
                .then(|| url.to_string())
        });
    Ok(match apk {
        Some(url) => json!({ "version": version, "url": url }),
        None => json!({ "version": version }),
    })
}

/// The body of a GET of `url` (https only), or why not.
async fn get(url: &str) -> Result<Vec<u8>, MethodError> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| unreachable("Only https is allowed"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (name, port) = match host.rsplit_once(':') {
        Some((h, p)) => (
            h,
            p.parse::<u16>()
                .map_err(|_| unreachable("Not a valid address"))?,
        ),
        None => (host, 443),
    };
    let server =
        ServerName::try_from(name.to_string()).map_err(|_| unreachable("Not a valid address"))?;
    let tcp = TcpStream::connect((name, port))
        .await
        .map_err(|e| unreachable(format!("Could not reach {name}: {e}")))?;
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| unreachable("TLS is not available"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(server, tcp)
        .await
        .map_err(|e| unreachable(format!("Could not reach {name} securely: {e}")))?;
    let request = format!(
        "GET /{path} HTTP/1.1\r\nHost: {name}\r\nUser-Agent: Threadgarden-phone\r\nAccept: application/vnd.github+json\r\nConnection: close\r\n\r\n"
    );
    tls.write_all(request.as_bytes())
        .await
        .map_err(|e| unreachable(format!("{name}: {e}")))?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        // A server that closes without TLS's close_notify still sent its answer.
        let n = match tls.read(&mut chunk).await {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => 0,
            Err(e) => return Err(unreachable(format!("{name}: {e}"))),
        };
        if n == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..n]);
        if response.len() > MAX_RESPONSE {
            return Err(unreachable("The answer was too large"));
        }
    }
    body(&response)
}

/// The body of an HTTP/1.1 response that answered 200 (plain or chunked).
pub fn body(response: &[u8]) -> Result<Vec<u8>, MethodError> {
    let end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| unreachable("An incomplete answer"))?;
    let head = String::from_utf8_lossy(&response[..end]).to_ascii_lowercase();
    let status = head.split_whitespace().nth(1).unwrap_or_default();
    if status != "200" {
        return Err(unreachable(format!("GitHub answered {status}")));
    }
    let raw = &response[end + 4..];
    if !head.contains("transfer-encoding: chunked") {
        return Ok(raw.to_vec());
    }
    let mut out = Vec::new();
    let mut at = 0;
    loop {
        let line_end = raw[at..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| unreachable("An incomplete answer"))?
            + at;
        let size = std::str::from_utf8(&raw[at..line_end])
            .ok()
            .and_then(|s| usize::from_str_radix(s.split(';').next()?.trim(), 16).ok())
            .ok_or_else(|| unreachable("An unreadable answer"))?;
        if size == 0 {
            return Ok(out);
        }
        let start = line_end + 2;
        let stop = start + size;
        if stop > raw.len() {
            return Err(unreachable("An incomplete answer"));
        }
        out.extend_from_slice(&raw[start..stop]);
        at = stop + 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_and_the_apk_come_from_the_release() {
        let body = br#"{"tag_name":"v0.10.0","html_url":"https://github.com/x","assets":[
            {"name":"Threadgarden_0.10.0_amd64.AppImage","browser_download_url":"https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.10.0/a.AppImage"},
            {"name":"threadgarden-0.10.0.apk","browser_download_url":"https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.10.0/threadgarden-0.10.0.apk"}]}"#;
        assert_eq!(
            latest(body).unwrap(),
            json!({ "version": "0.10.0", "url": "https://github.com/JiriPlasek/ThreadGarden/releases/download/v0.10.0/threadgarden-0.10.0.apk" })
        );
    }

    #[test]
    fn a_release_without_an_apk_says_only_its_version() {
        let body = br#"{"tag_name":"v0.9.1","assets":[]}"#;
        assert_eq!(latest(body).unwrap(), json!({ "version": "0.9.1" }));
    }

    #[test]
    fn an_apk_somewhere_else_is_not_offered() {
        let body = br#"{"tag_name":"v1.0.0","assets":[{"name":"x.apk","browser_download_url":"https://example.com/x.apk"}]}"#;
        assert_eq!(latest(body).unwrap(), json!({ "version": "1.0.0" }));
    }

    #[test]
    fn an_unusable_tag_or_body_is_unreachable() {
        assert_eq!(
            latest(br#"{"tag_name":"v"}"#).unwrap_err().code,
            "UNREACHABLE"
        );
        assert_eq!(
            latest(br#"{"tag_name":"../x"}"#).unwrap_err().code,
            "UNREACHABLE"
        );
        assert_eq!(latest(b"<html>").unwrap_err().code, "UNREACHABLE");
    }

    #[test]
    fn a_body_plain_or_chunked_and_only_from_a_200() {
        assert_eq!(
            body(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(),
            b"{}"
        );
        assert_eq!(
            body(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n")
                .unwrap(),
            br#"{"a":1}"#
        );
        assert_eq!(
            body(b"HTTP/1.1 403 rate limit exceeded\r\n\r\n{}")
                .unwrap_err()
                .code,
            "UNREACHABLE"
        );
        assert_eq!(body(b"HTTP/1.1 200").unwrap_err().code, "UNREACHABLE");
    }

    #[test]
    fn only_https() {
        let answer = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(get("http://api.github.com/x"));
        assert_eq!(answer.unwrap_err().code, "UNREACHABLE");
    }

    /// By hand only (`cargo test -- --ignored`): the real request to GitHub.
    #[test]
    #[ignore]
    fn asks_github() {
        let answer = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async { latest(&get(LATEST).await?) });
        let answer = answer.unwrap();
        assert!(answer["version"].as_str().is_some_and(|v| !v.is_empty()));
    }
}
