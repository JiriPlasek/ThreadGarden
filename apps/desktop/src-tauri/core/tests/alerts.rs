//! Alert links: the core's own link to each paired machine, separate from
//! the screens' relays, so a chat that needs you (or finished) alerts with no
//! screen open. As the desktop's `notifications.ts`: the same settings, the
//! chat on screen left out, and a reconnect never a burst of old alerts.

#[path = "support/machine.rs"]
mod machine;
mod support;

use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

use machine::{Behaviour, FakeMachine};
use serde_json::{Value, json};
use support::{block_on, call, config, open};
use threadgarden_core::secrets::MemorySecrets;
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
        ..Timing::default()
    }
}

fn core(dir: &std::path::Path) -> CoreHandle {
    core_keeping(dir, Arc::new(MemorySecrets::default()))
}

/// A core with `secrets` (kept across a restart, as the Keystore file is).
fn core_keeping(dir: &std::path::Path, secrets: Arc<MemorySecrets>) -> CoreHandle {
    let config = CoreConfig {
        secrets,
        ..config(dir)
    };
    Core::spawn_with_timing(config, timing()).unwrap()
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

fn needs_you(session: &str, title: &str) -> Value {
    json!({ "sessionId": session, "title": title, "projectName": "garden", "what": "needs permission" })
}

fn finished(session: &str, title: &str) -> Value {
    json!({ "sessionId": session, "title": title, "projectName": "garden" })
}

const QUIET: Duration = Duration::from_millis(300);

#[test]
fn an_event_alerts_once() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        until("the alert link is up", || desk.devices_open() == 1).await;
        until("it caught up", || {
            desk.methods().contains(&"sessions.list".to_string())
        })
        .await;
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
        // The same need again (still waiting): no second alert.
        desk.emit("needsYou", needs_you("s1", "Fix the build"));
        assert_eq!(alerts_within(&mut events, QUIET).await, []);
        // Answered, then a new question: that one alerts.
        desk.emit(
            "chat.status",
            json!({ "sessionId": "s1", "seq": 3, "status": "working" }),
        );
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
fn alerts_follow_the_notification_settings() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        until("it caught up", || {
            desk.methods().contains(&"sessions.list".to_string())
        })
        .await;
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
        until("it caught up", || {
            desk.methods().contains(&"sessions.list".to_string())
        })
        .await;
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
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    // Waiting already when the link comes up (they show as unread in the screens).
    desk.set_sessions(vec![
        json!({ "sessionId": "s1", "status": "needsYou" }),
        json!({ "sessionId": "s2", "status": "idle" }),
    ]);
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        until("it caught up", || {
            desk.methods()
                .iter()
                .filter(|m| *m == "sessions.list")
                .count()
                == 1
        })
        .await;
        assert_eq!(alerts_within(&mut events, QUIET).await, []);
        // Off and back (the phone moved from Wi-Fi to mobile data).
        core.network_changed();
        until("it caught up again", || {
            desk.methods()
                .iter()
                .filter(|m| *m == "sessions.list")
                .count()
                == 2
        })
        .await;
        until("the link is back", || desk.devices_open() == 1).await;
        assert_eq!(alerts_within(&mut events, QUIET).await, []);
        // An event for a chat that was already waiting doesn't alert; a new one does.
        desk.emit("needsYou", needs_you("s1", "Already waiting"));
        desk.emit("needsYou", needs_you("s3", "New"));
        assert_eq!(
            alerts_within(&mut events, QUIET).await,
            [("s3".into(), "New".into(), AlertKind::NeedsYou)]
        );
    });
    // Caught up with Needs you, as the desktop reads it.
    let asked: Vec<Value> = desk
        .frames()
        .iter()
        .filter_map(|f| serde_json::from_str::<Value>(f).ok())
        .filter(|v| v["method"] == "sessions.list")
        .collect();
    assert_eq!(asked[0]["params"]["place"], json!({ "kind": "needsYou" }));
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
        until("it caught up", || {
            desk.methods().contains(&"sessions.list".to_string())
        })
        .await;
        let before = std::fs::read(dir.path().join("core.json")).unwrap();
        let text = "a long line of streamed output ".repeat(2000);
        for seq in 0..50 {
            desk.emit("chat.items", json!({ "sessionId": "s1", "seq": seq, "items": [{ "kind": "assistant", "text": text }] }));
        }
        desk.emit(
            "chat.tasks",
            json!({ "sessionId": "s1", "seq": 51, "tasks": [] }),
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
        let gaps: Vec<Duration> = times.windows(2).map(|w| w[1] - w[0]).collect();
        // 60, 120, 240, 480, 480 ms: doubling, capped (a little slack for the attempts themselves).
        for (i, gap) in gaps.iter().take(5).enumerate() {
            let want = (BACKOFF_START * 2u32.pow(i as u32)).min(BACKOFF_MAX);
            assert!(
                *gap >= want.mul_f32(0.8) && *gap <= want + Duration::from_millis(150),
                "gap {i}: {gap:?}, wanted {want:?} ({gaps:?})"
            );
        }
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
}

#[test]
fn a_link_never_sends_ui_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let core = core(dir.path());
    let desk = FakeMachine::start(Behaviour::default());
    let mut events = core.events();
    block_on(async {
        pair(&core, &desk).await;
        until("it caught up", || {
            desk.methods().contains(&"sessions.list".to_string())
        })
        .await;
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
    assert_eq!(
        methods,
        ["pair.proof", "pair.claim", "hello", "sessions.list"]
    );
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
    let first = core_keeping(dir.path(), secrets.clone());
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

        first.disconnect();
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
    let second = core_keeping(dir.path(), secrets);
    let connections = desk.connections() + study.connections();
    std::thread::sleep(BACKOFF_MAX * 2);
    assert_eq!(desk.connections() + study.connections(), connections);
    assert!(!second.link_status().on);
    // Connected again: both come back, and it's remembered.
    second.connect();
    block_on(until("both links are back", || {
        desk.devices_open() == 1 && study.devices_open() == 1
    }));
    assert!(Core::was_connected(dir.path()));
    second.stop();
}
