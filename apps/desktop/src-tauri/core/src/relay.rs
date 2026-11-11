//! `/relay?machine=<id>`, as the service's `server/relay.ts`: each screen
//! socket gets its own link to the machine (TLS pinned to its certificate,
//! the device token in the subprotocol) and the two are piped. Frames go
//! through verbatim both ways, text as text and binary as binary, and are
//! never parsed, logged or rewritten. Frames a screen sends before the link
//! is up wait for it. Either side closing closes the other; the screen
//! learns why through the `RELAY_CLOSE` codes:
//!
//! - 4404 `locked`: no such machine here, or no token for it;
//! - 4409 `mismatch`: another certificate answered at the address (nothing was sent to it);
//! - 4403 `refused`: the machine refused this device (revoked: pair again);
//! - 4502 `unreachable`: it couldn't be reached, or the link dropped (the screen retries).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, watch};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::machines::token_key;
use crate::pairing::{self, DEVICE_PROTOCOL_PREFIX, LinkError};
use crate::secrets::Secrets;
use crate::store::{Store, StoredMachine};
use crate::{CoreEvent, MAX_REQUEST_BYTES, Timing};

pub const LOCKED: u16 = 4404;
pub const MISMATCH: u16 = 4409;
pub const REFUSED: u16 = 4403;
pub const UNREACHABLE: u16 = 4502;
/// Largest frame taken from a machine: `ws`'s default, as the service's link has it.
const LINK_MAX_FRAME: usize = 100 * 1024 * 1024;

fn reason(code: u16) -> &'static str {
    match code {
        LOCKED => "unknown or locked machine",
        MISMATCH => "another certificate answered at this address",
        REFUSED => "the machine refused this device",
        UNREACHABLE => "the machine cannot be reached",
        1001 => "shutting down",
        _ => "",
    }
}

/// What the screen is told when an open link closes: a refused token (4401,
/// 4403) is `refused`; anything else, a clean close included, `unreachable`.
fn close_for(remote: Option<u16>) -> u16 {
    match remote {
        Some(4401 | 4403) => REFUSED,
        _ => UNREACHABLE,
    }
}

/// What the screen is told when the link never opened.
fn failure_code(e: &LinkError) -> u16 {
    match e {
        LinkError::Pin => MISMATCH,
        LinkError::Refused(401 | 403) => REFUSED,
        _ => UNREACHABLE,
    }
}

/// Why, for a log: the machine and the failure, never a frame or a token.
fn describe(e: &LinkError) -> String {
    match e {
        LinkError::Pin => "the machine presented another certificate".into(),
        LinkError::Refused(status) => format!("HTTP {status}"),
        LinkError::Unreachable(why) => why.clone(),
    }
}

type Ws = WebSocketStream<TcpStream>;
/// The relays open now, by key: their machine, and how to end one (with a close code).
type Open = HashMap<u64, (String, watch::Sender<Option<u16>>)>;

pub struct Relays {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    timing: Timing,
    events: broadcast::Sender<CoreEvent>,
    /// The relays open now: their machine and how to end them.
    open: Mutex<Open>,
    next: AtomicU64,
}

impl Relays {
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<dyn Secrets>,
        timing: Timing,
        events: broadcast::Sender<CoreEvent>,
    ) -> Self {
        Relays {
            store,
            secrets,
            timing,
            events,
            open: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        }
    }

    fn open(&self) -> std::sync::MutexGuard<'_, Open> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ends the machine's relays with `code`: 4502 when it moved (the screens
    /// reconnect to the new address), 4404 when it was removed.
    pub fn drop_machine(&self, machine_id: &str, code: u16) {
        for (id, end) in self.open().values() {
            if id == machine_id {
                let _ = end.send(Some(code));
            }
        }
    }

    fn failed(&self, machine_id: &str, reason: String) {
        let _ = self.events.send(CoreEvent::LinkFailed {
            machine_id: machine_id.to_string(),
            reason,
        });
    }

    /// Relays an authenticated screen socket to the machine `machine_id`.
    pub async fn attach(
        &self,
        mut ui: Ws,
        machine_id: Option<String>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let Some(machine_id) = machine_id else {
            return end(&mut ui, LOCKED).await;
        };
        // Registered before anything is awaited: a move or a removal from now on reaches it.
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        let (ender, mut dropped) = watch::channel(None);
        self.open().insert(key, (machine_id.clone(), ender));
        let code = self
            .relay(&mut ui, &machine_id, &mut dropped, &mut shutdown)
            .await;
        self.open().remove(&key);
        if let Some(code) = code {
            end(&mut ui, code).await;
        }
    }

    /// Runs the relay; the code to close the screen with, if it's still to be told.
    async fn relay(
        &self,
        ui: &mut Ws,
        machine_id: &str,
        dropped: &mut watch::Receiver<Option<u16>>,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<u16> {
        let machine = self
            .store
            .machines()
            .into_iter()
            .find(|m| m.id == machine_id);
        let token = match &machine {
            Some(m) => {
                let (secrets, key) = (self.secrets.clone(), token_key(&m.id));
                tokio::task::spawn_blocking(move || secrets.get(&key))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten()
            }
            None => None,
        };
        // Moved or removed while the token was read: what that says, not a link.
        if let Some(code) = *dropped.borrow_and_update() {
            return Some(code);
        }
        let (Some(machine), Some(token)) = (machine, token) else {
            return Some(LOCKED);
        };
        let protocol = format!("{DEVICE_PROTOCOL_PREFIX}{token}");
        let opening = pairing::open_link(
            &machine.address,
            machine.port,
            &protocol,
            Some(&machine.fingerprint),
            self.timing.link_timeout,
            LINK_MAX_FRAME,
        );
        tokio::pin!(opening);
        // What the screen sends before the link is up waits for it (bounded all the same).
        let mut waiting = Vec::new();
        let mut waiting_bytes = 0;
        let link = loop {
            tokio::select! {
                opened = &mut opening => match opened {
                    Ok((link, _)) => break link,
                    Err(e) => {
                        self.failed(&machine.id, describe(&e));
                        return Some(failure_code(&e));
                    }
                },
                frame = ui.next() => match frame {
                    Some(Ok(m @ (Message::Text(_) | Message::Binary(_)))) => {
                        waiting_bytes += m.len();
                        if waiting_bytes > MAX_REQUEST_BYTES {
                            return Some(1009);
                        }
                        waiting.push(m);
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Some(1000),
                    Some(Ok(_)) => {}
                },
                _ = dropped.changed() => return Some(dropped.borrow().unwrap_or(UNREACHABLE)),
                _ = shutdown.changed() => return Some(1001),
            }
        };
        self.linked(ui, link, waiting, &machine, dropped, shutdown)
            .await;
        None
    }

    /// Pipes an open link. Each direction runs on its own, so a side that
    /// stops reading (a frozen webview, a machine gone quiet) holds up only
    /// that direction: a move, a removal, stopping and the pings still act.
    /// The screen is told why first, then the link closed (1000), as `relay.ts`.
    async fn linked(
        &self,
        ui: &mut Ws,
        link: pairing::Link,
        waiting: Vec<Message>,
        machine: &StoredMachine,
        dropped: &mut watch::Receiver<Option<u16>>,
        shutdown: &mut watch::Receiver<bool>,
    ) {
        let (link_sink, mut link_stream) = link.split();
        let link_sink = tokio::sync::Mutex::new(link_sink);
        let answered = AtomicBool::new(true);
        let ping = self.timing.ping;
        {
            let (mut ui_sink, mut ui_stream) = (&mut *ui).split();
            let code = {
                // Screen to machine (what waited first).
                let up = async {
                    for m in waiting {
                        if link_sink.lock().await.send(m).await.is_err() {
                            return UNREACHABLE;
                        }
                    }
                    loop {
                        match ui_stream.next().await {
                            Some(Ok(m @ (Message::Text(_) | Message::Binary(_)))) => {
                                if link_sink.lock().await.send(m).await.is_err() {
                                    return UNREACHABLE;
                                }
                            }
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return 1000,
                            Some(Ok(_)) => {}
                        }
                    }
                };
                // Machine to screen.
                let down = async {
                    loop {
                        match link_stream.next().await {
                            Some(Ok(m @ (Message::Text(_) | Message::Binary(_)))) => {
                                if ui_sink.send(m).await.is_err() {
                                    return 1000;
                                }
                            }
                            Some(Ok(Message::Pong(_))) => answered.store(true, Ordering::SeqCst),
                            Some(Ok(Message::Close(frame))) => {
                                return close_for(frame.map(|f| f.code.into()));
                            }
                            Some(Ok(_)) => {}
                            Some(Err(_)) | None => return UNREACHABLE,
                        }
                    }
                };
                // A link whose pong hasn't come back by the next ping is dead (a Wi-Fi drop sends no close).
                let pinger = async {
                    let mut pings = interval_at(Instant::now() + ping, ping);
                    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);
                    loop {
                        pings.tick().await;
                        if !answered.swap(false, Ordering::SeqCst) {
                            self.failed(&machine.id, "no pong: the link is dead".into());
                            return UNREACHABLE;
                        }
                        let sent = async {
                            link_sink
                                .lock()
                                .await
                                .send(Message::Ping(Vec::new().into()))
                                .await
                        };
                        // A machine that stopped reading (its link backed up) is as good as dead.
                        if !matches!(tokio::time::timeout(ping, sent).await, Ok(Ok(()))) {
                            self.failed(&machine.id, "the link stopped taking frames".into());
                            return UNREACHABLE;
                        }
                    }
                };
                tokio::pin!(up, down, pinger);
                let code = tokio::select! {
                    // What has arrived (a pong among it) is read before a ping is checked.
                    biased;
                    _ = dropped.changed() => dropped.borrow().unwrap_or(UNREACHABLE),
                    _ = shutdown.changed() => 1001,
                    code = &mut down => code,
                    code = &mut up => code,
                    code = &mut pinger => code,
                };
                code
            };
            // The screen first: why it ended (bounded, as it may not be reading).
            let frame = CloseFrame {
                code: CloseCode::from(code),
                reason: reason(code).into(),
            };
            let _ =
                tokio::time::timeout(CLOSE_WAIT, ui_sink.send(Message::Close(Some(frame)))).await;
            code
        };
        // Then the machine: a normal close.
        let normal = CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        };
        let _ = tokio::time::timeout(CLOSE_WAIT, async {
            link_sink
                .lock()
                .await
                .send(Message::Close(Some(normal)))
                .await
        })
        .await;
        // The screen's own close, briefly.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while ui.next().await.is_some() {}
        })
        .await;
    }
}

/// How long a close may take to go out to a side that may not be reading.
const CLOSE_WAIT: Duration = Duration::from_millis(500);

/// Closes the screen's socket with `code`, waiting briefly for its close.
async fn end(ui: &mut Ws, code: u16) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: reason(code).into(),
    };
    let _ = tokio::time::timeout(CLOSE_WAIT, ui.send(Message::Close(Some(frame)))).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while ui.next().await.is_some() {}
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_codes_are_the_services() {
        assert_eq!(close_for(Some(4401)), REFUSED);
        assert_eq!(close_for(Some(4403)), REFUSED);
        assert_eq!(close_for(Some(1000)), UNREACHABLE);
        assert_eq!(close_for(Some(1001)), UNREACHABLE);
        assert_eq!(close_for(None), UNREACHABLE);
        assert_eq!(failure_code(&LinkError::Pin), MISMATCH);
        assert_eq!(failure_code(&LinkError::Refused(401)), REFUSED);
        assert_eq!(failure_code(&LinkError::Refused(403)), REFUSED);
        assert_eq!(failure_code(&LinkError::Refused(503)), UNREACHABLE);
        assert_eq!(
            failure_code(&LinkError::Unreachable("x".into())),
            UNREACHABLE
        );
    }
}
