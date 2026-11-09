//! A small machine for the tests: a real TLS WebSocket listener, as a
//! headless service's remote listener answers a device (`remote-server.ts`):
//! `threadgarden-pair` for pairing (503 while no code is live) with
//! `pair.proof` and `pair.claim`, and `threadgarden-device.<token>` for the
//! paired device, with `devices.revoke`; anything else a device sends is
//! echoed back as it came (text as text, binary as binary), so a relay can
//! be checked both ways. It writes down every frame it gets.
#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

/// What the machine does.
#[derive(Clone)]
pub struct Behaviour {
    /// The live pairing code, normalised (`None`: no code is out, pairing sockets get 503).
    pub code: Option<String>,
    /// Proves for this fingerprint instead of its own: a man in the middle
    /// relaying the real machine's proof.
    pub proof_fingerprint: Option<String>,
    /// `pair.claim` answers this error code instead.
    pub claim_error: Option<&'static str>,
    pub machine_id: String,
    /// The certificate's validity, as years (default: valid now).
    pub valid_years: Option<(i32, i32)>,
    /// A device socket is closed with this code at once (a revoked or unknown token).
    pub device_close: Option<u16>,
    /// A device socket is never read once open: no pongs, as a link that died silently.
    pub stall: bool,
    /// `devices.revoke` closes the socket 4403 instead of answering.
    pub revoke_closes: bool,
}

impl Default for Behaviour {
    fn default() -> Self {
        Behaviour {
            code: Some("ABCDEFGHJKMN".into()),
            proof_fingerprint: None,
            claim_error: None,
            machine_id: "machine-desk".into(),
            valid_years: None,
            device_close: None,
            stall: false,
            revoke_closes: false,
        }
    }
}

type Hook = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Seen {
    frames: Mutex<Vec<String>>,
    binaries: Mutex<Vec<Vec<u8>>>,
    protocols: Mutex<Vec<String>>,
    connections: AtomicUsize,
    on_revoke: Mutex<Option<Hook>>,
}

pub struct FakeMachine {
    pub port: u16,
    pub fingerprint: String,
    pub token: String,
    pub device_id: String,
    behaviour: Behaviour,
    seen: Arc<Seen>,
    runtime: Option<tokio::runtime::Runtime>,
}

/// `fingerprint256` as Node gives it: upper-case hex pairs joined by `:`.
pub fn fingerprint(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest
        .as_ref()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// The machine's proof: HMAC-SHA256 keyed by the code over `<fingerprint>\n<nonce>`, as hex.
pub fn proof(code: &str, fingerprint: &str, nonce: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, code.as_bytes());
    let tag = ring::hmac::sign(&key, format!("{fingerprint}\n{nonce}").as_bytes());
    tag.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

impl FakeMachine {
    pub fn start(behaviour: Behaviour) -> FakeMachine {
        let mut params =
            rcgen::CertificateParams::new(vec!["threadgarden-test".to_string()]).unwrap();
        if let Some((from, to)) = behaviour.valid_years {
            params.not_before = rcgen::date_time_ymd(from, 1, 1);
            params.not_after = rcgen::date_time_ymd(to, 1, 1);
        }
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let der = params.self_signed(&key_pair).unwrap().der().to_vec();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![CertificateDer::from(der.clone())], key)
                .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        // Bound without `block_on`, so a test may start it from inside its own runtime.
        let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let listener = {
            let _in = runtime.enter();
            TcpListener::from_std(std_listener).unwrap()
        };
        let port = listener.local_addr().unwrap().port();
        let token = "7".repeat(64);
        let device_id = "device-phone".to_string();
        let seen = Arc::new(Seen::default());
        let me = Machine {
            behaviour: behaviour.clone(),
            fingerprint: fingerprint(&der),
            token: token.clone(),
            device_id: device_id.clone(),
            seen: seen.clone(),
        };
        let me = Arc::new(me);
        runtime.spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (acceptor, me) = (acceptor.clone(), me.clone());
                tokio::spawn(async move {
                    me.seen.connections.fetch_add(1, Ordering::SeqCst);
                    if let Ok(tls) = acceptor.accept(tcp).await {
                        me.serve(tls).await;
                    }
                });
            }
        });
        FakeMachine {
            port,
            fingerprint: fingerprint(&der),
            token,
            device_id,
            behaviour,
            seen,
            runtime: Some(runtime),
        }
    }

    /// Every text frame it received, on any socket.
    pub fn frames(&self) -> Vec<String> {
        self.seen.frames.lock().unwrap().clone()
    }

    /// Every binary frame it received.
    pub fn binaries(&self) -> Vec<Vec<u8>> {
        self.seen.binaries.lock().unwrap().clone()
    }

    /// The methods it was asked, in order.
    pub fn methods(&self) -> Vec<String> {
        self.frames()
            .iter()
            .filter_map(|f| serde_json::from_str::<Value>(f).ok())
            .filter_map(|v| v["method"].as_str().map(str::to_string))
            .collect()
    }

    /// The subprotocols sockets offered, in order.
    pub fn protocols(&self) -> Vec<String> {
        self.seen.protocols.lock().unwrap().clone()
    }

    /// TCP connections it accepted.
    pub fn connections(&self) -> usize {
        self.seen.connections.load(Ordering::SeqCst)
    }

    /// Runs `hook` when `devices.revoke` arrives, before it's answered.
    pub fn on_revoke(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.seen.on_revoke.lock().unwrap() = Some(Box::new(hook));
    }

    pub fn info(&self) -> Value {
        info(&self.behaviour.machine_id)
    }

    /// Stops listening: the machine is unreachable from now on.
    pub fn stop(&mut self) {
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

impl Drop for FakeMachine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn close_frame(code: u16) -> tokio_tungstenite::tungstenite::protocol::CloseFrame {
    tokio_tungstenite::tungstenite::protocol::CloseFrame {
        code: code.into(),
        reason: "".into(),
    }
}

fn info(id: &str) -> Value {
    json!({ "id": id, "name": "Desk", "platform": "linux", "headless": true, "home": "",
            "capabilities": ["remote", "projects", "move"] })
}

struct Machine {
    behaviour: Behaviour,
    fingerprint: String,
    token: String,
    device_id: String,
    seen: Arc<Seen>,
}

enum Socket {
    Pairing,
    Device,
    Refused,
}

impl Machine {
    async fn serve(&self, tls: tokio_rustls::server::TlsStream<tokio::net::TcpStream>) {
        let mut kind = Socket::Refused;
        #[allow(clippy::result_large_err)]
        let check = |req: &Request, mut res: Response| -> Result<Response, ErrorResponse> {
            let offered = req
                .headers()
                .get("Sec-WebSocket-Protocol")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
                .unwrap_or_default();
            self.seen.protocols.lock().unwrap().push(offered.clone());
            if offered == "threadgarden-pair" {
                if self.behaviour.code.is_none() {
                    let mut no = ErrorResponse::new(None);
                    *no.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
                    return Err(no);
                }
                kind = Socket::Pairing;
            } else if offered == format!("threadgarden-device.{}", self.token) {
                kind = Socket::Device;
            }
            if !offered.is_empty() {
                res.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    HeaderValue::from_str(&offered).unwrap(),
                );
            }
            Ok(res)
        };
        let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tls, check).await else {
            return;
        };
        if matches!(kind, Socket::Refused) {
            // As the remote listener: a credential it doesn't know is closed 4401 at once.
            let _ = ws.close(Some(close_frame(4401))).await;
            return;
        }
        if matches!(kind, Socket::Device) {
            if let Some(code) = self.behaviour.device_close {
                let _ = ws.close(Some(close_frame(code))).await;
                while ws.next().await.is_some() {}
                return;
            }
            if self.behaviour.stall {
                std::future::pending::<()>().await;
            }
        }
        while let Some(Ok(msg)) = ws.next().await {
            let text = match msg {
                Message::Text(text) => text,
                Message::Binary(b) => {
                    self.seen.binaries.lock().unwrap().push(b.to_vec());
                    if ws.send(Message::Binary(b)).await.is_err() {
                        return;
                    }
                    continue;
                }
                _ => continue,
            };
            self.seen.frames.lock().unwrap().push(text.to_string());
            let req: Value = serde_json::from_str(text.as_str()).unwrap_or_default();
            let method = req["method"].as_str().unwrap_or("");
            if matches!(kind, Socket::Device) && method != "devices.revoke" {
                // Not ours to answer: back as it came.
                if ws.send(Message::Text(text)).await.is_err() {
                    return;
                }
                continue;
            }
            if method == "devices.revoke" && self.behaviour.revoke_closes {
                if let Some(hook) = self.seen.on_revoke.lock().unwrap().as_ref() {
                    hook();
                }
                let _ = ws.close(Some(close_frame(4403))).await;
                while ws.next().await.is_some() {}
                return;
            }
            let answer = self.answer(&kind, method, &req["params"]);
            let frame = match answer {
                Ok(result) => json!({ "id": req["id"], "result": result }),
                Err(code) => json!({ "id": req["id"], "error": { "code": code, "message": code } }),
            };
            if ws.send(Message::text(frame.to_string())).await.is_err() {
                return;
            }
        }
    }

    fn answer(&self, kind: &Socket, method: &str, params: &Value) -> Result<Value, &'static str> {
        let b = &self.behaviour;
        match (kind, method) {
            (Socket::Pairing, "pair.proof") => {
                let nonce = params["nonce"].as_str().unwrap_or("");
                let fp = b.proof_fingerprint.as_deref().unwrap_or(&self.fingerprint);
                let proved = b.code.as_deref().map(|c| proof(c, fp, nonce));
                Ok(json!({ "proof": proved, "machine": info(&b.machine_id) }))
            }
            (Socket::Pairing, "pair.claim") => {
                if let Some(code) = b.claim_error {
                    return Err(code);
                }
                let given = params["code"]
                    .as_str()
                    .unwrap_or("")
                    .replace(['-', ' '], "")
                    .to_uppercase();
                if b.code.as_deref() != Some(given.as_str()) {
                    return Err("PAIRING_INVALID");
                }
                Ok(
                    json!({ "deviceId": self.device_id, "token": self.token, "machine": info(&b.machine_id) }),
                )
            }
            (Socket::Device, "devices.revoke") => {
                if let Some(hook) = self.seen.on_revoke.lock().unwrap().as_ref() {
                    hook();
                }
                Ok(json!({ "revoked": params["deviceId"] == json!(self.device_id) }))
            }
            _ => Err("METHOD_NOT_FOUND"),
        }
    }
}
