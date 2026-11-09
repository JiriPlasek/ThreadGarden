//! Alert links: the core's own link to each paired machine with a token,
//! separate from the screens' relays, so the phone knows a chat needs you (or
//! finished) with no screen open. Machines send `needsYou` and `chatFinished`
//! to every device already; these links listen for them and drop everything
//! else (the chats' streamed output) unread and unstored.
//!
//! As the desktop's `notifications.ts`: `needsYou` alerts when the
//! `notifications` setting is on, `chatFinished` when `notifyOnFinish` is;
//! the chat on screen (`alerts.setActive`) doesn't alert. A link never sends
//! `ui.visibility`, which is global to the machine.
//!
//! After every (re)connect a link catches up from `sessions.list` (Needs you):
//! the chats already waiting are noted, not alerted, so what happened while
//! the phone was away shows as unread in the screens rather than as a burst.
//! A chat alerts for a need once, until it's seen not waiting again.
//!
//! An unreachable machine is retried with back-off, 2 s doubling to 60 s; a
//! network change retries at once and starts the back-off over. Links ping
//! every 15 s, and one whose pong isn't back by the next ping is dead.
//! Disconnect closes every link until Connect, and that's kept across restarts.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use crate::store::{Store, StoredMachine};
use crate::{AlertKind, CoreEvent, LinkStatus, PROTOCOL_VERSION, Timing, settings};

/// Largest frame taken from a machine (its streamed output included): `ws`'s default.
const LINK_MAX_FRAME: usize = 100 * 1024 * 1024;
/// How many waiting chats a catch-up reads, as the desktop's.
const CATCH_UP_LIMIT: u64 = 200;
const HELLO_ID: u64 = 1;
const CATCH_UP_ID: u64 = 2;

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

    /// Back to the shortest wait (the link worked, or the network changed).
    pub fn reset(&mut self) {
        self.next = self.start;
    }
}

/// How a link that was open ended.
enum End {
    /// Stopped here: Disconnect, the machine removed or moved.
    Stop,
    /// The network changed: reconnect at once.
    Network,
    /// The machine refused this device (revoked): no point retrying.
    Refused,
    /// Closed, dropped or dead: retry with back-off.
    Dropped,
}

/// One machine's link: how to stop it, and which start it was.
struct Running {
    generation: u64,
    stop: watch::Sender<bool>,
}

pub struct Alerts {
    store: Arc<Store>,
    secrets: Arc<dyn Secrets>,
    timing: Timing,
    events: broadcast::Sender<CoreEvent>,
    runtime: tokio::runtime::Handle,
    /// The chat on screen, `(machine id, session id)`: it doesn't alert.
    active: Mutex<Option<(String, String)>>,
    links: Mutex<HashMap<String, Running>>,
    /// The machines whose link is open now.
    up: Mutex<HashSet<String>>,
    /// Bumped on every network change.
    network: watch::Sender<u64>,
    on: AtomicBool,
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
            links: Mutex::new(HashMap::new()),
            up: Mutex::new(HashSet::new()),
            network: watch::channel(0).0,
            on: AtomicBool::new(on),
            generation: AtomicU64::new(0),
        })
    }

    pub fn status(&self) -> LinkStatus {
        LinkStatus {
            on: self.on.load(Ordering::SeqCst),
            machines: locked(&self.links).len(),
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
        if !self.on.load(Ordering::SeqCst) {
            return;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst);
        let (stop, stopped) = watch::channel(false);
        {
            let mut links = locked(&self.links);
            if links.contains_key(machine_id) {
                return;
            }
            links.insert(machine_id.to_string(), Running { generation, stop });
        }
        self.tell_status();
        let me = self.clone();
        let id = machine_id.to_string();
        self.runtime.spawn(async move {
            me.run(&id, stopped).await;
            me.ended(&id, generation);
        });
    }

    /// Stops the machine's link (it was removed).
    pub fn stop(&self, machine_id: &str) {
        let running = locked(&self.links).remove(machine_id);
        if let Some(r) = running {
            let _ = r.stop.send(true);
        }
        locked(&self.up).remove(machine_id);
        self.tell_status();
    }

    /// The machine moved: its link starts over at the new address.
    pub fn restart(self: &Arc<Self>, machine_id: &str) {
        self.stop(machine_id);
        self.start(machine_id);
    }

    /// A link that ended by itself (no token, refused): it's no longer running.
    fn ended(&self, machine_id: &str, generation: u64) {
        let mut links = locked(&self.links);
        if links
            .get(machine_id)
            .is_some_and(|r| r.generation == generation)
        {
            links.remove(machine_id);
            drop(links);
            locked(&self.up).remove(machine_id);
            self.tell_status();
        }
    }

    /// Disconnect: every link closes, and none starts again until `connect`,
    /// across restarts too.
    pub fn disconnect(&self) {
        self.on.store(false, Ordering::SeqCst);
        let _ = self.store.set_links_off(true);
        let all: Vec<_> = locked(&self.links).drain().collect();
        for (_, r) in all {
            let _ = r.stop.send(true);
        }
        locked(&self.up).clear();
        self.tell_status();
    }

    pub fn connect(self: &Arc<Self>) {
        let _ = self.store.set_links_off(false);
        self.on.store(true, Ordering::SeqCst);
        self.start_all();
        self.tell_status();
    }

    /// The phone's network changed: every link retries now, the back-off starts over.
    pub fn network_changed(&self) {
        self.network.send_modify(|n| *n += 1);
    }

    pub fn set_active(&self, chat: Option<(String, String)>) {
        *locked(&self.active) = chat;
    }

    fn set_up(&self, machine_id: &str, up: bool) {
        let changed = {
            let mut set = locked(&self.up);
            if up {
                set.insert(machine_id.to_string())
            } else {
                set.remove(machine_id)
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

    async fn run(&self, id: &str, mut stop: watch::Receiver<bool>) {
        let mut network = self.network.subscribe();
        let mut backoff = Backoff::new(self.timing.backoff_start, self.timing.backoff_max);
        loop {
            if *stop.borrow() {
                return;
            }
            let Some(machine) = self.store.machines().into_iter().find(|m| m.id == id) else {
                return;
            };
            let (secrets, key) = (self.secrets.clone(), token_key(id));
            let token = tokio::task::spawn_blocking(move || secrets.get(&key))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            let Some(token) = token else { return };
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
            };
            match opened {
                Ok((link, _)) => {
                    backoff.reset();
                    self.set_up(id, true);
                    let end = self.listen(link, &machine, &mut stop, &mut network).await;
                    self.set_up(id, false);
                    match end {
                        End::Stop | End::Refused => return,
                        End::Network => continue,
                        End::Dropped => {}
                    }
                }
                // The machine refused this device: pairing again is the only way back.
                Err(LinkError::Refused(401 | 403)) => return,
                Err(e) => self.failed(id, describe(&e)),
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff.wait()) => {}
                changed = network.changed() => {
                    if changed.is_err() {
                        return;
                    }
                    backoff.reset();
                }
                _ = stop.changed() => return,
            }
        }
    }

    /// Listens on an open link until it ends.
    async fn listen(
        &self,
        mut link: Link,
        machine: &StoredMachine,
        stop: &mut watch::Receiver<bool>,
        network: &mut watch::Receiver<u64>,
    ) -> End {
        let hello = json!({ "id": HELLO_ID, "method": "hello",
                            "params": { "protocolVersion": PROTOCOL_VERSION, "client": "threadgarden-phone-core" } });
        let catch_up = json!({ "id": CATCH_UP_ID, "method": "sessions.list",
                               "params": { "place": { "kind": "needsYou" }, "limit": CATCH_UP_LIMIT } });
        for frame in [hello, catch_up] {
            let sent = link.send(Message::text(frame.to_string()));
            if !matches!(
                tokio::time::timeout(self.timing.link_timeout, sent).await,
                Ok(Ok(()))
            ) {
                return End::Dropped;
            }
        }
        let mut chats = Chats::default();
        let mut pings = interval_at(Instant::now() + self.timing.ping, self.timing.ping);
        // A tick late (a busy runtime) isn't caught up in a burst that would outrun the pongs.
        pings.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut answered = true;
        let end = loop {
            tokio::select! {
                // What has arrived (a pong among it) is read before a ping is due.
                biased;
                frame = link.next() => match frame {
                    Some(Ok(Message::Text(text))) => {
                        for (kind, session_id, title) in chats.read(text.as_str()) {
                            self.alert(machine, kind, session_id, title);
                        }
                    }
                    Some(Ok(Message::Pong(_))) => answered = true,
                    Some(Ok(Message::Close(frame))) => {
                        break match frame.map(|f| u16::from(f.code)) {
                            Some(4401 | 4403) => End::Refused,
                            _ => End::Dropped,
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break End::Dropped,
                },
                _ = pings.tick() => {
                    if !answered {
                        self.failed(&machine.id, "no pong: the link is dead".into());
                        break End::Dropped;
                    }
                    answered = false;
                    // A machine that stopped reading doesn't hold this link up past a ping.
                    let ping = link.send(Message::Ping(Vec::new().into()));
                    if !matches!(tokio::time::timeout(self.timing.ping, ping).await, Ok(Ok(()))) {
                        break End::Dropped;
                    }
                }
                _ = network.changed() => break End::Network,
                _ = stop.changed() => break End::Stop,
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), link.close(None)).await;
        end
    }

    /// Posts an alert, if the settings and the screen allow it.
    fn alert(
        &self,
        machine: &StoredMachine,
        kind: AlertKind,
        session_id: String,
        chat_title: String,
    ) {
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
            .is_some_and(|(m, c)| *m == machine.id && *c == session_id);
        if on_screen {
            return;
        }
        let _ = self.events.send(CoreEvent::Alert {
            machine_id: machine.id.clone(),
            machine_name: machine.name.clone(),
            session_id,
            chat_title,
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

fn describe(e: &LinkError) -> String {
    match e {
        LinkError::Pin => "the machine presented another certificate".into(),
        LinkError::Refused(status) => format!("HTTP {status}"),
        LinkError::Unreachable(why) => why.clone(),
    }
}

/// What one link knows of the machine's chats: those waiting on you, and
/// the needs that came before the catch-up answered. Nothing else is kept.
#[derive(Default)]
struct Chats {
    waiting: HashSet<String>,
    caught_up: bool,
    /// Events that came before the catch-up: decided once it's in.
    early: Vec<(AlertKind, String, String)>,
}

/// The event name of a frame the service wrote (`{"event":"<name>",…}`), read
/// without parsing the rest: most frames are streamed output, dropped unread.
fn event_name(frame: &str) -> Option<&str> {
    let rest = frame.strip_prefix(r#"{"event":""#)?;
    rest.split('"').next()
}

impl Chats {
    /// Reads a frame: the alerts it makes, if any.
    fn read(&mut self, frame: &str) -> Vec<(AlertKind, String, String)> {
        match event_name(frame) {
            Some(name @ ("needsYou" | "chatFinished" | "chat.status")) => {
                let Ok(v) = serde_json::from_str::<Value>(frame) else {
                    return Vec::new();
                };
                self.event(name, &v["data"])
            }
            // Streamed output and every other event: dropped, unread.
            Some(_) => Vec::new(),
            // Not written as the service writes events: an answer (only the
            // catch-up's matters), or an event with its keys another way round.
            None => {
                let Ok(v) = serde_json::from_str::<Value>(frame) else {
                    return Vec::new();
                };
                if v["id"] == json!(CATCH_UP_ID) {
                    return self.caught_up(&v["result"]["items"]);
                }
                match v["event"].as_str() {
                    Some(name @ ("needsYou" | "chatFinished" | "chat.status")) => {
                        self.event(name, &v["data"])
                    }
                    _ => Vec::new(),
                }
            }
        }
    }

    fn event(&mut self, name: &str, data: &Value) -> Vec<(AlertKind, String, String)> {
        let Some(session) = data["sessionId"].as_str().map(str::to_string) else {
            return Vec::new();
        };
        let kind = match name {
            "needsYou" => AlertKind::NeedsYou,
            "chatFinished" => AlertKind::Finished,
            _ => {
                // `chat.status`: a chat no longer waiting on you may alert again later.
                if data["status"].as_str() != Some("needsYou") {
                    self.waiting.remove(&session);
                }
                return Vec::new();
            }
        };
        let title = data["title"].as_str().unwrap_or("A chat").to_string();
        if !self.caught_up {
            self.early.push((kind, session, title));
            return Vec::new();
        }
        self.decide(kind, session, title).into_iter().collect()
    }

    fn decide(
        &mut self,
        kind: AlertKind,
        session: String,
        title: String,
    ) -> Option<(AlertKind, String, String)> {
        match kind {
            // Once per need: not again while the chat is still waiting.
            AlertKind::NeedsYou => self
                .waiting
                .insert(session.clone())
                .then_some((kind, session, title)),
            AlertKind::Finished => {
                self.waiting.remove(&session);
                Some((kind, session, title))
            }
        }
    }

    /// The catch-up's answer: the chats waiting now are noted, never alerted.
    fn caught_up(&mut self, items: &Value) -> Vec<(AlertKind, String, String)> {
        for item in items.as_array().into_iter().flatten() {
            if item["status"] == "needsYou"
                && let Some(id) = item["sessionId"].as_str()
            {
                self.waiting.insert(id.to_string());
            }
        }
        self.caught_up = true;
        std::mem::take(&mut self.early)
            .into_iter()
            .filter_map(|(k, s, t)| self.decide(k, s, t))
            .collect()
    }
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
        broadcast::channel(1).0,
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
        let mut c = Chats {
            caught_up: true,
            ..Chats::default()
        };
        // Not even valid JSON past the name: never parsed.
        assert!(
            c.read(r#"{"event":"chat.items","data":{ not json"#)
                .is_empty()
        );
        assert_eq!(
            event_name(r#"{"event":"needsYou","data":{}}"#),
            Some("needsYou")
        );
        assert_eq!(event_name(r#"{"id":2,"result":{}}"#), None);
    }

    #[test]
    fn a_need_alerts_once_until_the_chat_moves_on() {
        let mut c = Chats::default();
        let need = r#"{"event":"needsYou","data":{"sessionId":"s1","title":"T"}}"#;
        // Before the catch-up: held.
        assert!(c.read(need).is_empty());
        let out = c.caught_up(&json!([{ "sessionId": "s2", "status": "needsYou" }]));
        assert_eq!(out.len(), 1);
        assert!(c.read(need).is_empty());
        assert!(
            c.read(r#"{"event":"needsYou","data":{"sessionId":"s2","title":"T"}}"#)
                .is_empty()
        );
        c.read(r#"{"event":"chat.status","data":{"sessionId":"s1","status":"working"}}"#);
        assert_eq!(c.read(need).len(), 1);
        // A frame written with its keys another way round is still read.
        assert_eq!(
            c.read(r#"{"data":{"sessionId":"s3","title":"T"},"event":"needsYou"}"#)
                .len(),
            1
        );
    }
}
