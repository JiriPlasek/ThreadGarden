//! The loopback WebSocket the screens connect to, as the service's
//! `ws-server.ts` has it: 127.0.0.1 only, the token as the
//! `threadgarden.<token>` subprotocol (a wrong one closes 4401), frames of
//! at most `MAX_REQUEST_BYTES`, and `/relay?machine=<id>` for a machine's
//! own screens (closed 4404 until Task 7 relays them).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use subtle::ConstantTimeEq;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

use crate::MAX_REQUEST_BYTES;
use crate::methods::{LocalEvents, Router};
use crate::relay::Relays;

const PROTOCOL_PREFIX: &str = "threadgarden.";
const UNAUTHORIZED: u16 = 4401;
/// A socket that doesn't finish its handshake in this time is dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Server {
    pub token: String,
    pub router: Router,
    /// Events for every screen (never for a relay).
    pub events: LocalEvents,
    pub relays: Arc<Relays>,
    /// Sockets being served now (screens and relays), so stopping can let them close first.
    pub live: Arc<AtomicUsize>,
}

/// Counts a served socket, down again however it ends.
struct Live(Arc<AtomicUsize>);

impl Live {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Live(count.clone())
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a socket asked for, decided during its handshake.
enum Route {
    Unauthorized,
    Screen,
    /// `/relay?machine=<id>`: the machine named, if any.
    Relay(Option<String>),
}

/// The `machine` of a `/relay` query, percent-decoded (`encodeURIComponent` in the UI).
fn machine_of(query: Option<&str>) -> Option<String> {
    let value = query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("machine="))?;
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'%' => return None,
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Sockets still in their handshake, or being closed unauthenticated, at
/// once: more are dropped as they come, so nothing local can pile them up.
const MAX_PENDING: usize = 8;
/// What a socket closed 4401 may still send before it's dropped: it's read
/// and thrown away as bytes, never assembled into a message.
const UNAUTHORIZED_DRAIN_BYTES: usize = 64 * 1024;

/// Compares in constant time (`subtle`), so the token can't be guessed byte by byte.
fn same(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Accepts sockets until `shutdown` says stop.
pub(crate) async fn serve(
    listener: TcpListener,
    server: Arc<Server>,
    mut shutdown: watch::Receiver<bool>,
) {
    let pending = Arc::new(Semaphore::new(MAX_PENDING));
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    // No slot: dropped at once, before a byte of it is read.
                    let Ok(slot) = pending.clone().try_acquire_owned() else { continue };
                    tokio::spawn(connection(stream, server.clone(), shutdown.clone(), slot));
                }
                // Out of file descriptors, say: wait a moment rather than spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            _ = shutdown.changed() => return,
        }
    }
}

async fn connection(
    stream: TcpStream,
    server: Arc<Server>,
    shutdown: watch::Receiver<bool>,
    slot: OwnedSemaphorePermit,
) {
    let _live = Live::new(&server.live);
    let mut route = Route::Unauthorized;
    // The error type is tungstenite's callback signature (an HTTP response), and it's never returned.
    #[allow(clippy::result_large_err)]
    let check = |req: &Request, mut res: Response| {
        // Echo our subprotocol, so a browser completes the handshake; the token decides after.
        let offered = req
            .headers()
            .get_all(SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .find(|p| p.starts_with(PROTOCOL_PREFIX))
            .map(str::to_string);
        if let Some(protocol) = offered
            && let Ok(value) = HeaderValue::from_str(&protocol)
        {
            res.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, value);
            if same(&protocol[PROTOCOL_PREFIX.len()..], &server.token) {
                route = if req.uri().path() == "/relay" {
                    Route::Relay(machine_of(req.uri().query()))
                } else {
                    Route::Screen
                };
            }
        }
        Ok(res)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_REQUEST_BYTES))
        .max_frame_size(Some(MAX_REQUEST_BYTES));
    let handshake = accept_hdr_async_with_config(stream, check, Some(config));
    let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await else {
        return;
    };
    match route {
        // It keeps its slot until it's gone.
        Route::Unauthorized => refuse(ws).await,
        Route::Relay(machine) => {
            drop(slot);
            server.relays.attach(ws, machine, shutdown).await
        }
        Route::Screen => {
            drop(slot);
            screen(ws, server, shutdown).await
        }
    }
}

/// Closes an unauthenticated socket 4401. What it sends after that is read
/// as plain bytes and dropped (at most 64 KiB, for at most 2 s), so its
/// frames are never assembled: just enough for the peer to see the close
/// code rather than a reset.
async fn refuse(mut ws: WebSocketStream<TcpStream>) {
    if ws
        .send(close_frame(UNAUTHORIZED, "unauthorized"))
        .await
        .is_err()
    {
        return;
    }
    let tcp = ws.get_mut();
    // The core ends the connection first (a FIN), so the peer needn't wait
    // for it; reading on below keeps that a FIN rather than a reset.
    let _ = tcp.shutdown().await;
    let mut buf = [0u8; 4096];
    let mut drained = 0;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while drained < UNAUTHORIZED_DRAIN_BYTES {
            if tcp.readable().await.is_err() {
                return;
            }
            match tcp.try_read(&mut buf) {
                Ok(0) => return,
                Ok(n) => drained += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(_) => return,
            }
        }
    })
    .await;
}

fn close_frame(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }))
}

/// Serves one screen: each request answered on its own, so a slow method
/// (pairing, a plug) never holds up the others.
async fn screen(
    ws: WebSocketStream<TcpStream>,
    server: Arc<Server>,
    mut shutdown: watch::Receiver<bool>,
) {
    let (mut sink, mut frames) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let last = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || last {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // The screens' events, sent on with the answers.
    let mut events = server.events.subscribe();
    let to_screen = tx.clone();
    let forward = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if to_screen.send(Message::text(event.to_string())).is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
    // The end of this screen's latest write, which the next one waits for.
    let mut last_write: Option<oneshot::Receiver<()>> = None;
    loop {
        let frame = tokio::select! {
            frame = frames.next() => frame,
            _ = shutdown.changed() => {
                let _ = tx.send(close_frame(1001, "the core stopped"));
                break;
            }
        };
        let text = match frame {
            Some(Ok(Message::Text(t))) => t.as_str().to_string(),
            // `ws` hands the service a binary frame as its text too.
            Some(Ok(Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
            Some(Ok(Message::Close(_))) | None => break,
            Some(Ok(_)) => continue,
            Some(Err(WsError::Capacity(_))) => {
                let _ = tx.send(close_frame(1009, "Max payload size exceeded"));
                break;
            }
            Some(Err(_)) => break,
        };
        let req = match Router::parse(&text) {
            Ok(req) => req,
            Err(refusal) => {
                let _ = tx.send(Message::text(refusal.to_string()));
                continue;
            }
        };
        // A write waits for this screen's write before it, as the service
        // applies them in message order; everything else runs at once.
        let turn = server.router.is_ordered(&req.method).then(|| {
            let (done, next) = oneshot::channel::<()>();
            (last_write.replace(next), done)
        });
        let (server, tx) = (server.clone(), tx.clone());
        tokio::spawn(async move {
            let done = match turn {
                Some((before, done)) => {
                    if let Some(before) = before {
                        // Sent or dropped, the write before is over either way.
                        let _ = before.await;
                    }
                    Some(done)
                }
                None => None,
            };
            let answer = server.router.answer_request(req).await;
            drop(done);
            let _ = tx.send(Message::text(answer.to_string()));
        });
    }
    forward.abort();
    let _ = forward.await;
    drop(tx);
    let _ = writer.await;
    // Read on until the peer closes too (or it's been long enough), as `close` does.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while frames.next().await.is_some() {}
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::same;

    #[test]
    fn the_relayed_machine_is_read_from_the_query() {
        use super::machine_of;
        assert_eq!(machine_of(Some("machine=m1")), Some("m1".into()));
        assert_eq!(
            machine_of(Some("x=1&machine=a%3Ab%20c")),
            Some("a:b c".into())
        );
        assert_eq!(machine_of(Some("machine=bad%2")), None);
        assert_eq!(machine_of(Some("other=1")), None);
        assert_eq!(machine_of(None), None);
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
        assert!(!same("", "a"));
    }
}
