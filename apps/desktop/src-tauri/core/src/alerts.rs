//! Alert links: the core's own link to each paired machine with a token,
//! separate from the screens' relays, so the phone knows a chat needs you (or
//! finished) with no screen open. Machines send `needsYou` and `chatFinished`
//! to every device already; these links listen for them and drop everything
//! else (the chats' streamed output) unread and unstored.
//!
//! As the desktop's `notifications.ts` (Rulings R12, R13): every live
//! `needsYou` alerts when the `notifications` setting is on, every
//! `chatFinished` when `notifyOnFinish` is; the chat on screen
//! (`alerts.setActive`) doesn't alert. Nothing is replayed after a
//! reconnect, so what happened while the phone was away shows as unread in
//! the screens rather than as a burst. A link never sends `ui.visibility`,
//! which is global to the machine: only `hello`, and pings.
//!
//! An unreachable machine is retried with back-off, 2 s doubling to 60 s. The
//! back-off starts over only once a link has proved itself (its `hello`
//! answered and a pong back, or up for `backoff_max`): a machine that takes
//! the link and drops it at once is backed off too. A network change retries
//! the links waiting to at once, and checks the open ones with a ping,
//! dropping only those that don't answer in time. Links ping every 15 s, and
//! one whose pong isn't back by the next ping is dead. Disconnect closes every
//! link until Connect, and that's kept across restarts.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use tokio_tungstenite::tungstenite::Message;

use crate::machines::token_key;
use crate::methods::{MethodError, Router};
use crate::pairing::{self, DEVICE_PROTOCOL_PREFIX, Link, LinkError};
use crate::secrets::Secrets;
use crate::store::Store;
use crate::{
    AlertKind, CoreEvent, LinkStatus, PROTOCOL_VERSION, Timing, accepts_remote_protocol, settings,
};

/// Largest frame taken from a machine (its streamed output included): `ws`'s default.
const LINK_MAX_FRAME: usize = 100 * 1024 * 1024;
/// The longest a ping or `hello` may take to go out (a few bytes: longer means the link backed up).
const SEND_WAIT: Duration = Duration::from_secs(1);
const HELLO_ID: u64 = 1;
/// What a machine that refused this device is reported as.
pub const REFUSED: &str = "refused: pair again";

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The waits between attempts: `start`, doubling, never more than `max`.
#[derive(Debug, Clone)]
pub struct Backoff {
    start: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    pub fn new(start: Duration, max: Duration) -> Self {
        Backoff {
            start,
            max,
            next: start,
        }
    }

    /// The wait before the next attempt (and the one after doubles).
    pub fn wait(&mut self) -> Duration {
        let now = self.next;
        self.next = (self.next * 2).min(self.max);
        now
    }

    /// Back to the shortest wait (a link proved itself, or the network changed).
    pub fn reset(&mut self) {
        self.next = self.start;
    }
}

/// How a link that was open ended.
enum End {
    /// Stopped here: Disconnect, the machine removed or moved.
    Stop,
    /// It didn't answer after a network change: reconnect at once.
    Network,
    /// The machine refused this device (revoked): no point retrying.
    Refused,
    /// The machine speaks a protocol this phone doesn't: no point retrying.
    Incompatible(Value),
    /// Closed, dropped or dead: retry with back-off.
    Dropped,
}

/// One machine's link: how to stop it, and which start it was.
struct Running {
    generation: u64,
    stop: watch::Sender<bool>,
}

/// Whether links are on, and the ones running: changed together, under one lock.
struct Links {
    on: bool,
    running: HashMap<String, Running>,
}

pub struct Alerts {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    timing: Timing,
    events: broadcast::Sender<CoreEvent>,
    runtime: tokio::runtime::Handle,
    /// The chat on screen, `(machine id, session id)`: it doesn't alert.
    active: Mutex<Option<(String, String)>>,
    links: Mutex<Links>,
    /// The machines whose link is open now, with that link's start, so an
    /// old link ending can't clear a newer one's entry.
    up: Mutex<HashMap<String, u64>>,
    /// Bumped on every network change.
    network: watch::Sender<u64>,
    generation: AtomicU64,
}

impl Alerts {
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<dyn Secrets>,
        timing: Timing,
        events: broadcast::Sender<CoreEvent>,
        runtime: tokio::runtime::Handle,
    ) -> Arc<Self> {
        let on = !store.links_off();
        Arc::new(Alerts {
            store,
            secrets,
            timing,
            events,
            runtime,
            active: Mutex::new(None),
            links: Mutex::new(Links {
                on,
                running: HashMap::new(),
            }),
            up: Mutex::new(HashMap::new()),
            network: watch::channel(0).0,
            generation: AtomicU64::new(0),
        })
    }

    pub fn status(&self) -> LinkStatus {
        let (on, machines) = {
            let links = locked(&self.links);
            (links.on, links.running.len())
        };
        LinkStatus {
            on,
            machines,
            connected: locked(&self.up).len(),
        }
    }

    fn tell_status(&self) {
        let _ = self.events.send(CoreEvent::Status(self.status()));
    }

    /// Starts a link to every paired machine (unless the owner disconnected).
    pub fn start_all(self: &Arc<Self>) {
        for m in self.store.machines() {
            self.start(&m.id);
        }
    }

    /// Starts the machine's link, if links are on and it has none.
    pub fn start(self: &Arc<Self>, machine_id: &str) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst);
        let (stop, stopped) = watch::channel(false);
        {
            let mut links = locked(&self.links);
            if !links.on || links.running.contains_key(machine_id) {
                return;
            }
            links
                .running
                .insert(machine_id.to_string(), Running { generation, stop });
        }
        self.tell_status();
        let me = self.clone();
        let id = machine_id.to_string();
        self.runtime.spawn(async move {
            me.run(&id, generation, stopped).await;
            me.ended(&id, generation);
        });
    }

    /// Stops the machine's link (it was removed).
    pub fn stop(&self, machine_id: &str) {
        let running = locked(&self.links).running.remove(machine_id);
        if let Some(r) = running {
            let _ = r.stop.send(true);
            self.set_up(machine_id, r.generation, false);
        }
        self.tell_status();
    }

    /// The machine moved: its link starts over at the new address.
    pub fn restart(self: &Arc<Self>, machine_id: &str) {
        self.stop(machine_id);
        self.start(machine_id);
    }

    /// A link that ended by itself (no token, refused): it's no longer running.
    fn ended(&self, machine_id: &str, generation: u64) {
        let ours = {
            let mut links = locked(&self.links);
            let ours = links
                .running
                .get(machine_id)
                .is_some_and(|r| r.generation == generation);
            if ours {
                links.running.remove(machine_id);
            }
            ours
        };
        self.set_up(machine_id, generation, false);
        if ours {
            self.tell_status();
        }
    }

    /// Disconnect: every link closes, and none starts again until `connect`,
    /// across restarts too. The links close whatever happens; the error is
    /// the store's, if it couldn't keep the choice for the next start.
    pub fn disconnect(&self) -> io::Result<()> {
        let all: Vec<_> = {
            let mut links = locked(&self.links);
            links.on = false;
            links.running.drain().collect()
        };
        for (_, r) in all {
            let _ = r.stop.send(true);
        }
        locked(&self.up).clear();
        let kept = self.store.set_links_off(true);
        self.tell_status();
        kept
    }

    /// Connect: every link starts. The error is the store's, as for `disconnect`.
    pub fn connect(self: &Arc<Self>) -> io::Result<()> {
        locked(&self.links).on = true;
        let kept = self.store.set_links_off(false);
        self.start_all();
        self.tell_status();
        kept
    }

    /// The phone's network changed: links waiting retry now (the back-off
    /// starts over), open ones are checked with a ping.
    pub fn network_changed(&self) {
        self.network.send_modify(|n| *n += 1);
    }

    pub fn set_active(&self, chat: Option<(String, String)>) {
        *locked(&self.active) = chat;
    }

    fn set_up(&self, machine_id: &str, generation: u64, up: bool) {
        let changed = {
            let mut set = locked(&self.up);
            if up {
                set.insert(machine_id.to_string(), generation) != Some(generation)
            } else if set.get(machine_id) == Some(&generation) {
                set.remove(machine_id);
                true
            } else {
                false
            }
        };
        if changed {
            self.tell_status();
        }
    }

    fn failed(&self, machine_id: &str, reason: String) {
        let _ = self.events.send(CoreEvent::LinkFailed {
            machine_id: machine_id.to_string(),
            reason,
        });
    }

    /// Waits before the next attempt; false when the link was stopped meanwhile.
    async fn back_off(
        &self,
        backoff: &mut Backoff,
        stop: &mut watch::Receiver<bool>,
        network: &mut watch::Receiver<u64>,
    ) -> bool {
        tokio::select! {
            _ = tokio::time::sleep(backoff.wait()) => true,
            changed = network.changed() => {
                backoff.reset();
                changed.is_ok()
            }
            _ = stop.changed() => false,
        }
    }

    async fn run(&self, id: &str, generation: u64, mut stop: watch::Receiver<bool>) {
        let mut network = self.network.subscribe();
        network.borrow_and_update();
        let mut backoff = Backoff::new(self.timing.backoff_start, self.timing.backoff_max);
        loop {
            if *stop.borrow() {
                return;
            }
            if self.store.machines().into_iter().all(|m| m.id != id) {
                return;
            }
            let (secrets, key) = (self.secrets.clone(), token_key(id));
            let token = match tokio::task::spawn_blocking(move || secrets.get(&key)).await {
                Ok(Ok(Some(token))) => token,
                // No token (forgotten): nothing to connect with.
                Ok(Ok(None)) => return,
                // The keystore couldn't be read now (locked after a reboot, say): later.
                _ => {
                    self.failed(id, "the device token couldn't be read".into());
                    if !self.back_off(&mut backoff, &mut stop, &mut network).await {
                        return;
                    }
                    continue;
                }
            };
            // Read again: it may have moved while the token was read.
            let Some(machine) = self.store.machines().into_iter().find(|m| m.id == id) else {
                return;
            };
            network.borrow_and_update();
            let protocol = format!("{DEVICE_PROTOCOL_PREFIX}{token}");
            let opening = pairing::open_link(
                &machine.address,
                machine.port,
                &protocol,
                Some(&machine.fingerprint),
                self.timing.link_timeout,
                LINK_MAX_FRAME,
            );
            let opened = tokio::select! {
                opened = opening => opened,
                _ = stop.changed() => return,
                // A new network while connecting: start again on it, now.
                changed = network.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    backoff.reset();
                    continue;
                }
            };
            match opened {
                Ok((link, _)) => {
                    self.set_up(id, generation, true);
                    let end = self
                        .listen(link, id, &mut stop, &mut network, &mut backoff)
                        .await;
                    self.set_up(id, generation, false);
                    match end {
                        End::Stop => return,
                        End::Refused => {
                            self.failed(id, REFUSED.into());
                            return;
                        }
                        End::Incompatible(version) => {
                            self.failed(id, format!("the machine speaks protocol {version}"));
                            return;
                        }
                        End::Network => {
                            backoff.reset();
                            continue;
                        }
                        End::Dropped => {}
                    }
                }
                // The machine refused this device: pairing again is the only way back.
                Err(LinkError::Refused(401 | 403)) => {
                    self.failed(id, REFUSED.into());
                    return;
                }
                Err(e) => self.failed(id, describe(&e)),
            }
            if !self.back_off(&mut backoff, &mut stop, &mut network).await {
                return;
            }
        }
    }

    /// Listens on an open link until it ends.
    async fn listen(
        &self,
        mut link: Link,
        machine_id: &str,
        stop: &mut watch::Receiver<bool>,
        network: &mut watch::Receiver<u64>,
        backoff: &mut Backoff,
    ) -> End {
        let hello = json!({ "id": HELLO_ID, "method": "hello",
                            "params": { "protocolVersion": PROTOCOL_VERSION, "client": "threadgarden-phone-core" } });
        // A ping at once too: its pong, with the hello's answer, proves the link.
        for frame in [
            Message::text(hello.to_string()),
            Message::Ping(Vec::new().into()),
        ] {
            if !matches!(
                tokio::time::timeout(SEND_WAIT, link.send(frame)).await,
                Ok(Ok(()))
            ) {
                return End::Dropped;
            }
        }
        let opened_at = Instant::now();
        let (mut said_hello, mut ponged, mut proved) = (false, false, false);
        let mut pings = interval_at(Instant::now() + self.timing.ping, self.timing.ping);
        // A tick late (a busy runtime) isn't caught up in a burst that would outrun the pongs.
        pings.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut answered = true;
        // After a network change: by when a pong must be back, or the link is gone.
        let mut check_by: Option<Instant> = None;
        let end = loop {
            if !proved && ((said_hello && ponged) || opened_at.elapsed() >= self.timing.backoff_max)
            {
                proved = true;
                backoff.reset();
            }
            let checking = async {
                match check_by {
                    Some(by) => tokio::time::sleep_until(by).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                // What has arrived (a pong among it) is read before anything is due.
                biased;
                _ = stop.changed() => break End::Stop,
                frame = link.next() => match frame {
                    Some(Ok(Message::Text(text))) => match self.read(machine_id, text.as_str()) {
                        Read::Hello(Ok(())) => said_hello = true,
                        Read::Hello(Err(version)) => break End::Incompatible(version),
                        Read::Other => {}
                    },
                    Some(Ok(Message::Pong(_))) => {
                        answered = true;
                        ponged = true;
                        check_by = None;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        break match frame.map(|f| u16::from(f.code)) {
                            Some(4401 | 4403) => End::Refused,
                            _ => End::Dropped,
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break End::Dropped,
                },
                _ = checking => {
                    self.failed(machine_id, "no answer after the network changed".into());
                    break End::Network;
                }
                _ = pings.tick() => {
                    if !answered {
                        self.failed(machine_id, "no pong: the link is dead".into());
                        break End::Dropped;
                    }
                    answered = false;
                    // A ping goes out at once on a working link. One that can't (the
                    // machine stopped reading) means the link is dead.
                    let ping = link.send(Message::Ping(Vec::new().into()));
                    if !matches!(tokio::time::timeout(SEND_WAIT, ping).await, Ok(Ok(()))) {
                        break End::Dropped;
                    }
                }
                changed = network.changed() => {
                    if changed.is_err() {
                        break End::Stop;
                    }
                    // Still there on the new network? A ping says; a working link stays.
                    if check_by.is_none() {
                        check_by = Some(Instant::now() + self.timing.network_check);
                        let ping = link.send(Message::Ping(Vec::new().into()));
                        if !matches!(tokio::time::timeout(SEND_WAIT, ping).await, Ok(Ok(()))) {
                            break End::Network;
                        }
                    }
                }
            }
        };
        let _ = tokio::time::timeout(SEND_WAIT, link.close(None)).await;
        end
    }

    /// Reads a frame: the `hello` answer, or an event to alert.
    fn read(&self, machine_id: &str, frame: &str) -> Read {
        let parsed = match event_name(frame) {
            Some("needsYou" | "chatFinished") => serde_json::from_str::<Value>(frame).ok(),
            // Streamed output and every other event: dropped, unread.
            Some(_) => return Read::Other,
            // Not written as the service writes events: an answer, or keys another way round.
            None => serde_json::from_str::<Value>(frame).ok(),
        };
        let Some(v) = parsed else { return Read::Other };
        if v["id"] == json!(HELLO_ID) {
            let version = &v["result"]["protocolVersion"];
            return Read::Hello(if accepts_remote_protocol(version) {
                Ok(())
            } else {
                Err(version.clone())
            });
        }
        let kind = match v["event"].as_str() {
            Some("needsYou") => AlertKind::NeedsYou,
            Some("chatFinished") => AlertKind::Finished,
            _ => return Read::Other,
        };
        let data = &v["data"];
        if let Some(session_id) = data["sessionId"].as_str() {
            let title = data["title"].as_str().unwrap_or("A chat");
            self.alert(machine_id, kind, session_id, title);
        }
        Read::Other
    }

    /// Posts an alert, if the settings and the screen allow it.
    fn alert(&self, machine_id: &str, kind: AlertKind, session_id: &str, chat_title: &str) {
        let s = settings::read(&self.store.settings());
        let setting = match kind {
            AlertKind::NeedsYou => "notifications",
            AlertKind::Finished => "notifyOnFinish",
        };
        if s[setting] != json!(true) {
            return;
        }
        let on_screen = locked(&self.active)
            .as_ref()
            .is_some_and(|(m, c)| m == machine_id && c == session_id);
        if on_screen {
            return;
        }
        // Named as it's called now (it may have been renamed since the link opened).
        let Some(machine) = self
            .store
            .machines()
            .into_iter()
            .find(|m| m.id == machine_id)
        else {
            return;
        };
        let _ = self.events.send(CoreEvent::Alert {
            machine_id: machine.id,
            machine_name: machine.name,
            session_id: session_id.to_string(),
            chat_title: chat_title.to_string(),
            kind,
        });
    }

    /// `alerts.setActive {machineId, sessionId}`: the chat on screen (null, or a null in it: none).
    pub fn register(self: &Arc<Self>, router: &mut Router) {
        let me = self.clone();
        router.answer("alerts.setActive", move |p| {
            let field = |name: &str| match p.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(MethodError::invalid(format!(
                    "{name}: expected a string or null"
                ))),
            };
            let chat = match &p {
                Value::Null => None,
                Value::Object(_) => match (field("machineId")?, field("sessionId")?) {
                    (Some(m), Some(s)) => Some((m, s)),
                    _ => None,
                },
                _ => return Err(MethodError::invalid("expected an object or null")),
            };
            me.set_active(chat);
            Ok(json!({}))
        });
    }
}

/// What a frame on an alert link was.
enum Read {
    /// The `hello` answer: fine, or the protocol version it says (out of range).
    Hello(Result<(), Value>),
    Other,
}

fn describe(e: &LinkError) -> String {
    match e {
        LinkError::Pin => "the machine presented another certificate".into(),
        LinkError::Refused(status) => format!("HTTP {status}"),
        LinkError::Unreachable(why) => why.clone(),
    }
}

/// The event name of a frame the service wrote (`{"event":"<name>",…}`), read
/// without parsing the rest: most frames are streamed output, dropped unread.
fn event_name(frame: &str) -> Option<&str> {
    let rest = frame.strip_prefix(r#"{"event":""#)?;
    rest.split('"').next()
}

/// Alerts for a unit test, on a runtime of their own that's never stopped.
#[cfg(test)]
pub fn for_tests(dir: &std::path::Path) -> Arc<Alerts> {
    let runtime: &'static tokio::runtime::Runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap(),
    ));
    let store = Arc::new(Store::open(dir).unwrap());
    let secrets: Arc<dyn Secrets> = Arc::new(crate::secrets::MemorySecrets::default());
    Alerts::new(
        store,
        secrets,
        Timing::default(),
        broadcast::channel(16).0,
        runtime.handle().clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_back_off_doubles_to_its_cap_and_starts_over() {
        let mut b = Backoff::new(Duration::from_secs(2), Duration::from_secs(60));
        let waits: Vec<u64> = (0..7).map(|_| b.wait().as_secs()).collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60]);
        b.reset();
        assert_eq!(b.wait().as_secs(), 2);
    }

    #[test]
    fn streamed_output_is_dropped_by_its_name() {
        assert_eq!(
            event_name(r#"{"event":"chat.items","data":{ not json"#),
            Some("chat.items")
        );
        assert_eq!(
            event_name(r#"{"event":"needsYou","data":{}}"#),
            Some("needsYou")
        );
        assert_eq!(event_name(r#"{"id":1,"result":{}}"#), None);
    }

    #[test]
    fn every_live_event_alerts_and_streamed_output_doesnt() {
        let dir = tempfile::tempdir().unwrap();
        let alerts = for_tests(dir.path());
        let mut events = alerts.events.subscribe();
        alerts
            .store
            .add_machine(crate::store::StoredMachine {
                id: "m1".into(),
                name: "Desk".into(),
                address: "192.0.2.10".into(),
                port: 47380,
                fingerprint: "AB:CD".into(),
                cert_der: String::new(),
                device_id: "d1".into(),
                added_at: 1,
            })
            .unwrap();
        let need = r#"{"event":"needsYou","data":{"sessionId":"s1","title":"T"}}"#;
        assert!(matches!(alerts.read("m1", need), Read::Other));
        assert!(matches!(alerts.read("m1", need), Read::Other));
        assert!(matches!(
            alerts.read("m1", r#"{"event":"chat.items","data":{ not json"#),
            Read::Other
        ));
        // Keys the other way round are still read.
        alerts.read(
            "m1",
            r#"{"data":{"sessionId":"s2","title":"U"},"event":"chatFinished"}"#,
        );
        let mut got = Vec::new();
        while let Ok(CoreEvent::Alert { session_id, .. }) = events.try_recv() {
            got.push(session_id);
        }
        assert_eq!(got, ["s1", "s1", "s2"]);
    }

    #[test]
    fn the_hello_answer_is_checked_for_the_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let alerts = for_tests(dir.path());
        assert!(matches!(
            alerts.read("m1", r#"{"id":1,"result":{"protocolVersion":11}}"#),
            Read::Hello(Ok(()))
        ));
        assert!(matches!(
            alerts.read("m1", r#"{"id":1,"result":{"protocolVersion":9}}"#),
            Read::Hello(Err(_))
        ));
        assert!(matches!(
            alerts.read("m1", r#"{"id":1,"error":{"code":"X"}}"#),
            Read::Hello(Err(_))
        ));
    }
}
