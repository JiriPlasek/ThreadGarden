//! A screen for the tests: a WebSocket client that talks to a core the way
//! the UI's `ServiceClient` does (the token as the `threadgarden.<token>`
//! subprotocol, then JSON requests with numeric ids).
#![allow(dead_code)]

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use threadgarden_core::secrets::MemorySecrets;
use threadgarden_core::{Core, CoreConfig, CoreHandle};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Runs a test's async part. The core has its own runtime, so this one only drives the screen.
pub fn block_on<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a test runtime")
        .block_on(f)
}

pub fn config(dir: &Path) -> CoreConfig {
    CoreConfig {
        data_dir: dir.to_path_buf(),
        secrets: Arc::new(MemorySecrets::default()),
        machine_name: "Phone".into(),
    }
}

/// A fresh core and the secrets it keeps.
pub fn core_with_secrets(dir: &Path) -> (CoreHandle, Arc<MemorySecrets>) {
    let secrets = Arc::new(MemorySecrets::default());
    let config = CoreConfig {
        secrets: secrets.clone(),
        ..config(dir)
    };
    (Core::spawn(config).expect("the core starts"), secrets)
}

/// A fresh core on its own data dir (not the process's shared one).
pub fn core(dir: &Path) -> CoreHandle {
    Core::spawn(config(dir)).expect("the core starts")
}

/// Opens a socket offering `protocols` as `Sec-WebSocket-Protocol` (none when empty).
pub async fn open_with(
    port: u16,
    path: &str,
    protocols: &[String],
) -> Result<Ws, tungstenite::Error> {
    let mut req = format!("ws://127.0.0.1:{port}{path}").into_client_request()?;
    if !protocols.is_empty() {
        req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&protocols.join(", ")).expect("a header value"),
        );
    }
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    Ok(ws)
}

/// Opens a socket the way the UI does, with the core's token.
pub async fn open(core: &CoreHandle) -> Ws {
    let protocols = [
        format!("threadgarden.{}", core.token()),
        format!("pahub.{}", core.token()),
    ];
    open_with(core.port(), "/", &protocols)
        .await
        .expect("the socket opens")
}

/// Sends a request and waits for the answer with its id (events in between are skipped).
pub async fn call(ws: &mut Ws, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await
    .expect("the request is sent");
    loop {
        match next(ws).await {
            Next::Frame(v) if v["id"] == json!(id) => return v,
            Next::Frame(_) => continue,
            other => panic!("no answer to {method}: {other:?}"),
        }
    }
}

#[derive(Debug)]
pub enum Next {
    Frame(Value),
    Closed(Option<u16>),
    Error(String),
    Timeout,
}

/// The next frame, or how the socket ended (within 5 s).
pub async fn next(ws: &mut Ws) -> Next {
    loop {
        let got = match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Err(_) => return Next::Timeout,
            Ok(got) => got,
        };
        return match got {
            Some(Ok(Message::Text(t))) => {
                Next::Frame(serde_json::from_str(t.as_str()).expect("JSON"))
            }
            Some(Ok(Message::Close(frame))) => {
                Next::Closed(frame.map(|f: CloseFrame| f.code.into()))
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => Next::Error(e.to_string()),
            None => Next::Closed(None),
        };
    }
}
