use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, Notify};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream};

pub type Hook = Box<dyn Fn(&str, &str) + Send + Sync>;
pub static ALERT: OnceLock<Hook> = OnceLock::new();
pub static STATUS: OnceLock<Hook> = OnceLock::new();
pub static CORE: OnceLock<Core> = OnceLock::new();

pub struct Core {
    pub port: u16,
    pub token: String,
    log_tx: broadcast::Sender<String>,
    dir: String,
    net: Arc<Notify>,
    started: Instant,
    _rt: tokio::runtime::Runtime,
}

#[derive(Clone, Serialize, Deserialize)]
struct Machine { id: String, name: String, address: String, port: u16, fingerprint: String, token: String }

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub fn log(line: &str) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let Some(c) = CORE.get() else { return };
    let up = c.started.elapsed().as_secs();
    let text = format!("[t={secs} up={up}s] {line}");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}/spike.log", c.dir)) {
        let _ = writeln!(f, "{text}");
    }
    let _ = c.log_tx.send(text);
}

pub fn network_changed() {
    if let Some(c) = CORE.get() { log("network changed"); c.net.notify_waiters(); }
}

/// Starting twice returns the same core: the service and the screens may both ask.
pub fn start(dir: String) -> &'static Core {
    let mut first = false;
    let core = CORE.get_or_init(|| {
        first = true;
        let _ = std::fs::create_dir_all(&dir);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = hex::encode(rand::random::<[u8; 24]>());
        let (log_tx, _) = broadcast::channel(256);
        rt.spawn(serve(listener));
        Core { port, token, log_tx, dir, net: Arc::new(Notify::new()), started: Instant::now(), _rt: rt }
    });
    if first {
        log("core started");
        for m in load(&core.dir) { core._rt.spawn(link(m)); }
    } else {
        log("start asked again: same core");
    }
    core
}

fn load(dir: &str) -> Vec<Machine> {
    std::fs::read(format!("{dir}/machines.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

async fn serve(listener: tokio::net::TcpListener) {
    while let Ok((s, _)) = listener.accept().await {
        tokio::spawn(async move {
            let check = |req: &Request, res: Response| {
                let want = CORE.get().map(|c| format!("token={}", c.token)).unwrap_or_default();
                if req.uri().query() == Some(want.as_str()) { Ok(res) } else {
                    Err(tokio_tungstenite::tungstenite::http::Response::builder().status(401).body(None).unwrap())
                }
            };
            let Ok(ws) = tokio_tungstenite::accept_hdr_async(s, check).await else { return };
            ui(ws).await;
        });
    }
}

async fn ui(ws: WebSocketStream<TcpStream>) {
    let core = CORE.get().unwrap();
    let mut rx = core.log_tx.subscribe();
    let (mut tx, mut read) = ws.split();
    let tail = std::fs::read_to_string(format!("{}/spike.log", core.dir)).unwrap_or_default();
    let lines: Vec<&str> = tail.lines().rev().take(60).collect();
    for l in lines.iter().rev() { let _ = tx.send(Message::text(l.to_string())).await; }
    log("screen connected");
    loop {
        tokio::select! {
            l = rx.recv() => match l {
                Ok(l) => { if tx.send(Message::text(l)).await.is_err() { break } }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => break,
            },
            m = read.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    let address = v["address"].as_str().unwrap_or("").to_string();
                    let port = v["port"].as_u64().unwrap_or(0) as u16;
                    let code = v["code"].as_str().unwrap_or("").to_string();
                    match v["cmd"].as_str() {
                        Some("pair") => { tokio::spawn(async move {
                            match pair(&address, port, &code).await {
                                Ok(m) => { log(&format!("paired with {}", m.name)); tokio::spawn(link(m)); }
                                Err(e) => log(&format!("pairing failed: {e}")),
                            }
                        }); }
                        Some("probe") => { tokio::spawn(async move {
                            let r = tokio::time::timeout(Duration::from_secs(8), TcpStream::connect((address.as_str(), port))).await;
                            let ok = matches!(r, Ok(Ok(_)));
                            log(&format!("probe {address}:{port}: {}", if ok { "reachable" } else { "NOT reachable" }));
                        }); }
                        _ => {}
                    }
                }
                Some(Ok(_)) => {}
                _ => break,
            },
        }
    }
}

#[derive(Debug)]
struct Pin { want: Option<String>, seen: Arc<Mutex<Option<String>>> }

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

impl ServerCertVerifier for Pin {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let f = fingerprint(end.as_ref());
        *self.seen.lock().unwrap() = Some(f.clone());
        match &self.want {
            Some(w) if *w != f => Err(rustls::Error::General("pin mismatch".into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider().signature_verification_algorithms.supported_schemes()
    }
}

async fn open(address: &str, port: u16, proto: &str, want: Option<String>) -> Result<(Ws, Option<String>), String> {
    let seen = Arc::new(Mutex::new(None));
    let cfg = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
        .dangerous().with_custom_certificate_verifier(Arc::new(Pin { want, seen: seen.clone() }))
        .with_no_client_auth();
    let mut req = format!("wss://{address}:{port}/").into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert("Sec-WebSocket-Protocol", proto.parse().map_err(|_| "bad protocol".to_string())?);
    let fut = connect_async_tls_with_config(req, None, false, Some(Connector::Rustls(Arc::new(cfg))));
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), fut).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    let f = seen.lock().unwrap().clone();
    Ok((ws, f))
}

async fn request(ws: &mut Ws, id: u64, method: &str, params: Value) -> Result<Value, String> {
    ws.send(Message::text(json!({"id": id, "method": method, "params": params}).to_string())).await.map_err(|e| e.to_string())?;
    let fut = async {
        while let Some(m) = ws.next().await {
            if let Message::Text(t) = m.map_err(|e| e.to_string())? {
                let v: Value = serde_json::from_str(t.as_str()).map_err(|e| e.to_string())?;
                if v["id"].as_u64() == Some(id) {
                    if !v["error"].is_null() { return Err(v["error"]["code"].to_string()); }
                    return Ok(v["result"].clone());
                }
            }
        }
        Err("closed".to_string())
    };
    tokio::time::timeout(Duration::from_secs(10), fut).await.map_err(|_| "timed out".to_string())?
}

async fn pair(address: &str, port: u16, code: &str) -> Result<Machine, String> {
    let code: String = code.chars().filter(|c| *c != '-' && !c.is_whitespace()).collect::<String>().to_uppercase();
    let (mut ws, seen) = open(address, port, "threadgarden-pair", None).await?;
    let fp = seen.ok_or("no certificate seen")?;
    let nonce = hex::encode(rand::random::<[u8; 32]>());
    let ans = request(&mut ws, 1, "pair.proof", json!({"nonce": nonce})).await?;
    let mut mac = Hmac::<Sha256>::new_from_slice(code.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(format!("{fp}\n{nonce}").as_bytes());
    let proof = hex::decode(ans["proof"].as_str().unwrap_or("")).map_err(|_| "bad proof".to_string())?;
    // The code goes out only after the machine proved it knows it for this certificate.
    mac.verify_slice(&proof).map_err(|_| "the machine failed the proof; the code was not sent".to_string())?;
    let c = request(&mut ws, 2, "pair.claim", json!({"code": code, "deviceName": "Phone trial"})).await?;
    let _ = ws.close(None).await;
    let m = Machine {
        id: c["machine"]["id"].as_str().unwrap_or("").into(),
        name: c["machine"]["name"].as_str().unwrap_or("machine").into(),
        address: address.into(), port, fingerprint: fp,
        token: c["token"].as_str().ok_or("no token")?.into(),
    };
    let dir = &CORE.get().unwrap().dir;
    let mut all = load(dir);
    all.retain(|x| x.id != m.id);
    all.push(m.clone());
    std::fs::write(format!("{dir}/machines.json"), serde_json::to_vec(&all).unwrap()).map_err(|e| e.to_string())?;
    Ok(m)
}

fn status(t: &str, b: &str) { if let Some(h) = STATUS.get() { h(t, b) } }
fn alert(t: &str, b: &str) { if let Some(h) = ALERT.get() { h(t, b) } }

async fn link(m: Machine) {
    let net = CORE.get().unwrap().net.clone();
    let mut wait = 2u64;
    let (mut frames, mut bytes, mut drops) = (0u64, 0u64, 0u64);
    let mut last_report = Instant::now();
    loop {
        match open(&m.address, m.port, &format!("threadgarden-device.{}", m.token), Some(m.fingerprint.clone())).await {
            Ok((mut ws, _)) => {
                wait = 2;
                log(&format!("{}: link open (drops so far {drops})", m.name));
                status("Connected to your machines", &m.name);
                let _ = ws.send(Message::text(json!({"id": 1, "method": "hello", "params": {"protocolVersion": 11, "client": "phone-spike"}}).to_string())).await;
                let mut tick = tokio::time::interval(Duration::from_secs(15));
                let mut ponged = true;
                loop {
                    tokio::select! {
                        _ = tick.tick() => {
                            if !ponged { log(&format!("{}: no pong, link dead", m.name)); break; }
                            ponged = false;
                            if ws.send(Message::Ping(vec![].into())).await.is_err() { break; }
                            if last_report.elapsed() > Duration::from_secs(3600) {
                                log(&format!("{}: last hour {frames} frames, {bytes} bytes", m.name));
                                frames = 0; bytes = 0; last_report = Instant::now();
                            }
                        }
                        f = ws.next() => match f {
                            Some(Ok(Message::Pong(_))) => ponged = true,
                            Some(Ok(Message::Text(t))) => {
                                frames += 1; bytes += t.len() as u64;
                                let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                                let title = v["data"]["title"].as_str().unwrap_or("A chat").to_string();
                                match v["event"].as_str() {
                                    Some("needsYou") => { log(&format!("ALERT needs you: {title}")); alert(&format!("{}: {title} needs you", m.name), v["data"]["what"].as_str().unwrap_or("")); }
                                    Some("chatFinished") => { log(&format!("ALERT finished: {title}")); alert(&format!("{}: {title} finished", m.name), ""); }
                                    _ => {}
                                }
                            }
                            Some(Ok(Message::Close(c))) => { log(&format!("{}: closed {c:?}", m.name)); break; }
                            Some(Ok(_)) => {}
                            _ => { log(&format!("{}: read ended", m.name)); break; }
                        },
                        _ = net.notified() => { log(&format!("{}: network changed, reconnecting", m.name)); break; }
                    }
                }
                drops += 1;
                status("Reconnecting", &m.name);
            }
            Err(e) => log(&format!("{}: can't connect: {e} (retry in {wait}s)", m.name)),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
            _ = net.notified() => { wait = 2; }
        }
        wait = (wait * 2).min(60);
    }
}
