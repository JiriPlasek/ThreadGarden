//! The loopback WebSocket the screens connect to, as the service's
//! `ws-server.ts` has it: 127.0.0.1 only, the token as the
//! `threadgarden.<token>` subprotocol (a wrong one closes 4401), frames of
//! at most `MAX_REQUEST_BYTES`, and `/relay?machine=<id>` for a machine's
//! own screens (closed 4404 until Task 7 relays them).

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

use crate::MAX_REQUEST_BYTES;
use crate::methods::Router;

const PROTOCOL_PREFIX: &str = "threadgarden.";
const UNAUTHORIZED: u16 = 4401;
/// `RELAY_CLOSE.locked`: no such machine here, or no token for it.
const RELAY_LOCKED: u16 = 4404;
/// A socket that doesn't finish its handshake in this time is dropped.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Server {
    pub token: String,
    pub router: Router,
}

/// What a socket asked for, decided during its handshake.
enum Route {
    Unauthorized,
    Screen,
    Relay,
}

/// Compares in constant time, so the token can't be guessed byte by byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Accepts sockets until `shutdown` says stop.
pub(crate) async fn serve(
    listener: TcpListener,
    server: Arc<Server>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(connection(stream, server.clone(), shutdown.clone()));
                }
                // Out of file descriptors, say: wait a moment rather than spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            _ = shutdown.changed() => return,
        }
    }
}

async fn connection(stream: TcpStream, server: Arc<Server>, shutdown: watch::Receiver<bool>) {
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
                    Route::Relay
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
        Route::Unauthorized => close(ws, UNAUTHORIZED, "unauthorized").await,
        Route::Relay => close(ws, RELAY_LOCKED, "no paired machines here").await,
        Route::Screen => screen(ws, server, shutdown).await,
    }
}

fn close_frame(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }))
}

async fn close(mut ws: WebSocketStream<TcpStream>, code: u16, reason: &'static str) {
    let _ = ws.send(close_frame(code, reason)).await;
    // Wait (briefly) for the peer's close, so it learns the code before the TCP connection goes.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while ws.next().await.is_some() {}
    })
    .await;
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
        let (server, tx) = (server.clone(), tx.clone());
        tokio::spawn(async move {
            let answer = server.router.dispatch(&text).await;
            let _ = tx.send(Message::text(answer.to_string()));
        });
    }
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
    fn tokens_compare_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
        assert!(!same("", "a"));
    }
}
