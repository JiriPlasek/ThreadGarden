//! Alert links: the core's own link to each paired machine, separate from
//! the screens' relays, so a chat that needs you (or finished) alerts with no
//! screen open. As the desktop's `notifications.ts`: every live event, the
//! same settings, the chat on screen left out, and a reconnect never a burst
//! of old alerts (nothing past is replayed).

#[path = "support/machine.rs"]
mod machine;
mod support;

use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

use machine::{Behaviour, FakeMachine};
use serde_json::{Value, json};
use support::{block_on, call, config, open};
use threadgarden_core::secrets::{MemorySecrets, Secrets, SecretsError};
use threadgarden_core::{AlertKind, Core, CoreConfig, CoreEvent, CoreHandle, Timing};
use tokio::sync::broadcast;

const BACKOFF_START: Duration = Duration::from_millis(60);
const BACKOFF_MAX: Duration = Duration::from_millis(480);

fn timing() -> Timing {
    Timing {
        link_timeout: Duration::from_millis(600),
        ping: Duration::from_millis(200),
        backoff_start: BACKOFF_START,
        backoff_max: BACKOFF_MAX,
        network_check: Duration::from_millis(300),
        ..Timing::default()
    }
}

fn core(dir: &std::path::Path) -> CoreHandle {
    core_with(dir, Arc::new(MemorySecrets::default()), timing())
}

/// A core with `secrets` (kept across a restart, as the Keystore file is).
fn core_with(dir: &std::path::Path, secrets: Arc<dyn Secrets>, timing: Timing) -> CoreHandle {
    let config = CoreConfig {
        secrets,
        ..config(dir)
    };
    Core::spawn_with_timing(config, timing).unwrap()
}

async fn pair(core: &CoreHandle, machine: &FakeMachine) {
    let mut ws = open(core).await;
    let params = json!({ "address": "127.0.0.1", "port": machine.port, "code": "ABCD-EFGH-JKMN", "deviceName": "Phone" });
    let answer = call(&mut ws, 1, "machines.pair", params).await;
    assert!(answer.get("result").is_some(), "{answer}");
}

/// Waits (up to 5 s) for `done`.
async fn until(what: &str, done: impl Fn() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(started.elapsed() < Duration::from_secs(5), "never: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The alert link is up and said hello.
async fn linked(core: &CoreHandle, machine: &FakeMachine) {
    until("the alert link said hello", || {
        machine.methods().contains(&"hello".to_string())
    })
    .await;
    until("the link counts as connected", || {
        core.link_status().connected >= 1
    })
    .await;
}

/// The alerts that arrive within `wait`, other events left out.
async fn alerts_within(
    events: &mut broadcast::Receiver<CoreEvent>,
    wait: Duration,
) -> Vec<(String, String, AlertKind)> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Ok(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        if let CoreEvent::Alert {
            session_id,
            chat_title,
            kind,
            ..
        } = event
        {
            out.push((session_id, chat_title, kind));
        }
    }
    out
}

/// The link failures reported within `wait`.
async fn failures_within(
    events: &mut broadcast::Receiver<CoreEvent>,
    wait: Duration,
) -> Vec<String> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    while let Ok(Ok(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        if let CoreEvent::LinkFailed { reason, .. } = event {
            out.push(reason);
        }
    }
    out
}

fn needs_you(session: &str, title: &str) -> Value {
    json!({ "sessionId": session, "title": title, "projectName": "garden", "what": "needs permission" })
}

fn finished(session: &str, title: &str) -> Value {
    json!({ "sessionId": session, "title": title, "projectName": "garden" })
}

const QUIET: Duration = Duration::from_millis(300);

/// The gaps between `times`.
fn gaps(times: &[Instant]) -> Vec<Duration> {
    times.windows(2).map(|w| w[1] - w[0]).collect()
}

/// The gaps grow from `BACKOFF_START`, doubling, to `BACKOFF_MAX` (some slack for each attempt).
fn assert_backs_off(gaps: &[Duration]) {
    for (i, gap) in gaps.iter().enumerate() {
        let want = (BACKOFF_START * 2u32.pow(i as u32)).min(BACKOFF_MAX);
        assert!(
            *gap >= want.mul_f32(0.8) && *gap <= want + Duration::from_millis(200),
            "gap {i}: {gap:?}, wanted {want:?} ({gaps:?})"
        );
    }
}

#[test]
fn an_event_alerts_once() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        // A screen relayed to the same machine doesn't alert a second time.
        let protocols = [format!("threadgarden.{}", core.token())];
        let _screen = support::open_with(core.port(), "/relay?machine=machine-desk", &protocols)
            .await
            .unwrap();
        until("the relay is up", || desk.devices_open() == 2).await;

        desk.emit("needsYou", needs_you("s1", "Fix the build"));
        let first = loop {
            match tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap()
            {
                CoreEvent::Alert {
                    machine_id,
                    machine_name,
                    session_id,
                    chat_title,
                    kind,
                } => {
                    break (machine_id, machine_name, session_id, chat_title, kind);
                }
                _ => continue,
            }
        };
        assert_eq!(
            first,
            (
                "machine-desk".into(),
                "Desk".into(),
                "s1".into(),
                "Fix the build".into(),
                AlertKind::NeedsYou
            )
        );
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [],
            "one event, one alert"
        );
        // Every live event alerts, as on the desktop (Rulings R12, R13): the same chat again too.
        desk.emit("needsYou", needs_you("s1", "Fix the build"));
        desk.emit("chatFinished", finished("s2", "Tidy the docs"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [
                ("s1".into(), "Fix the build".into(), AlertKind::NeedsYou),
                ("s2".into(), "Tidy the docs".into(), AlertKind::Finished),
            ]
        );
    });
    core.stop();
}

#[test]
fn an_alert_names_the_machine_as_it_is_called_now() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            1,
            "machines.update",
            json!({ "machineId": "machine-desk", "name": "Study" }),
        )
        .await;
        desk.emit("needsYou", needs_you("s1", "A"));
        let name = loop {
            if let CoreEvent::Alert { machine_name, .. } =
                tokio::time::timeout(Duration::from_secs(5), events.recv())
                    .await
                    .unwrap()
                    .unwrap()
            {
                break machine_name;
            }
        };
        assert_eq!(name, "Study");
    });
    core.stop();
}

#[test]
fn alerts_follow_the_notification_settings() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        let mut ws = open(&core).await;
        // As the desktop: `notifyOnFinish` off silences finished turns only.
        call(
            &mut ws,
            1,
            "settings.set",
            json!({ "notifyOnFinish": false }),
        )
        .await;
        desk.emit("chatFinished", finished("s1", "A"));
        desk.emit("needsYou", needs_you("s2", "B"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [("s2".into(), "B".into(), AlertKind::NeedsYou)]
        );
        // `notifications` off silences Needs you.
        call(
            &mut ws,
            2,
            "settings.set",
            json!({ "notifications": false, "notifyOnFinish": true }),
        )
        .await;
        desk.emit("needsYou", needs_you("s3", "C"));
        desk.emit("chatFinished", finished("s4", "D"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [("s4".into(), "D".into(), AlertKind::Finished)]
        );
    });
    core.stop();
}

#[test]
fn the_chat_on_screen_doesnt_alert() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        let mut ws = open(&core).await;
        let set = call(
            &mut ws,
            1,
            "alerts.setActive",
            json!({ "machineId": "machine-desk", "sessionId": "s1" }),
        )
        .await;
        assert_eq!(set["result"], json!({}));
        desk.emit("needsYou", needs_you("s1", "On screen"));
        desk.emit("chatFinished", finished("s1", "On screen"));
        desk.emit("needsYou", needs_you("s2", "Elsewhere"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [("s2".into(), "Elsewhere".into(), AlertKind::NeedsYou)]
        );
        // Nothing on screen (the app went to the background): it alerts again.
        for (i, nothing) in [json!(null), json!({ "machineId": null, "sessionId": null })]
            .into_iter()
            .enumerate()
        {
            call(&mut ws, 2 + i as u64, "alerts.setActive", nothing).await;
            desk.emit("chatFinished", finished("s1", "On screen"));
            assert_eq!(
                alerts_within(&mut events, QUIET).await,
                [("s1".into(), "On screen".into(), AlertKind::Finished)]
            );
        }
    });
    core.stop();
}

#[test]
fn a_reconnect_catches_up_without_alerting_past_chats() {
    let dir = tempfile::tempdir().unwrap();
    // Pings far apart: the restart below is the only reconnect. With the usual
    // 200 ms of these tests, a pong late under load drops the link once more,
    // and a third hello would skip past the count waited for.
    let slow_pings = Timing {
        ping: Duration::from_secs(30),
        ..timing()
    };
    let core = core_with(dir.path(), Arc::new(MemorySecrets::default()), slow_pings);
    let desk = FakeMachine::start(Behaviour::default());
    // Waiting already when the link comes up: they show as unread in the screens.
    desk.set_sessions(vec![json!({ "sessionId": "s1", "status": "needsYou" })]);
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        assert_eq!(alerts_within(&mut events, QUIET).await, []);
        // The machine restarts: the link drops and comes back by itself (one more hello).
        let hellos = || desk.methods().iter().filter(|m| *m == "hello").count();
        let before = hellos();
        desk.kick();
        until("it said hello again", || hellos() > before).await;
        until("the link is back", || desk.devices_open() == 1).await;
        // Nothing from before is replayed or alerted.
        assert_eq!(alerts_within(&mut events, QUIET).await, []);
        // What happens from now on alerts, the chat that was waiting included.
        desk.emit("needsYou", needs_you("s1", "Still waiting"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [("s1".into(), "Still waiting".into(), AlertKind::NeedsYou)]
        );
    });
    // No catch-up: after pairing, nothing but hello was asked (once per link).
    let methods = desk.methods();
    assert_eq!(methods[..2], ["pair.proof", "pair.claim"]);
    assert!(
        methods.len() >= 4 && methods[2..].iter().all(|m| m == "hello"),
        "{methods:?}"
    );
    core.stop();
}

#[test]
fn streamed_output_is_dropped_without_being_stored() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        let before = std::fs::read(dir.path().join("core.json")).unwrap();
        let text = "a long line of streamed output ".repeat(2000);
        for seq in 0..50 {
            desk.emit("chat.items", json!({ "sessionId": "s1", "seq": seq, "items": [{ "kind": "assistant", "text": text }] }));
        }
        desk.emit(
            "chat.tasks",
            json!({ "sessionId": "s1", "seq": 51, "tasks": [] }),
        );
        desk.emit(
            "chat.status",
            json!({ "sessionId": "s1", "seq": 52, "status": "working" }),
        );
        desk.emit("sessions.changed", json!({ "sessionIds": ["s1"] }));
        desk.emit("needsYou", needs_you("s1", "After the stream"));
        // Nothing but the alert comes of it,
        let mut seen = Vec::new();
        while let Ok(Ok(e)) = tokio::time::timeout(QUIET, events.recv()).await {
            seen.push(e);
        }
        let alerts: Vec<_> = seen
            .iter()
            .filter(|e| matches!(e, CoreEvent::Alert { .. }))
            .collect();
        assert_eq!(alerts.len(), 1, "{seen:?}");
        // and nothing was written.
        assert_eq!(std::fs::read(dir.path().join("core.json")).unwrap(), before);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["core.json"]);
    });
    core.stop();
}

#[test]
fn back_off_grows_to_60_s_and_a_network_change_resets_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    // Takes each connection and drops it at once: every attempt fails fast.
    let dead = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    let attempts = Arc::new(std::sync::Mutex::new(Vec::<Instant>::new()));
    {
        let attempts = attempts.clone();
        std::thread::spawn(move || {
            for stream in dead.incoming() {
                attempts.lock().unwrap().push(Instant::now());
                drop(stream);
            }
        });
    }
    block_on(async {
        pair(&core, &desk).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            2,
            "machines.update",
            json!({ "machineId": "machine-desk", "port": dead_port }),
        )
        .await;
        until("seven attempts", || attempts.lock().unwrap().len() >= 7).await;
        let times = attempts.lock().unwrap().clone();
        assert_backs_off(&gaps(&times)[..5]);
        // A network change: tried again at once, and the back-off starts over.
        let before = attempts.lock().unwrap().len();
        let changed = Instant::now();
        core.network_changed();
        until("an attempt at once", || {
            attempts.lock().unwrap().len() > before
        })
        .await;
        let at_once = attempts.lock().unwrap()[before] - changed;
        assert!(at_once < Duration::from_millis(100), "{at_once:?}");
        until("the next one", || {
            attempts.lock().unwrap().len() > before + 1
        })
        .await;
        let gap = {
            let times = attempts.lock().unwrap();
            times[before + 1] - times[before]
        };
        assert!(gap < BACKOFF_START * 2, "{gap:?}");
    });
    core.stop();
}

#[test]
fn a_machine_that_accepts_and_closes_at_once_is_backed_off_too() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    // The link opens, then the machine closes it straight away: never proved.
    let flaky = FakeMachine::start(Behaviour {
        device_close: Some(1000),
        ..Behaviour::default()
    });
    block_on(async {
        pair(&core, &flaky).await;
        until("seven links", || flaky.device_times().len() >= 7).await;
    });
    assert_backs_off(&gaps(&flaky.device_times())[..5]);
    core.stop();
}

#[test]
fn the_back_off_is_the_specs_by_default() {
    let t = Timing::default();
    assert_eq!(
        (t.backoff_start, t.backoff_max, t.ping),
        (
            Duration::from_secs(2),
            Duration::from_secs(60),
            Duration::from_secs(15)
        )
    );
    assert!(t.network_check >= Duration::from_secs(3) && t.network_check <= Duration::from_secs(5));
}

#[test]
fn a_network_change_keeps_a_link_that_still_answers() {
    let dir = tempfile::tempdir().unwrap();
    // Pings far apart: only the network change's check runs.
    let slow_pings = Timing {
        ping: Duration::from_secs(30),
        ..timing()
    };
    let core = core_with(dir.path(), Arc::new(MemorySecrets::default()), slow_pings);
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        let links = desk.device_times().len();
        core.network_changed();
        tokio::time::sleep(timing().network_check * 3).await;
        assert_eq!(
            desk.device_times().len(),
            links,
            "a working link was torn down"
        );
        assert_eq!(desk.devices_open(), 1);
        desk.emit("needsYou", needs_you("s1", "Still here"));
        assert_eq!(alerts_within(&mut events, QUIET).await.len(), 1);
    });
    core.stop();
}

#[test]
fn a_network_change_drops_a_link_that_no_longer_answers() {
    let dir = tempfile::tempdir().unwrap();
    let slow_pings = Timing {
        ping: Duration::from_secs(30),
        ..timing()
    };
    let core = core_with(dir.path(), Arc::new(MemorySecrets::default()), slow_pings);
    // Reads nothing once open: no pong ever comes (the Wi-Fi went, silently).
    let gone = FakeMachine::start(Behaviour {
        stall: true,
        ..Behaviour::default()
    });
    block_on(async {
        pair(&core, &gone).await;
        until("the link is open", || gone.device_times().len() == 1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let changed = Instant::now();
        core.network_changed();
        until("a new link", || gone.device_times().len() == 2).await;
        let took = gone.device_times()[1] - changed;
        // Dropped once the check's deadline passed, and reconnected at once (not after a ping).
        assert!(took >= timing().network_check.mul_f32(0.8), "{took:?}");
        assert!(took < timing().network_check * 3, "{took:?}");
    });
    core.stop();
}

#[test]
fn a_link_never_sends_ui_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        linked(&core, &desk).await;
        // The screens tell the core when they're in front; it isn't passed on.
        let mut ws = open(&core).await;
        call(&mut ws, 1, "ui.visibility", json!({ "visible": false })).await;
        call(&mut ws, 2, "ui.visibility", json!({ "visible": true })).await;
        desk.emit("needsYou", needs_you("s1", "A"));
        assert_eq!(alerts_within(&mut events, QUIET).await.len(), 1);
        // A few pings' worth.
        tokio::time::sleep(Duration::from_millis(500)).await;
    });
    let methods = desk.methods();
    assert!(!methods.iter().any(|m| m == "ui.visibility"), "{methods:?}");
    // Pairing, then only hello: once, or again after a link that a late pong dropped under load.
    assert_eq!(methods[..2], ["pair.proof", "pair.claim"]);
    assert!(
        methods.len() >= 3 && methods[2..].iter().all(|m| m == "hello"),
        "{methods:?}"
    );
    core.stop();
}

#[test]
fn a_refused_device_says_pair_again_and_stops() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let revoked = FakeMachine::start(Behaviour {
        device_close: Some(4403),
        ..Behaviour::default()
    });
    let mut events = core.events();
    block_on(async {
        pair(&core, &revoked).await;
        let failed = failures_within(&mut events, Duration::from_secs(1)).await;
        assert!(
            failed.iter().any(|r| r == "refused: pair again"),
            "{failed:?}"
        );
    });
    // One try, then no more.
    assert_eq!(revoked.device_times().len(), 1);
    core.stop();
}

#[test]
fn a_machine_on_another_protocol_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let newer = FakeMachine::start(Behaviour {
        protocol: 13,
        ..Behaviour::default()
    });
    let mut events = core.events();
    block_on(async {
        pair(&core, &newer).await;
        let failed = failures_within(&mut events, Duration::from_secs(1)).await;
        assert!(
            failed.iter().any(|r| r.contains("protocol 13")),
            "{failed:?}"
        );
        until("its link closed", || newer.devices_open() == 0).await;
        tokio::time::sleep(BACKOFF_MAX * 2).await;
    });
    assert_eq!(newer.device_times().len(), 1, "it tried again");
    core.stop();
}

/// The core's protocol rule is the protocol package's, as pinned by its fixture.
#[test]
fn the_protocol_rule_is_the_packages() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../packages/protocol/test/fixtures/protocol-range.json"
        ))
        .unwrap(),
    )
    .unwrap();
    for sample in fixture["samples"].as_array().unwrap() {
        let version = &sample["version"];
        assert_eq!(
            threadgarden_core::accepts_remote_protocol(version),
            sample["accepts"] == json!(true),
            "{version}"
        );
    }
}

/// Secrets that fail to read for a while (a Keystore not yet unlocked after a reboot).
struct Failing {
    inner: MemorySecrets,
    failures: std::sync::atomic::AtomicUsize,
}

impl Secrets for Failing {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        if self.failures.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            self.failures
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            return Err(SecretsError("locked".into()));
        }
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        self.inner.set(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        self.inner.delete(key)
    }
}

#[test]
fn a_secrets_failure_is_retried_not_given_up() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(Failing {
        inner: MemorySecrets::default(),
        failures: 0.into(),
    });
    let desk = FakeMachine::start(Behaviour::default());
    {
        let first = core_with(dir.path(), secrets.clone(), timing());
        block_on(pair(&first, &desk));
        first.stop();
    }
    // Restarted while the keystore can't be read yet (the core reads it twice before its link does).
    secrets
        .failures
        .store(4, std::sync::atomic::Ordering::SeqCst);
    let links = desk.device_times().len();
    let core = core_with(dir.path(), secrets.clone(), timing());
    block_on(until("the link opens once the secret reads", || {
        desk.device_times().len() > links
    }));
    core.stop();
}

#[test]
fn a_removed_machines_link_closes() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    block_on(async {
        pair(&core, &desk).await;
        until("the alert link is up", || desk.devices_open() == 1).await;
        let mut ws = open(&core).await;
        call(
            &mut ws,
            1,
            "machines.remove",
            json!({ "machineId": "machine-desk", "revoke": false }),
        )
        .await;
        until("the alert link closed", || desk.devices_open() == 0).await;
        let connections = desk.connections();
        tokio::time::sleep(BACKOFF_MAX * 2).await;
        assert_eq!(desk.connections(), connections, "it tried again");
    });
    assert_eq!(core.link_status().machines, 0);
    core.stop();
}

#[test]
fn disconnect_closes_every_link_and_stays_closed() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    // No machine yet: nothing to reconnect to after a reboot.
    assert!(!Core::was_connected(dir.path()));
    let first = core_with(dir.path(), secrets.clone(), timing());
    let desk = FakeMachine::start(Behaviour::default());
    let study = FakeMachine::start(Behaviour {
        machine_id: "machine-study".into(),
        ..Behaviour::default()
    });
    block_on(async {
        pair(&first, &desk).await;
        pair(&first, &study).await;
        until("both links are up", || {
            desk.devices_open() == 1 && study.devices_open() == 1
        })
        .await;
        until("both counted", || first.link_status().connected == 2).await;
        assert!(Core::was_connected(dir.path()));

        first.disconnect().unwrap();
        until("both links closed", || {
            desk.devices_open() == 0 && study.devices_open() == 0
        })
        .await;
        let status = first.link_status();
        assert!(!status.on);
        assert_eq!(status.connected, 0);
        // A network change doesn't bring them back.
        first.network_changed();
        let connections = desk.connections() + study.connections();
        tokio::time::sleep(BACKOFF_MAX * 2).await;
        assert_eq!(desk.connections() + study.connections(), connections);
    });
    first.stop();
    // After a reboot: not connected, so no links.
    assert!(!Core::was_connected(dir.path()));
    let before = std::fs::read(dir.path().join("core.json")).unwrap();
    assert!(!Core::was_connected(dir.path()));
    assert_eq!(
        std::fs::read(dir.path().join("core.json")).unwrap(),
        before,
        "reading changed the store"
    );
    let second = core_with(dir.path(), secrets, timing());
    let connections = desk.connections() + study.connections();
    std::thread::sleep(BACKOFF_MAX * 2);
    assert_eq!(desk.connections() + study.connections(), connections);
    assert!(!second.link_status().on);
    // Connected again: both come back, and it's remembered.
    second.connect().unwrap();
    block_on(until("both links are back", || {
        desk.devices_open() == 1 && study.devices_open() == 1
    }));
    assert!(Core::was_connected(dir.path()));
    second.stop();
}

#[test]
fn was_connected_reads_nothing_into_being() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!Core::was_connected(dir.path()));
    // No store was made by asking.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}
