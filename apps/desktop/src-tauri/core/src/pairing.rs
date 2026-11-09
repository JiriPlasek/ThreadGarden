//! Pairing with a machine and links to it, as `machine/pairing-client.ts`
//! and `machine/link.ts` do it:
//!
//! 1. connect on `threadgarden-pair`, taking any certificate, and note it;
//! 2. send `pair.proof` with a fresh nonce only, and check the answer against
//!    HMAC(code, fingerprint seen + nonce) computed here: a machine that
//!    doesn't know the code, or one in the middle with another certificate
//!    relaying the real machine's proof, fails it;
//! 3. refuse the machine if it's this phone or already paired, still before
//!    the code is sent;
//! 4. only then send the code with `pair.claim`.
//!
//! A pinned link (`threadgarden-device.<token>`) checks the certificate's
//! fingerprint inside the TLS handshake, so to any other certificate the
//! upgrade request, and the token in it, is never written.

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::MAX_REQUEST_BYTES;
use crate::methods::MethodError;

pub const PAIR_PROTOCOL: &str = "threadgarden-pair";
pub const DEVICE_PROTOCOL_PREFIX: &str = "threadgarden-device.";
/// How long pairing may take in all (connecting, proof and claim).
pub const PAIRING_TIMEOUT: Duration = Duration::from_secs(10);
/// How long removing a machine waits for it to revoke this device.
pub const UNPAIR_TIMEOUT: Duration = Duration::from_secs(5);
/// Largest frame taken from a machine being paired: its answers are small.
const PAIRING_MAX_FRAME: usize = 64 * 1024;
/// The machine closes a socket whose token it revoked with this code.
const REVOKED: u16 = 4403;
/// No 0/O, 1/I/L: the machines' code alphabet (`devices.ts`).
const PAIRING_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 12;

pub type Link = WebSocketStream<TlsStream<TcpStream>>;

/// Why a link never opened (`LinkError` in `link.ts`): `Pin`, the machine
/// showed another certificate (nothing was sent); `Refused`, it answered
/// the upgrade with an HTTP status; `Unreachable`, everything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    Pin,
    Refused(u16),
    Unreachable(String),
}

/// A machine's certificate as pinned at pairing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    /// `fingerprint256` as Node has it: upper-case hex pairs joined by `:`.
    pub fingerprint: String,
    pub cert_der: Vec<u8>,
}

/// SHA-256 of a certificate, as Node's `fingerprint256`.
pub fn fingerprint(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest
        .as_ref()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A code as typed (any case, with or without dashes or spaces) in the form it is compared in.
pub fn normalise_code(code: &str) -> String {
    code.chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .collect::<String>()
        .to_uppercase()
}

/// Whether a typed code could be a pairing code at all (12 characters of the alphabet).
fn well_formed(code: &str) -> bool {
    let n = normalise_code(code);
    n.chars().count() == CODE_LENGTH && n.chars().all(|c| PAIRING_ALPHABET.contains(c))
}

/// The pairing proof: HMAC-SHA256 keyed by the normalised code over `<fingerprint>\n<nonce>`, as hex.
pub fn pairing_proof(code: &str, fingerprint: &str, nonce: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, code.as_bytes());
    let tag = ring::hmac::sign(&key, format!("{fingerprint}\n{nonce}").as_bytes());
    hex(tag.as_ref())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Takes any certificate (pairing) or only the pinned one, and notes what it saw.
#[derive(Debug)]
struct Verifier {
    pin: Option<String>,
    seen: Arc<Mutex<Option<Peer>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let seen = Peer {
            fingerprint: fingerprint(end_entity.as_ref()),
            cert_der: end_entity.to_vec(),
        };
        let matches = self
            .pin
            .as_ref()
            .is_none_or(|want| bool::from(want.as_bytes().ct_eq(seen.fingerprint.as_bytes())));
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(seen);
        if matches {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the machine presented another certificate".into(),
            ))
        }
    }

    // The handshake is still signed by the key of the certificate seen: checked as usual.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A WebSocket to a machine's listener over TLS, offering `protocol`. With
/// a `pin`, only that certificate is taken, inside the TLS handshake.
pub async fn open_link(
    address: &str,
    port: u16,
    protocol: &str,
    pin: Option<&str>,
    timeout: Duration,
    max_frame: usize,
) -> Result<(Link, Peer), LinkError> {
    let opening = async {
        let unreachable = |e: &dyn std::fmt::Display| LinkError::Unreachable(e.to_string());
        let server_name = match address.parse::<IpAddr>() {
            Ok(ip) => ServerName::IpAddress(ip.into()),
            Err(_) => ServerName::try_from(address.to_string())
                .map_err(|_| unreachable(&"not a valid address"))?,
        };
        let host = if address.contains(':') {
            format!("[{address}]")
        } else {
            address.to_string()
        };
        let mut request = format!("wss://{host}:{port}/")
            .into_client_request()
            .map_err(|_| unreachable(&"not a valid address"))?;
        let offered =
            HeaderValue::from_str(protocol).map_err(|_| unreachable(&"not a valid protocol"))?;
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", offered);

        let seen = Arc::new(Mutex::new(None));
        let verifier = Verifier {
            pin: pin.map(str::to_string),
            seen: seen.clone(),
            provider: provider(),
        };
        let config = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .map_err(|e| unreachable(&e))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        let tcp = TcpStream::connect((address, port))
            .await
            .map_err(|e| unreachable(&e))?;
        let tls = TlsConnector::from(Arc::new(config))
            .connect(server_name, tcp)
            .await
            .map_err(|e| {
                let peer = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
                match (pin, peer) {
                    (Some(want), Some(p)) if p.fingerprint != want => LinkError::Pin,
                    _ => unreachable(&e),
                }
            })?;
        let peer = seen
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| unreachable(&"no certificate"))?;
        let ws_config = WebSocketConfig::default()
            .max_message_size(Some(max_frame))
            .max_frame_size(Some(max_frame));
        let (ws, _) = tokio_tungstenite::client_async_with_config(request, tls, Some(ws_config))
            .await
            .map_err(|e| match e {
                WsError::Http(res) => LinkError::Refused(res.status().as_u16()),
                other => unreachable(&other),
            })?;
        Ok((ws, peer))
    };
    tokio::time::timeout(timeout, opening)
        .await
        .unwrap_or_else(|_| Err(LinkError::Unreachable("timed out".into())))
}

/// A request's failure over a link: the machine's error answer, or the link itself.
#[derive(Debug)]
pub enum RequestError {
    Remote {
        code: String,
    },
    /// The machine closed the link, with this code.
    Closed(Option<u16>),
    Link,
}

/// One request over an open link: the result, the machine's error, or the
/// link closing (or the time running out) first. Other frames are skipped.
pub async fn request(
    link: &mut Link,
    id: u64,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, RequestError> {
    let asking = async {
        let frame = json!({ "id": id, "method": method, "params": params }).to_string();
        link.send(Message::text(frame))
            .await
            .map_err(|_| RequestError::Link)?;
        while let Some(msg) = link.next().await {
            let text = match msg {
                Ok(Message::Text(text)) => text,
                Ok(Message::Close(frame)) => {
                    return Err(RequestError::Closed(frame.map(|f| f.code.into())));
                }
                Ok(_) => continue,
                Err(_) => return Err(RequestError::Link),
            };
            let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if reply["id"] != json!(id) {
                continue;
            }
            if let Some(error) = reply.get("error") {
                let code = error["code"].as_str().unwrap_or("INTERNAL").to_string();
                return Err(RequestError::Remote { code });
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(RequestError::Link)
    };
    tokio::time::timeout_at(deadline, asking)
        .await
        .unwrap_or(Err(RequestError::Link))
}

async fn close(link: &mut Link) {
    let _ = tokio::time::timeout(Duration::from_secs(1), link.close(None)).await;
}

/// `MachineInfoSchema`.
pub fn is_machine_info(v: &Value) -> bool {
    v["id"].is_string()
        && v["name"].is_string()
        && matches!(v["platform"].as_str(), Some("win32" | "darwin" | "linux"))
        && v["headless"].is_boolean()
        && v["home"].is_string()
        && v["capabilities"]
            .as_array()
            .is_some_and(|c| c.iter().all(Value::is_string))
        && (v.get("host").is_none() || v["host"] == "wsl")
}

fn is_device_token(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn pairing_error(code: &'static str) -> MethodError {
    let message = match code {
        "PAIRING_UNREACHABLE" => "The machine could not be reached",
        "PAIRING_PROOF_FAILED" => {
            "The machine could not prove it knows the pairing code; the code was not sent"
        }
        "PAIRING_EXPIRED" => "The pairing code has expired",
        _ => "The pairing code is not valid",
    };
    MethodError::new(code, message)
}

/// A link failure, or the machine refusing pairing sockets (503: no code is out, or it's busy).
fn not_connected(e: LinkError) -> MethodError {
    pairing_error(if e == LinkError::Refused(503) {
        "PAIRING_INVALID"
    } else {
        "PAIRING_UNREACHABLE"
    })
}

/// What pairing gives: the machine, this device's id there, the pin and the token.
pub struct Paired {
    pub machine: Value,
    pub device_id: String,
    pub peer: Peer,
    pub token: String,
}

impl std::fmt::Debug for Paired {
    /// Never the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Paired")
            .field("machine", &self.machine)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

/// Pairs with the machine at `address:port` that shows `code`, as a device
/// called `device_name`. `accept` may refuse the machine once it has proved
/// itself, before the code is sent. The pairing socket is closed whatever
/// the outcome (the machine has few pairing slots).
pub async fn pair(
    address: &str,
    port: u16,
    code: &str,
    device_name: &str,
    accept: impl FnOnce(&Value) -> Result<(), MethodError>,
) -> Result<Paired, MethodError> {
    // A code that can't be one is refused here: nothing to prove, nothing to send.
    if !well_formed(code) {
        return Err(pairing_error("PAIRING_INVALID"));
    }
    let code = normalise_code(code);
    let deadline = Instant::now() + PAIRING_TIMEOUT;
    let left = deadline.saturating_duration_since(Instant::now());
    let (mut link, peer) = open_link(address, port, PAIR_PROTOCOL, None, left, PAIRING_MAX_FRAME)
        .await
        .map_err(not_connected)?;
    let outcome = claim(&mut link, &peer, &code, device_name, accept, deadline).await;
    close(&mut link).await;
    let (machine, device_id, token) = outcome?;
    Ok(Paired {
        machine,
        device_id,
        peer,
        token,
    })
}

async fn claim(
    link: &mut Link,
    peer: &Peer,
    code: &str,
    device_name: &str,
    accept: impl FnOnce(&Value) -> Result<(), MethodError>,
    deadline: Instant,
) -> Result<(Value, String, String), MethodError> {
    let nonce = hex(&crate::store::random_bytes::<32>().map_err(|_| MethodError::internal())?);
    let proved = request(link, 1, "pair.proof", json!({ "nonce": nonce }), deadline)
        .await
        .map_err(|e| match e {
            RequestError::Remote { .. } => pairing_error("PAIRING_PROOF_FAILED"),
            RequestError::Closed(_) | RequestError::Link => pairing_error("PAIRING_UNREACHABLE"),
        })?;
    let machine = &proved["machine"];
    let Some(proof) = proved["proof"]
        .as_str()
        .filter(|_| is_machine_info(machine))
    else {
        return Err(pairing_error("PAIRING_PROOF_FAILED"));
    };
    let expected = pairing_proof(code, &peer.fingerprint, &nonce);
    if !bool::from(expected.as_bytes().ct_eq(proof.as_bytes())) {
        return Err(pairing_error("PAIRING_PROOF_FAILED"));
    }

    // It proved it shows this code for this certificate: it's the one.
    accept(machine)?;

    let params = json!({ "code": code, "deviceName": device_name });
    let claimed = request(link, 2, "pair.claim", params, deadline)
        .await
        .map_err(|e| match e {
            RequestError::Remote { code } if code == "PAIRING_EXPIRED" => {
                pairing_error("PAIRING_EXPIRED")
            }
            RequestError::Remote { .. } => pairing_error("PAIRING_INVALID"),
            RequestError::Closed(_) | RequestError::Link => pairing_error("PAIRING_UNREACHABLE"),
        })?;
    let (Some(device_id), Some(token)) = (claimed["deviceId"].as_str(), claimed["token"].as_str())
    else {
        return Err(pairing_error("PAIRING_INVALID"));
    };
    if !is_device_token(token)
        || !is_machine_info(&claimed["machine"])
        || claimed["machine"]["id"] != machine["id"]
    {
        return Err(pairing_error("PAIRING_INVALID"));
    }
    Ok((
        claimed["machine"].clone(),
        device_id.to_string(),
        token.to_string(),
    ))
}

/// Asks a paired machine to revoke this device, over a short-lived pinned
/// link. True when it did (it may close the link 4403 before answering);
/// false when it couldn't be asked. Never fails.
pub async fn unpair(address: &str, port: u16, pin: &str, token: &str, device_id: &str) -> bool {
    let deadline = Instant::now() + UNPAIR_TIMEOUT;
    let protocol = format!("{DEVICE_PROTOCOL_PREFIX}{token}");
    let Ok((mut link, _)) = open_link(
        address,
        port,
        &protocol,
        Some(pin),
        UNPAIR_TIMEOUT,
        MAX_REQUEST_BYTES,
    )
    .await
    else {
        return false;
    };
    let revoked = match request(
        &mut link,
        1,
        "devices.revoke",
        json!({ "deviceId": device_id }),
        deadline,
    )
    .await
    {
        Ok(answer) => answer["revoked"] == json!(true),
        // Closed 4403 as it revoked us: that's a yes.
        Err(RequestError::Closed(code)) => code == Some(REVOKED),
        Err(_) => false,
    };
    close(&mut link).await;
    revoked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_read_as_the_machines_write_them() {
        assert_eq!(normalise_code("abcd-efgh jkmn"), "ABCDEFGHJKMN");
        assert!(well_formed("abcd-efgh-jkmn"));
        assert!(!well_formed("ABCD-EFGH-JKM0"));
        assert!(!well_formed("ABCD-EFGH"));
    }

    #[test]
    fn the_proof_is_node_s_hmac() {
        // createHmac('sha256', 'ABCDEFGHJKMN').update('AA:BB\nnonce').digest('hex')
        assert_eq!(
            pairing_proof("ABCDEFGHJKMN", "AA:BB", "nonce"),
            "2e2be48b1ee66f6ffc2b645850bfc72629e6f3192268f43d7edf3ea053e7a20d"
        );
    }

    #[test]
    fn fingerprints_are_node_s_fingerprint256() {
        assert_eq!(&fingerprint(b"")[..8], "E3:B0:C4");
        assert_eq!(fingerprint(b"").len(), 32 * 3 - 1);
    }
}
