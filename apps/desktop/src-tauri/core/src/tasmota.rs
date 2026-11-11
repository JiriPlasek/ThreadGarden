//! Tasmota's HTTP command API, as `packages/service/src/power/tasmota.ts`:
//! `GET http://<address>/cm?user=admin&password=<password>&cmnd=<command>`,
//! with a `Referer` (SetOption128 refuses commands without one). The password
//! is in the query, so the URL is never logged, and no error carries it.
//!
//! A small HTTP/1.1 client of its own (plain HTTP on the home network, one
//! request per connection), so the core needs no HTTP library for this.

use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::methods::MethodError;

pub const UNREACHABLE: &str = "POWER_UNREACHABLE";
pub const AUTH: &str = "POWER_AUTH";
pub const NOT_TASMOTA: &str = "POWER_NOT_TASMOTA";
pub const REFUSED: &str = "POWER_REFUSED";
pub const NOT_CONFIGURED: &str = "POWER_NOT_CONFIGURED";

/// How long a command may take, connecting included.
const TIMEOUT: Duration = Duration::from_secs(5);
/// The most of an answer read: Tasmota's are small.
const MAX_ANSWER: usize = 256 * 1024;

fn unreachable(address: &str) -> MethodError {
    MethodError::new(
        UNREACHABLE,
        format!("The switch at {address} did not answer."),
    )
}

fn not_tasmota(address: &str) -> MethodError {
    MethodError::new(
        NOT_TASMOTA,
        format!("{address} did not answer like a Tasmota device."),
    )
}

/// What an address may be: a host name or IPv4 address, with a port maybe
/// (it goes into the request line and the Host header as it is).
pub fn is_address(address: &str) -> bool {
    !address.is_empty()
        && address.len() <= 253
        && address
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

/// `encodeURIComponent`.
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A chunked body, decoded.
fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(body.get(..size)?);
        body = body.get(size + 2..)?;
    }
}

/// Runs one command on the switch at `address`.
pub async fn command(
    address: &str,
    password: &str,
    cmnd: &str,
) -> Result<Map<String, Value>, MethodError> {
    if !is_address(address) {
        return Err(MethodError::new(
            NOT_CONFIGURED,
            "The switch's address isn't one.",
        ));
    }
    let request = format!(
        "GET /cm?user=admin&password={}&cmnd={} HTTP/1.1\r\nHost: {address}\r\nReferer: http://{address}/\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        encode(password),
        encode(cmnd),
    );
    let host = if address.contains(':') {
        address.to_string()
    } else {
        format!("{address}:80")
    };
    let exchange = async {
        let mut tcp = TcpStream::connect(&host)
            .await
            .map_err(|_| unreachable(address))?;
        tcp.write_all(request.as_bytes())
            .await
            .map_err(|_| refused(address))?;
        let mut answer = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match tcp.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    answer.extend_from_slice(&buf[..n]);
                    if answer.len() > MAX_ANSWER {
                        return Err(not_tasmota(address));
                    }
                }
                Err(_) if !answer.is_empty() => break,
                Err(_) => return Err(refused(address)),
            }
        }
        Ok(answer)
    };
    let answer = tokio::time::timeout(TIMEOUT, exchange)
        .await
        .map_err(|_| unreachable(address))??;
    if answer.is_empty() {
        return Err(refused(address));
    }
    let split = answer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| not_tasmota(address))?;
    let head = String::from_utf8_lossy(&answer[..split]).into_owned();
    let raw_body = &answer[split + 4..];
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| not_tasmota(address))?;
    if status == 401 {
        return Err(MethodError::new(AUTH, "The switch refused the password."));
    }
    let chunked = head.lines().any(|l| {
        l.to_ascii_lowercase().starts_with("transfer-encoding:")
            && l.to_ascii_lowercase().contains("chunked")
    });
    let body = if chunked {
        dechunk(raw_body).ok_or_else(|| not_tasmota(address))?
    } else {
        raw_body.to_vec()
    };
    let text = String::from_utf8_lossy(&body);
    if text.trim().is_empty() {
        return Err(MethodError::new(
            REFUSED,
            format!("The switch at {address} answered with nothing."),
        ));
    }
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&text) else {
        return Err(not_tasmota(address));
    };
    if record
        .get("WARNING")
        .and_then(Value::as_str)
        .is_some_and(|w| w.starts_with("Need user="))
    {
        return Err(MethodError::new(AUTH, "The switch refused the password."));
    }
    if !(200..300).contains(&status) {
        return Err(MethodError::new(
            NOT_TASMOTA,
            format!("{address} answered HTTP {status}."),
        ));
    }
    Ok(record)
}

fn refused(address: &str) -> MethodError {
    MethodError::new(
        REFUSED,
        format!("The switch at {address} closed the connection without answering."),
    )
}

/// A field of a Tasmota answer, its key matched case-insensitively.
pub fn field<'a>(answer: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    answer
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_encoded_as_encode_uri_component_does() {
        assert_eq!(
            encode(r#"ZbSend {"Device":"Desk","Send":{"Power":1}}"#),
            "ZbSend%20%7B%22Device%22%3A%22Desk%22%2C%22Send%22%3A%7B%22Power%22%3A1%7D%7D"
        );
        assert_eq!(encode("p&w=d"), "p%26w%3Dd");
    }

    #[test]
    fn chunked_answers_are_read() {
        assert_eq!(
            dechunk(b"4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n"),
            Some(b"{\"a\":1}".to_vec())
        );
    }

    #[test]
    fn addresses_stay_in_their_place() {
        assert!(is_address("192.168.1.106"));
        assert!(is_address("bridge.local:8080"));
        assert!(!is_address("a b"));
        assert!(!is_address("x/../y"));
        assert!(!is_address(""));
    }
}
